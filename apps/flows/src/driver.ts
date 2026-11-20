/**
 * The five core flows, driven through the client SDK against a running server, the way a game
 * client does it: a place, a contribute, a claim, a profile publish and a live update. Unit tests
 * prove each seam over fakes; this proves them over the wire, and it is what the skew matrix runs
 * with the SDK at one core version against a server at another (beacon.core's
 * `doc/core-compatibility.md` §6).
 *
 * Game-neutral by design: the room is a timed pot whose policy is written here, not a game's
 * (`timedPotPolicy` in the policy engine's testing module is its model), and the contributed item is
 * a signed opaque item with a made-up birth. The server evaluates both without knowing a game, so
 * nothing here needs a game package, and the driver installs from the registry alone.
 *
 * Every flow is reported, not thrown: a run returns one {@link FlowReport} per flow, so a failed
 * claim still says what the place and the contribute did. That holds for a server that refuses, a
 * server that faults (a 5xx, which the SDK throws), a server whose answer this SDK misreads, and a
 * socket that never connects: each becomes that flow's `FAIL` with what happened, and the run goes
 * on to the flows that can still say something. The one thing that throws is the server's descriptor
 * failing to verify (or the server not being there): with no server there is no flow to report.
 */
import { createClient, type LiveConnect, type WireFetch } from "@beaconsgg/client-sdk";
import { liveCell } from "@beaconsgg/geo";
import {
  buildProfile,
  createWallet,
  signRoomProvenance,
  signItemProvenance,
  verifyProfile,
  walletMinter,
  type Wallet,
} from "@beaconsgg/identity";
import type { MapDelta, OpaqueItem, Policy } from "@beaconsgg/protocol-types";
import { ulid } from "ulid";

export const FLOWS = ["place", "contribute", "claim", "profile", "live"] as const;
export type Flow = (typeof FLOWS)[number];

export interface FlowReport {
  flow: Flow;
  ok: boolean;
  /** What happened, in one line: the ids and versions on success, the refusal, fault or timeout otherwise. */
  detail: string;
}

export interface FlowsOptions {
  /** The server's origin, `http://host:port`. */
  server: string;
  /** socket.io-client's `io`, or anything that opens a {@link LiveConnect} socket. */
  connect: LiveConnect;
  /** Defaults to the global fetch. */
  fetch?: WireFetch;
  /**
   * Seconds from placement to the pot locking; the contribute must land inside this window, and the
   * claim waits for it plus the unlock. Default 4. The window the contribute really gets is between
   * one second less and the full value: the server stamps `placedAt` in whole seconds, so a place
   * late in a second locks that much sooner. A loaded machine can take over a second between the
   * place's answer and the contribute's arrival, and a contribute after the lock is a `phase`
   * refusal that says nothing about the wire.
   */
  lockDelaySec?: number;
  /** Seconds from lock to the pot opening for claims. Default 1. */
  unlockDelaySec?: number;
  /** How long any one awaited event (a socket connect, a map delta, a claim window) may take. Default 15 s. */
  waitMs?: number;
  /** Where the pot goes. Any point; the live cell is derived from it. */
  location?: { lat: number; lng: number };
  /** The player who places the pot and publishes a profile. A fresh wallet by default. */
  placer?: Wallet;
  /** The player who contributes and claims. A fresh wallet by default. */
  contributor?: Wallet;
  log?: (line: string) => void;
}

/** The display name the placer publishes, and expects to read back. */
export const PROFILE_NAME = "flows";

const DEFAULT_LOCATION = { lat: 47.61, lng: -122.34 };
const DEFAULT_LOCK_DELAY_SEC = 4;
const DEFAULT_UNLOCK_DELAY_SEC = 1;
const DEFAULT_WAIT_MS = 15_000;
/** How long after the computed open time the claim is first tried, and how often it is retried. */
const CLAIM_SLACK_MS = 500;

/**
 * A timed pot: public contributions while filling, then locked, then open for each contributor to
 * claim; closes once every contributor has claimed (`onEmpty` after claim, by the engine's rule). The
 * windows are plain delays off `placedAt`, no per-item shifts, so the open time is known at placement.
 */
