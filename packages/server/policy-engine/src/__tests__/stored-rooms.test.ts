/**
 * Rooms earlier builds stored, run on this one.
 *
 * A room's policy freezes at placement and its state is whatever the engine of the day wrote, and a
 * store hands both back as it wrote them, without validating either. So nothing but these tests notices when an engine
 * change stops running a room that is already out there: a ceiling lowered under a stored `max`, a
 * formula operator that means something new, a legacy reader removed, a phase gate or a close rule
 * that reads state an older engine never wrote.
 *
 * Each file in `stored/` is a whole room, saved from the builders AND the engine of the commit its
 * `$fixture` names, after the op sequence its `story` tells (see `stored/README.md`). The actors are
 * fixed recovery phrases, so a test can sign as the members the room already knows. Each test loads a
 * room the way a database read does and plays it forward. Add a file when the stored shape changes;
 * never rewrite one.
 *
 * `shipped-policies.test.ts` is the other half: today's policies, placed fresh.
 */
import {
  signOpWithWallet,
  verifyRoomProvenance,
  verifyItemProvenance,
  walletFromMnemonic,
  walletMinter,
  type Wallet,
} from "@beaconsgg/identity";
import {
  opaqueItemSchema,
  parseGlobalId,
  roomSchema,
  TRANSITION_HORIZON_SEC,
  type OpaqueItem,
  type Room,
} from "@beaconsgg/protocol-types";
import { describe, expect, it } from "vitest";
import {
  assertValidPolicyRules,
  getGranted,
  getReactions,
  grantedPools,
  grantRulesOf,
  nextTransitionAt,
  nowSeconds,
  PolicyEngine,
  recomputeDerived,
} from "../index";
import { grantedOf, InMemoryStore, nonce, token, TEST_GAME } from "../testing";
import capsuleClaiming from "./stored/kites-capsule.2026-08-18.claiming.json";
import capsuleLocked from "./stored/kites-capsule.2026-09-14.locked.json";
import stage3Lost from "./stored/kites-challenge.2026-08-17.lost.json";
import stage3Won from "./stored/kites-challenge.2026-08-17.won.json";
import ladderClaiming from "./stored/kites-challenge.2026-08-18.claiming.json";
import challengeRunning from "./stored/kites-challenge.2026-08-25.running.json";
import challengeSettled from "./stored/kites-challenge.2026-09-14.settled.json";
import challengeWon from "./stored/kites-challenge.2026-09-23.won.json";
import jar from "./stored/kites-jar.2026-08-18.json";

/** The recovery phrases the fixtures were generated with (BIP39's published test phrases). */
const MNEMONICS = {
  alice:
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  bob: "legal winner thank year wave sausage worth useful legal winner thank yellow",
  carol: "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
} as const;
type Actor = keyof typeof MNEMONICS;

interface StoredFixture {
  $fixture: { commit: string; story: string; actors: Record<Actor, string>; clock: string };
  room: unknown;
}

const STORED: Record<string, StoredFixture> = {
  "kites-challenge.2026-08-17.won": stage3Won,
  "kites-challenge.2026-08-17.lost": stage3Lost,
  "kites-challenge.2026-08-18.claiming": ladderClaiming,
  "kites-capsule.2026-08-18.claiming": capsuleClaiming,
  "kites-jar.2026-08-18": jar,
  "kites-challenge.2026-08-25.running": challengeRunning,
  "kites-capsule.2026-09-14.locked": capsuleLocked,
  "kites-challenge.2026-09-14.settled": challengeSettled,
  "kites-challenge.2026-09-23.won": challengeWon,
};

const DAY = 86_400;
const WALLETS = Object.fromEntries(
  Object.entries(MNEMONICS).map(([name, phrase]) => [name, walletFromMnemonic(phrase)]),
) as Record<Actor, Wallet>;
const did = (who: Actor) => WALLETS[who].account.did;

const roomOf = (fixture: StoredFixture): Room => fixture.room as Room;
const uniques = (items: OpaqueItem[]): string[] => items.map((it) => it.unique).sort();
const poolOf = (fixture: StoredFixture, key: string): string[] =>
  uniques(roomOf(fixture).state[key] as OpaqueItem[]);

/**
 * The key order a Postgres `jsonb` read hands back (shorter keys first, then bytewise), at every
 * depth, so a room loads here as it does from the store that deploys. Lengths and comparisons are
 * UTF-16 rather than bytes, which agree for the ASCII keys rooms carry.
 */
function jsonbOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonbOrder);
  if (value === null || typeof value !== "object") return value;
  const keys = Object.keys(value).sort(
    (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0),
  );
  return Object.fromEntries(
    keys.map((k) => [k, jsonbOrder((value as Record<string, unknown>)[k])]),
  );
}

/**
 * A stored room as the one-off game-stamping update leaves it (doc/deploy.md): every fixture is
 * from before game slugs, and the update stamps the room's game in place without touching anything
 * else, its signed policy and items included. Stamped here the same way, so each story plays on as
 * the room's own game.
 */
const stamped = (room: Room): Room => ({ ...room, game: TEST_GAME });

/** Load a stored room as a Postgres read would, with the engine's clock at the fixture's. */
async function load(fixture: StoredFixture, stamp: (room: Room) => Room = stamped) {
  const store = new InMemoryStore();
  const stored = jsonbOrder(stamp(roomOf(fixture))) as Room;
  await store.commit([{ kind: "putRoom", room: stored }]);
  const clock = { ms: Date.parse(fixture.$fixture.clock) };
  const engine = new PolicyEngine(store, {
    now: () => clock.ms,
    replayWindowMs: Number.MAX_SAFE_INTEGER,
  });
  const id = stored.id;
  const run = async (who: Actor, op: string, params: Record<string, unknown> = {}) =>
    (
      await engine.applyOp(
        signOpWithWallet(WALLETS[who], {
          game: TEST_GAME,
          op,
          room: id,
          nonce: nonce(),
          issuedAt: new Date(clock.ms).toISOString(),
          params,
        }),
      )
    ).result;
  return {
    clock,
    run,
    room: () => engine.resolveRoom(id),
    tick: () => engine.advancePhase(id),
    /** When the lifecycle tick next has work for this room, as the server schedules it. */
    due: async () => nextTransitionAt((await engine.resolveRoom(id))!, nowSeconds(clock.ms)),
  };
}

/** A challenge progress claim, signed by the player reporting it. */
const progress = (who: Actor, unique: string, levels: Record<string, number>) =>
  token(unique, levels, { cls: "ChallengeProgress", minter: walletMinter(WALLETS[who]) });

describe("every stored room is still one this build can hold", () => {
  const cases = Object.entries(STORED);

  it("was generated with the recovery phrases this suite signs with", () => {
    // Otherwise a changed derivation would surface below as a puzzling `denied`.
    for (const fixture of Object.values(STORED)) {
      for (const who of Object.keys(MNEMONICS) as Actor[]) {
        expect(fixture.$fixture.actors[who]).toBe(did(who));
      }
    }
  });

  it.each(cases)(
    "%s: still a Room, and a policy this build would place today",
    (_name, fixture) => {
      // Neither runs on a stored room's path; they are the tripwire. A failure means rooms this build
      // would refuse to place are already in custody, so the change needs a legacy reader, not a fix here.
      expect(roomSchema.safeParse(fixture.room).success).toBe(true);
      expect(() => assertValidPolicyRules(roomOf(fixture).policy)).not.toThrow();
    },
  );

  it.each(cases)("%s: its formulas still give the values it stored", (_name, fixture) => {
    // A formula operator that throws is caught anywhere; one that quietly means something new is
    // caught only here, against numbers an older engine computed and wrote down.
    const room = roomOf(fixture);
    const recomputed = recomputeDerived(room.policy, room.state);
    for (const key of Object.keys(room.policy.derived ?? {})) {
      expect(recomputed[key]).toBe(room.state[key]);
    }
  });

  it.each(cases)("%s: its container and every item in it still verify", (_name, fixture) => {
    const room = roomOf(fixture);
    expect(
      verifyRoomProvenance(
        { unique: parseGlobalId(room.id).unique, kind: room.type, policy: room.policy },
        room.mintedBy,
      ),
    ).toBe(true);
    const pools = grantRulesOf(room.policy).map((rule) => rule.from);
    for (const key of ["contents", ...pools]) {
      for (const raw of room.state[key] as unknown[]) {
        const item = opaqueItemSchema.parse(raw);
        expect(
          verifyItemProvenance({ unique: item.unique, birth: item.birth }, item.mintedBy),
        ).toBe(true);
      }
    }
  });
});