export function flowsPolicy(lockDelaySec: number, unlockDelaySec: number): Policy {
  return {
    type: "pot",
    ops: {
      contribute: { role: "public", phase: "filling" },
      claim: { role: "contributor", phase: "open" },
    },
    lifecycle: {
      phases: ["filling", "locked", "open"],
      transitions: { locked: "lockAt", open: "unlockAt" },
    },
    derived: {
      lockAt: { "+": [{ var: "placedAt" }, lockDelaySec] },
      unlockAt: { "+": [{ var: "lockAt" }, unlockDelaySec] },
    },
    onEmpty: "close",
    claimTtl: "1d",
  };
}

/** A signed opaque item minted by `wallet`, with a birth the server treats as opaque. */
export function mintItem(wallet: Wallet, note: string): OpaqueItem {
  const unique = ulid();
  const birth = { kind: "note", note };
  return { unique, birth, mintedBy: signItemProvenance({ unique, birth }, walletMinter(wallet)) };
}

/** An awaited event that did not come in time. Its message is the report; nothing was thrown at us. */
class DeadlineError extends Error {}

/** Rejects after `ms` with `what`, so a hung await names the step it hung on. */
function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new DeadlineError(`timed out after ${ms} ms waiting for ${what}`)),
      ms,
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A refused op, as one line: its error code and the message, if the server gave one. */
function refusal(res: { error?: string | undefined; message?: string | undefined }): string {
  const error = res.error ?? "refused";
  return res.message ? `${error}: ${res.message}` : error;
}

/** What a flow's own code threw, as one line: a deadline reads as itself, anything else as a throw. */
function thrown(err: unknown): string {
  if (err instanceof DeadlineError) return err.message;
  return err instanceof Error ? `threw ${err.name}: ${err.message}` : `threw ${String(err)}`;
}

/** What a delta says about a room, for the log and the match. */
function deltaRoomId(delta: MapDelta): string | undefined {
  if (delta.kind === "room") return delta.room.id;
  if (delta.kind === "roomGone") return delta.id;
  return undefined;
}

/**
 * The slug the driver plays as. Every game write names its game (`doc/spec/room-operation.md` §5),
 * and the driver is no real game, so it names itself: a server running it must admit every game or
 * list this one.
 */
export const FLOWS_GAME = "beacon-flows";