describe("kites-challenge.2026-08-17: epoch 0a, an early challenge (active, ended, won)", () => {
  it("won: Bob cannot claim twice; Alice's claim pays her a reward of her own and closes the room", async () => {
    const r = await load(stage3Won);
    const bobsReward = (getGranted(roomOf(stage3Won).state)[did("bob")] as string[])[0];
    expect(await r.run("bob", "claim")).toMatchObject({ ok: false, error: "gone" });

    const granted = grantedOf(await r.run("alice", "claim"));
    expect(granted).toHaveLength(1);
    expect(granted[0]!.unique).not.toBe(bobsReward);
    expect(await r.room()).toBeUndefined(); // every member has claimed
  });

  it("lost: stranded in `ended` behind a `won` decades out, it closes a claim window after its deadline", async () => {
    // Stage 3 wrote "never" as a transition decades away. The engine reads anything past the horizon
    // as never, and `ended` pays nobody, so the room closes `claimTtl` after it entered `ended`.
    const r = await load(stage3Lost);
    const state = roomOf(stage3Lost).state;
    expect(state["unlockAt"] as number).toBeGreaterThan(
      (state["placedAt"] as number) + TRANSITION_HORIZON_SEC,
    );
    expect(await r.run("alice", "claim")).toMatchObject({ ok: false, error: "phase" });
    expect(
      await r.run("bob", "contribute", {
        item: progress("bob", "late", { "capsule.finished": 1 }),
      }),
    ).toMatchObject({ ok: false, error: "phase" });

    const closesAt = (state["deadlineAt"] as number) + 7 * DAY;
    expect(await r.due()).toBe(closesAt);
    r.clock.ms = (closesAt - 1) * 1000;
    expect((await r.tick()).closed).toBe(false);
    r.clock.ms = closesAt * 1000;
    expect((await r.tick()).closed).toBe(true);
  });
});

describe("kites-challenge.2026-08-18.claiming: epoch 0b, a claim-paid ladder", () => {
  it("pays Bob only the rung the team reached, on his one claim, which closes the room", async () => {
    const r = await load(ladderClaiming);
    const unlockAt = roomOf(ladderClaiming).state["unlockAt"] as number;
    expect(await r.due()).toBe(unlockAt + 7 * DAY); // stored before `settledAt`

    const granted = grantedOf(await r.run("bob", "claim"));
    expect(granted).toHaveLength(1);
    expect(poolOf(ladderClaiming, "rewards1")).toContain(granted[0]!.unique);
    expect(await r.room()).toBeUndefined();
  });
});

describe("kites-capsule.2026-08-18.claiming: one grant rule, a flat `granted`, no `settledAt`", () => {
  const stored = roomOf(capsuleClaiming);

  it("reads its flat `granted` entry as a draw from the one rule's pool", () => {
    const aliceEntry = getGranted(stored.state)[did("alice")];
    expect(Array.isArray(aliceEntry)).toBe(true); // the legacy shape, as that engine wrote it
    // Nothing a claim-paid capsule does reaches this reader (a second claim is refused before any
    // grant runs), so it is pinned directly.
    expect(grantedPools(aliceEntry, "rewards")).toEqual({ rewards: aliceEntry });
  });

  it("refuses Alice again and Carol at all; Bob gets his memory and an unowned reward, and the room closes", async () => {
    const r = await load(capsuleClaiming);
    expect(await r.run("alice", "claim")).toMatchObject({ ok: false, error: "gone" });
    expect(await r.run("carol", "claim")).toMatchObject({ ok: false, error: "denied" });

    const claimed = await r.run("bob", "claim");
    const granted = grantedOf(claimed);
    expect(uniques((claimed as { result: { items: OpaqueItem[] } }).result.items)).toEqual(
      (stored.state["contributors"] as Record<string, string[]>)[did("bob")],
    );
    expect(granted).toHaveLength(1);
    expect(granted[0]!.owner).toBe(did("bob"));
    expect(await r.room()).toBeUndefined(); // every contributor has claimed
  });

  it("with no `settledAt`, its 7-day claim window still runs from `unlockAt`", async () => {
    const r = await load(capsuleClaiming);
    const closesAt = (stored.state["unlockAt"] as number) + 7 * DAY;
    expect(await r.due()).toBe(closesAt);

    r.clock.ms = (closesAt - 1) * 1000;
    expect((await r.tick()).closed).toBe(false);
    r.clock.ms = closesAt * 1000;
    expect((await r.tick()).closed).toBe(true);
  });
});

describe("kites-jar.2026-08-18", () => {
  it("unstamped, as it was stored, takes no game's op until the update stamps it", async () => {
    const r = await load(jar, (room) => room);
    expect(await r.run("carol", "list")).toMatchObject({ ok: false, error: "gameNotAccepted" });
  });

  it("lists the memory left in it, takes an add, and closes when emptied", async () => {
    const r = await load(jar);
    const left = poolOf(jar, "contents");
    expect(left).toHaveLength(1);

    const listed = await r.run("carol", "list");
    expect(uniques((listed as { result: { contents: OpaqueItem[] } }).result.contents)).toEqual(
      left,
    );
    expect(await r.run("carol", "add", { item: token("c1") })).toMatchObject({ ok: true });
    expect(await r.run("bob", "take", { item: left[0] })).toMatchObject({ ok: true });
    expect(await r.run("bob", "take", { item: "c1" })).toMatchObject({ ok: true });
    expect(await r.room()).toBeUndefined();
  });
});

describe("kites-challenge.2026-08-25.running: several grant rules, placed before reactions", () => {
  it("refuses `react`, which its frozen policy never had", async () => {
    const r = await load(challengeRunning);
    expect(await r.run("bob", "react", { target: did("alice"), kind: "love" })).toMatchObject({
      ok: false,
      error: "denied",
    });
  });

  it("has no spot for a third member", async () => {
    const r = await load(challengeRunning);
    expect(
      await r.run("carol", "contribute", { item: progress("carol", "carolj", {}) }),
    ).toMatchObject({ ok: false, error: "full" });
  });

  it("pays each rung once per member from its own pool, a scanner included, settles when won, then closes", async () => {
    const r = await load(challengeRunning);

    // Alice already drew step 1, and step 2 is short: nothing more for her yet.
    expect(grantedOf(await r.run("alice", "collect"))).toEqual([]);

    // Bob's two more jars finish step 2, which wins the ladder.
    expect(
      await r.run("bob", "contribute", {
        item: progress("bob", "bobstep2", { "s2:jar.placed": 2 }),
      }),
    ).toMatchObject({ ok: true });

    const bobs = grantedOf(await r.run("bob", "collect"));
    expect(bobs).toHaveLength(2);
    // Step 2's pool holds a scanner, an item signed as an item rather than a memory; it pays the same.
    expect(
      uniques(bobs).filter((u) => poolOf(challengeRunning, "rewards2").includes(u)),
    ).toHaveLength(1);
    // The per-pool ledger at work: Alice drew from rewards1 before, so she gets step 2 only.
    const alices = grantedOf(await r.run("alice", "collect"));
    expect(alices).toHaveLength(1);
    expect(poolOf(challengeRunning, "rewards2")).toContain(alices[0]!.unique);

    // A won ladder settles on the next tick, and the one after closes it: nothing is owed.
    const settled = await r.tick();
    expect(settled.room?.state["phase"]).toBe("settled");
    expect(settled.room?.state["settledAt"]).toBe(nowSeconds(r.clock.ms));
    expect((await r.tick()).closed).toBe(true);
  });
});