export async function runFlows(opts: FlowsOptions): Promise<FlowReport[]> {
  const server = opts.server.replace(/\/+$/, "");
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const lockDelaySec = opts.lockDelaySec ?? DEFAULT_LOCK_DELAY_SEC;
  const unlockDelaySec = opts.unlockDelaySec ?? DEFAULT_UNLOCK_DELAY_SEC;
  const location = opts.location ?? DEFAULT_LOCATION;
  const log = opts.log ?? (() => {});
  const client = createClient({
    connect: opts.connect,
    game: FLOWS_GAME,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  // Two players: one places, the other contributes and claims. The placer also publishes a profile.
  const placer = opts.placer ?? createWallet();
  const contributor = opts.contributor ?? createWallet();

  // The server first: its signed descriptor must verify, or nothing below means anything. The one throw.
  const entry = await client.verifyServer(server);
  log(
    `server ${entry.origin} verified: host ${entry.descriptor.host}, key ${entry.descriptor.key}`,
  );

  const reports: FlowReport[] = [];
  const report = (flow: Flow, ok: boolean, detail: string): void => {
    reports.push({ flow, ok, detail });
    log(`${ok ? "ok  " : "FAIL"} ${flow}: ${detail}`);
  };
  /** Runs one flow; whatever it throws before reporting becomes its report, and the run goes on. */
  const attempt = async (flow: Flow, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (err) {
      if (!reports.some((r) => r.flow === flow)) report(flow, false, thrown(err));
    }
  };

  // The live channel opens before the place, so the place's own delta is the first thing it sees.
  const cell = liveCell(location);
  const deltas: MapDelta[] = [];
  const waiters: { test: (delta: MapDelta) => boolean; resolve: () => void }[] = [];
  const socket = client.subscribeMap(
    server,
    () => [cell],
    (delta) => {
      deltas.push(delta);
      log(`map delta: ${delta.kind} ${deltaRoomId(delta) ?? ""} in ${delta.cell}`);
      for (const waiter of waiters.splice(0)) {
        if (waiter.test(delta)) waiter.resolve();
        else waiters.push(waiter);
      }
    },
  );
  const nextDelta = (test: (delta: MapDelta) => boolean, what: string): Promise<void> =>
    withDeadline(
      new Promise<void>((resolve) => {
        if (deltas.some(test)) resolve();
        else waiters.push({ test, resolve });
      }),
      waitMs,
      what,
    );

  // What the later flows need from the earlier ones.
  const pot: { id?: string; placedAtSec: number; placedAtMs: number; claimed: boolean } = {
    placedAtSec: 0,
    placedAtMs: 0,
    claimed: false,
  };
  /** A socket that never came up is the live flow's failure, not the run's: the REST flows go on. */
  let socketDown: string | undefined;

  try {
    try {
      await withDeadline(
        new Promise<void>((resolve) => {
          if (socket.connected) resolve();
          else socket.on("connect", () => resolve());
        }),
        waitMs,
        "the map socket to connect",
      );
      log(`map socket connected, watching cell ${cell}`);
    } catch (err) {
      socketDown = thrown(err);
      log(`map socket: ${socketDown}`);
    }

    // 1. Place: a signed `place` op carrying the pot's policy and the placer's room provenance.
    await attempt("place", async () => {
      const policy = flowsPolicy(lockDelaySec, unlockDelaySec);
      const unique = ulid();
      const placed = await client.placeRoom(server, placer, {
        type: "pot",
        unique,
        mintedBy: signRoomProvenance({ unique, kind: "pot", policy }, walletMinter(placer)),
        location,
        policy,
        name: "flows pot",
      });
      if (!placed.ok) return report("place", false, refusal(placed));
      if (!placed.id) {
        return report("place", false, `answered ok without a room id: ${JSON.stringify(placed)}`);
      }
      pot.id = placed.id;
      pot.placedAtMs = Date.now();
      const stamped = placed.room?.state["placedAt"];
      pot.placedAtSec = typeof stamped === "number" ? stamped : Math.floor(pot.placedAtMs / 1000);
      report("place", true, `room ${placed.id} version ${placed.version ?? "?"}`);
    });

    const roomId = pot.id;
    if (!roomId) {
      for (const flow of ["contribute", "claim", "live"] as const) {
        report(flow, false, "no room: the place failed");
      }
    } else {
      // 2. Contribute: the other player's signed item, accepted while the pot is filling. The time
      //    since the place is reported with the answer: a `phase` refusal here means the lock came
      //    first, which is the window, not the wire.
      const item = mintItem(contributor, "a memory for the pot");
      await attempt("contribute", async () => {
        const res = await client.sendOpWithRetry(server, contributor, roomId, "contribute", {
          item,
        });
        const sincePlace = `${Date.now() - pot.placedAtMs} ms after the place`;
        if (!res.ok) return report("contribute", false, `${refusal(res)} (${sincePlace})`);
        const returned = (res.result as { contributed?: unknown } | undefined)?.contributed;
        if (returned !== item.unique) {
          return report(
            "contribute",
            false,
            `answered ok without the item's unique: ${JSON.stringify(res.result ?? null)}`,
          );
        }
        // The answer is the op's; the room read back is what another client would see.
        const room = await client.resolveRoom(server, roomId);
        const contents = (room?.state["contents"] ?? []) as OpaqueItem[];
        const held = contents.find((it) => it.unique === item.unique);
        if (!held) {
          return report("contribute", false, `the room read back does not hold ${item.unique}`);
        }
        if (held.owner !== contributor.account.did) {
          return report(
            "contribute",
            false,
            `the room holds ${item.unique} for ${String(held.owner)}, not its contributor`,
          );
        }
        report(
          "contribute",
          true,
          `item ${item.unique} held by its contributor, version ${res.version} (${sincePlace})`,
        );
      });

      // 3. Claim: once the pot has opened. The phase gate reads the clock, so the first try goes
      //    just after the computed open time; a refusal is retried for the wait, since the server's
      //    clock and this one need not agree to the millisecond. A pot that opens later than the
      //    wait allows is tried anyway, so the refusal is reported. A fault is not retried: the SDK
      //    already retried it under the op's nonce, and it is the answer.
      await attempt("claim", async () => {
        const opensAtMs = (pot.placedAtSec + lockDelaySec + unlockDelaySec) * 1000 + CLAIM_SLACK_MS;
        await sleep(Math.min(waitMs, Math.max(0, opensAtMs - Date.now())));
        const deadline = Date.now() + waitMs;
        let detail = "not attempted";
        while (Date.now() < deadline) {
          const res = await client.sendOpWithRetry(server, contributor, roomId, "claim", {});
          if (res.ok) {
            const items = (res.result as { items?: OpaqueItem[] } | undefined)?.items;
            if (Array.isArray(items) && items.some((it) => it.unique === item.unique)) {
              pot.claimed = true;
              detail = `item ${item.unique} back with its contributor, version ${res.version}`;
            } else {
              detail = `answered ok without the item: ${JSON.stringify(res.result ?? null)}`;
            }
            break;
          }
          detail = refusal(res);
          await sleep(CLAIM_SLACK_MS);
        }
        report("claim", pot.claimed, detail);
      });

      // 5. Live: the place reached the map channel for the pot's cell, and so did the close that
      //    follows the only contributor's claim. Without a claim there is no close to wait for.
      await attempt("live", async () => {
        if (socketDown) return report("live", false, socketDown);
        await nextDelta(
          (d) => d.kind === "room" && d.room.id === roomId,
          `a room delta for ${roomId}`,
        );
        if (!pot.claimed) {
          return report(
            "live",
            true,
            `object for ${roomId} arrived in cell ${cell} (no close to wait for: the claim did not succeed)`,
          );
        }
        await nextDelta(
          (d) => d.kind === "roomGone" && d.id === roomId,
          `a roomGone delta for ${roomId} after the claim`,
        );
        report("live", true, `room and roomGone for ${roomId} arrived in cell ${cell}`);
      });
    }

    // 4. Profile: the placer publishes a self-signed profile, and the server hands back one that
    //    verifies, is that account's, and carries the published name. Each is its own check: a
    //    server can serve a stale copy or another account's, and neither would fail to verify.
    await attempt("profile", async () => {
      const profile = buildProfile(placer.account, {
        version: 1,
        devices: [{ did: placer.device.did, auth: placer.auth }],
        displayName: PROFILE_NAME,
      });
      const published = await client.publishProfile(server, profile);
      if (!published.ok) {
        return report("profile", false, `publish refused: ${published.error ?? "no reason given"}`);
      }
      const fetched = await client.fetchProfile(server, placer.account.did);
      if (!fetched) return report("profile", false, "published, but the read back found nothing");
      if (!verifyProfile(fetched)) {
        return report("profile", false, "the read-back profile does not verify");
      }
      if (fetched.id !== placer.account.did) {
        return report(
          "profile",
          false,
          `the read-back profile is ${fetched.id}'s, not the publisher's`,
        );
      }
      if (fetched.displayName !== PROFILE_NAME) {
        return report(
          "profile",
          false,
          `the read-back profile's name is ${JSON.stringify(fetched.displayName)}, not the published one`,
        );
      }
      report("profile", true, `${fetched.id} published and read back, version ${fetched.version}`);
    });
  } finally {
    socket.disconnect();
  }

  // One row per flow, in the fixed order, whatever order they ran in.
  return FLOWS.map(
    (flow) => reports.find((r) => r.flow === flow) ?? { flow, ok: false, detail: "not run" },
  );
}