describe("kites-capsule.2026-09-14.locked: a reaction ledger, sealed", () => {
  const stored = roomOf(capsuleLocked);

  it("holds its phase gates while locked", async () => {
    const r = await load(capsuleLocked);
    expect(await r.run("carol", "contribute", { item: token("late") })).toMatchObject({
      ok: false,
      error: "phase",
    });
    expect(await r.run("alice", "claim")).toMatchObject({ ok: false, error: "phase" });
  });

  it("keeps its stored reactions: a repeat is a no-op, a second kind is refused, a stranger is denied", async () => {
    const r = await load(capsuleLocked);
    const mine = getReactions(stored.state).find((x) => x.by === did("alice"))!;

    const repeat = await r.run("alice", "react", { target: mine.target, kind: mine.kind });
    expect(repeat).toMatchObject({ ok: true, version: stored.version }); // no write, no bump
    expect(await r.run("alice", "react", { target: mine.target, kind: "wow" })).toMatchObject({
      ok: false,
      error: "full",
    });
    expect(await r.run("carol", "react", { target: mine.target, kind: "love" })).toMatchObject({
      ok: false,
      error: "denied",
    });
    expect(getReactions((await r.room())!.state)).toEqual(getReactions(stored.state));
  });

  it("appends a new reaction to the stored ledger, and refuses one at something it does not hold", async () => {
    const r = await load(capsuleLocked);
    expect(await r.run("alice", "react", { target: did("bob"), kind: "love" })).toMatchObject({
      ok: true,
      version: stored.version + 1,
    });
    expect(await r.run("alice", "react", { target: "nothere", kind: "love" })).toMatchObject({
      ok: false,
      error: "gone",
    });
    const ledger = getReactions((await r.room())!.state);
    expect(ledger).toHaveLength(3);
    expect(ledger.slice(0, 2)).toEqual(getReactions(stored.state));
  });

  it("opens, stamps `settledAt`, and closes once both contributors claim", async () => {
    const r = await load(capsuleLocked);
    r.clock.ms = (stored.state["unlockAt"] as number) * 1000 + 30_000;
    const opened = await r.tick();
    expect(opened.room?.state["phase"]).toBe("unlocked");
    const settledAt = nowSeconds(r.clock.ms);
    expect(opened.room?.state["settledAt"]).toBe(settledAt);
    expect(await r.due()).toBe(settledAt + 7 * DAY);

    expect(grantedOf(await r.run("alice", "claim"))).toHaveLength(1);
    expect(grantedOf(await r.run("bob", "claim"))).toHaveLength(1);
    expect(await r.room()).toBeUndefined();
  });
});

describe("kites-challenge.2026-09-14.settled: past its deadline with a rung unfinished", () => {
  it("takes no more progress", async () => {
    const r = await load(challengeSettled);
    const late = progress("carol", "late", { "s2:jar.placed": 1 });
    expect(await r.run("carol", "contribute", { item: late })).toMatchObject({
      ok: false,
      error: "phase",
    });
  });

  it("owes only the landed rung: once Carol collects it, the next tick closes the room", async () => {
    const r = await load(challengeSettled);
    const settledAt = roomOf(challengeSettled).state["settledAt"] as number;
    expect(await r.due()).toBe(settledAt + 7 * DAY);

    const carols = grantedOf(await r.run("carol", "collect"));
    expect(carols.map((it) => it.owner)).toEqual([did("carol")]);
    expect(poolOf(challengeSettled, "rewards1")).toContain(carols[0]!.unique);
    expect((await r.tick()).closed).toBe(true);
  });
});

describe("kites-challenge.2026-09-23.won: settled early, a 30-day window", () => {
  const stored = roomOf(challengeWon);

  it("schedules its close from `settledAt`, not the collapsed `unlockAt`", async () => {
    const r = await load(challengeWon);
    expect(stored.state["unlockAt"]).toBe(stored.state["placedAt"]); // how a won ladder settles
    expect(await r.due()).toBe((stored.state["settledAt"] as number) + 30 * DAY);
  });

  it("pays Bob both rungs, nothing more to Alice, and then closes", async () => {
    const r = await load(challengeWon);
    expect(grantedOf(await r.run("bob", "collect"))).toHaveLength(2);
    expect(grantedOf(await r.run("alice", "collect"))).toEqual([]);
    expect((await r.tick()).closed).toBe(true);
  });
});
