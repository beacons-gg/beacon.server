/**
 * The five flows against the real server: `apps/server/dist/main.js` booted on its own Postgres
 * database, driven over HTTP and a socket.io connection by the driver. This is the diagonal of the
 * skew matrix (beacon.core's `doc/core-compatibility.md` §6): the SDK and the server at the same
 * core version.
 *
 * The second half makes the server lie. A driver run only against a correct server never takes its
 * own FAIL branches, and those are what turn an off-diagonal cell red: so each row puts a `fetch`
 * or a socket between the driver and the real server that faults, or rewrites one answer, and
 * asserts that flow's FAIL, its detail, and that the other flows still reported.
 *
 * Needs BEACON_TEST_DATABASE_URL (`pnpm test:db`), like the server suite. The server gets a
 * database of its own on that Postgres, `beacon_flows`, created here if missing: the server suite
 * truncates the tables of the database it is pointed at, and runs in parallel under turbo.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import type { LiveConnect, WireFetch } from "@beaconsgg/client-sdk";
import { buildProfile, createWallet, type Wallet } from "@beaconsgg/identity";
import { Client } from "pg";
import { io } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FLOWS, runFlows, type Flow, type FlowReport, type FlowsOptions } from "../driver";
import { main } from "../main";

const FLOWS_DATABASE = "beacon_flows";

function testDatabaseUrl(): string {
  const url = process.env["BEACON_TEST_DATABASE_URL"];
  if (!url) {
    throw new Error(
      "BEACON_TEST_DATABASE_URL is not set: the flows suite boots the server on Postgres (`pnpm test:db`)",
    );
  }
  return url;
}

/** `beacon_flows` on the test Postgres, created on first use. Returns its URL. */
async function flowsDatabaseUrl(): Promise<string> {
  const admin = new URL(testDatabaseUrl());
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      FLOWS_DATABASE,
    ]);
    if (exists.rowCount === 0) await client.query(`CREATE DATABASE ${FLOWS_DATABASE}`);
  } finally {
    await client.end();
  }
  const url = new URL(admin.toString());
  url.pathname = `/${FLOWS_DATABASE}`;
  return url.toString();
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** The built server, resolved through the workspace link (it has no exports map). */
function serverMain(): string {
  const require = createRequire(__filename);
  return join(dirname(require.resolve("@beaconsgg/server-app/package.json")), "dist", "main.js");
}

async function waitForReady(origin: string, output: () => string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/health/ready`);
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the server did not become ready within ${ms} ms (${last})\n${output()}`);
}

type WireRequest = Parameters<WireFetch>[1];
type WireResponse = Awaited<ReturnType<WireFetch>>;
type Match = (url: string, init: WireRequest) => boolean;

const realFetch: WireFetch = (url, init) => fetch(url, init);
const isPost = (init: WireRequest) => init.method === "POST";
const opNamed =
  (op: string): Match =>
  (url, init) =>
    isPost(init) &&
    url.endsWith("/ops") &&
    (JSON.parse(init.body ?? "{}") as { op?: string }).op === op;
const placeCall: Match = (url, init) => isPost(init) && url.endsWith("/rooms");
const roomRead: Match = (url, init) => !isPost(init) && /\/rooms\/[^/]+$/.test(url);
const profilePublish: Match = (url, init) => isPost(init) && url.endsWith("/profiles");
const profileRead: Match = (url, init) => !isPost(init) && url.includes("/profiles/");

/** A server that faults on the matched call: a 500, without the call reaching the real one. */
const faulting =
  (match: Match): WireFetch =>
  async (url, init) =>
    match(url, init)
      ? { ok: false, status: 500, json: () => Promise.resolve({}) }
      : realFetch(url, init);

/** The real server's answer to the matched call, with its body rewritten. */
const answering =
  (match: Match, rewrite: (body: unknown) => unknown): WireFetch =>
  async (url, init) => {
    const res: WireResponse = await realFetch(url, init);
    if (!match(url, init)) return res;
    const body = rewrite(await res.json());
    return { ok: res.ok, status: res.status, json: () => Promise.resolve(body) };
  };

/** A socket that loses the events `drop` picks, and can be made to look never connected. */
const lossy =
  (drop: (event: string, payload: unknown) => boolean, neverConnects = false): LiveConnect =>
  (url, options) => {
    const socket = io(url, options);
    const wrapped: ReturnType<LiveConnect> = {
      get connected() {
        return !neverConnects && socket.connected;
      },
      on(event, listener) {
        socket.on(event, (...args: unknown[]) => {
          if (neverConnects && event === "connect") return;
          if (!drop(event, args[0])) (listener as (...a: unknown[]) => void)(...args);
        });
        return wrapped;
      },
      emit: (event, ...args) => socket.emit(event, ...args),
      disconnect: () => socket.disconnect(),
    };
    return wrapped;
  };

const validProfile = (wallet: Wallet, displayName: string) =>
  buildProfile(wallet.account, {
    version: 1,
    devices: [{ did: wallet.device.did, auth: wallet.auth }],
    displayName,
  });

describe("the five flows over the wire", () => {
  let server: ChildProcess | undefined;
  let origin = "";
  let output = "";

  beforeAll(async () => {
    const databaseUrl = await flowsDatabaseUrl();
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [serverMain()], {
      env: {
        ...process.env,
        BEACON_DATABASE_URL: databaseUrl,
        PORT: String(port),
        BEACON_HOST: `127.0.0.1:${port}`,
        BEACON_PUBLIC_URL: origin,
        BEACON_CORS_ORIGINS: "*",
        // Every row below is one client address; the default write budget is for one player.
        BEACON_WRITE_RATE_LIMIT_MAX: "100000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    server.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    await waitForReady(origin, () => output, 60_000);
  });

  afterAll(async () => {
    if (!server || server.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      server?.once("exit", () => resolve());
      server?.kill("SIGTERM");
    });
  });

  /** A run against the booted server, with a short wait so a row that must time out does not take 15 s. */
  const run = (options: Partial<FlowsOptions> = {}): Promise<FlowReport[]> =>
    runFlows({ server: origin, connect: io, waitMs: 4_000, ...options });
  const byFlow = (reports: FlowReport[]) =>
    Object.fromEntries(reports.map((r) => [r.flow, r])) as Record<Flow, FlowReport>;
  /** Every flow but `failing` passed: a lying answer fails its own flow and no other. */
  const expectOnlyFailed = (reports: FlowReport[], failing: Flow[]) => {
    expect(
      reports.filter((r) => !r.ok).map((r) => r.flow),
      reports.map((r) => `${r.ok ? "ok" : "FAIL"} ${r.flow}: ${r.detail}`).join("\n"),
    ).toEqual(FLOWS.filter((flow) => failing.includes(flow)));
  };

  it("places, contributes, claims, publishes a profile and sees the live updates", async () => {
    const lines: string[] = [];
    const reports = await runFlows({
      server: origin,
      connect: io,
      log: (line) => lines.push(line),
    });
    const failed = reports.filter((r) => !r.ok);
    expect(
      failed,
      `${failed.map((r) => `${r.flow}: ${r.detail}`).join("\n")}\n--- driver\n${lines.join("\n")}\n--- server\n${output}`,
    ).toEqual([]);
    expect(reports.map((r) => r.flow)).toEqual([...FLOWS]);
    // `ok` alone would also be what a run that never waited for the close reports.
    const flows = byFlow(reports);
    expect(flows.live.detail).toMatch(/^room and roomGone for .+ arrived in cell/);
    expect(flows.claim.detail).toMatch(/back with its contributor/);
    expect(flows.contribute.detail).toMatch(/held by its contributor/);
    expect(flows.profile.detail).toMatch(/published and read back, version 1/);
  });

  it("reports a refusal per flow rather than throwing, when the pot never opens in time", async () => {
    // A pot that opens in a day: the claim is refused until the wait runs out, the close never
    // comes, and the other flows still report what they did.
    const flows = byFlow(
      await run({ lockDelaySec: 86_400, unlockDelaySec: 86_400, waitMs: 3_000 }),
    );
    expect(flows.place.ok).toBe(true);
    expect(flows.contribute.ok).toBe(true);
    expect(flows.claim.ok).toBe(false);
    expect(flows.claim.detail).toMatch(/^phase/);
    expect(flows.live.ok).toBe(true);
    expect(flows.live.detail).toMatch(/no close to wait for/);
    expect(flows.profile.ok).toBe(true);
  });

  it("explains the other flows when the place itself is refused", async () => {
    // A location off the map: the server refuses the place, so there is no room to contribute to,
    // claim from or watch; the profile does not need one.
    const reports = await run({ location: { lat: 999, lng: 0 } });
    expectOnlyFailed(reports, ["place", "contribute", "claim", "live"]);
    const flows = byFlow(reports);
    expect(flows.place.detail).toMatch(/^invalid/);
    for (const flow of ["contribute", "claim", "live"] as const) {
      expect(flows[flow].detail).toBe("no room: the place failed");
    }
  });

  it("runs as the command: one line per flow, and the count of failed flows", async () => {
    const lines: string[] = [];
    const failed = await main({ BEACON_FLOWS_SERVER: origin }, (line) => lines.push(line));
    expect(failed, lines.join("\n")).toBe(0);
    expect(lines.filter((l) => l.startsWith("ok   ")).map((l) => l.split(":")[0])).toEqual(
      FLOWS.map((flow) => `ok   ${flow}`),
    );
  });

  it("throws only when there is no server to report on", async () => {
    await expect(run({ server: `http://127.0.0.1:${await freePort()}` })).rejects.toThrow();
  });

  describe.concurrent("a server that faults", () => {
    it("a 500 on the claim fails the claim, and keeps what the place and the contribute did", async () => {
      const reports = await run({ fetch: faulting(opNamed("claim")) });
      expectOnlyFailed(reports, ["claim"]);
      const flows = byFlow(reports);
      expect(flows.claim.detail).toBe("threw ServerError: server error 500");
      expect(flows.place.detail).toMatch(/^room /);
      expect(flows.contribute.detail).toMatch(/held by its contributor/);
      expect(flows.live.detail).toMatch(/no close to wait for/);
    });

    it("a 500 on the contribute fails it, and the claim is then refused: the empty pot has closed", async () => {
      const reports = await run({ fetch: faulting(opNamed("contribute")) });
      expectOnlyFailed(reports, ["contribute", "claim"]);
      const flows = byFlow(reports);
      expect(flows.contribute.detail).toBe("threw ServerError: server error 500");
      // Nobody contributed, so the pot closed when it opened: the room is gone by the time of the claim.
      expect(flows.claim.detail).toMatch(/^(expired|denied|gone|unknownRoom)/);
    });

    it("a 500 on the place leaves the room flows without a room, and the profile still runs", async () => {
      const reports = await run({ fetch: faulting(placeCall) });
      expectOnlyFailed(reports, ["place", "contribute", "claim", "live"]);
      expect(byFlow(reports).place.detail).toBe("threw ServerError: server error 500");
    });

    it("a 500 on the room read back fails the contribute it was checking", async () => {
      const reports = await run({ fetch: faulting(roomRead) });
      expectOnlyFailed(reports, ["contribute"]);
      expect(byFlow(reports).contribute.detail).toBe("threw ServerError: server error 500");
    });

    it("a 500 on the profile publish fails the profile alone", async () => {
      const reports = await run({ fetch: faulting(profilePublish) });
      expectOnlyFailed(reports, ["profile"]);
      expect(byFlow(reports).profile.detail).toMatch(/500/);
    });
  });

  describe.concurrent("a server whose answer is not what was asked for", () => {
    it("a place answered ok without a room id", async () => {
      const reports = await run({
        fetch: answering(placeCall, (body) => ({ ...(body as object), id: undefined })),
      });
      expectOnlyFailed(reports, ["place", "contribute", "claim", "live"]);
      expect(byFlow(reports).place.detail).toMatch(/^answered ok without a room id/);
    });

    it("a contribute answered ok without the item's unique", async () => {
      const reports = await run({
        fetch: answering(opNamed("contribute"), (body) => ({ ...(body as object), result: {} })),
      });
      expectOnlyFailed(reports, ["contribute"]);
      expect(byFlow(reports).contribute.detail).toMatch(/^answered ok without the item's unique/);
    });

    it("a contribute answered ok with another item's unique", async () => {
      const reports = await run({
        fetch: answering(opNamed("contribute"), (body) => ({
          ...(body as object),
          result: { contributed: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
        })),
      });
      expectOnlyFailed(reports, ["contribute"]);
      expect(byFlow(reports).contribute.detail).toMatch(/^answered ok without the item's unique/);
    });

    it("a room read back that does not hold the contributed item", async () => {
      const reports = await run({
        fetch: answering(roomRead, (body) => {
          const room = body as { state: Record<string, unknown> };
          return { ...room, state: { ...room.state, contents: [] } };
        }),
      });
      expectOnlyFailed(reports, ["contribute"]);
      expect(byFlow(reports).contribute.detail).toMatch(/^the room read back does not hold/);
    });

    it("a room read back that holds the item for someone else", async () => {
      const placer = createWallet();
      const reports = await run({
        placer,
        fetch: answering(roomRead, (body) => {
          const room = body as { state: { contents: { owner?: string }[] } };
          const contents = room.state.contents.map((it) => ({ ...it, owner: placer.account.did }));
          return { ...room, state: { ...room.state, contents } };
        }),
      });
      expectOnlyFailed(reports, ["contribute"]);
      expect(byFlow(reports).contribute.detail).toMatch(/not its contributor$/);
    });

    it("a claim answered ok with no items", async () => {
      const reports = await run({
        fetch: answering(opNamed("claim"), (body) => ({
          ...(body as object),
          result: { items: [] },
        })),
      });
      expectOnlyFailed(reports, ["claim"]);
      const flows = byFlow(reports);
      expect(flows.claim.detail).toMatch(/^answered ok without the item/);
      expect(flows.live.detail).toMatch(/no close to wait for/);
    });

    it("a claim answered ok with no result at all", async () => {
      const reports = await run({
        fetch: answering(opNamed("claim"), (body) => ({ ...(body as object), result: undefined })),
      });
      expectOnlyFailed(reports, ["claim"]);
      expect(byFlow(reports).claim.detail).toMatch(/^answered ok without the item/);
    });

    it("a profile read back that was altered after signing", async () => {
      const reports = await run({
        fetch: answering(profileRead, (body) => ({ ...(body as object), version: 2 })),
      });
      expectOnlyFailed(reports, ["profile"]);
      expect(byFlow(reports).profile.detail).toBe("the read-back profile does not verify");
    });

    it("a profile read back that is another account's, validly signed", async () => {
      const other = validProfile(createWallet(), "flows");
      const reports = await run({ fetch: answering(profileRead, () => other) });
      expectOnlyFailed(reports, ["profile"]);
      expect(byFlow(reports).profile.detail).toMatch(/not the publisher's$/);
    });

    it("a profile read back that is the account's own, validly signed, under another name", async () => {
      const placer = createWallet();
      const stale = validProfile(placer, "someone else");
      const reports = await run({ placer, fetch: answering(profileRead, () => stale) });
      expectOnlyFailed(reports, ["profile"]);
      expect(byFlow(reports).profile.detail).toMatch(
        /name is "someone else", not the published one$/,
      );
    });

    it("a profile read back that finds nothing", async () => {
      const reports = await run({ fetch: answering(profileRead, () => null) });
      expectOnlyFailed(reports, ["profile"]);
      expect(byFlow(reports).profile.detail).toBe("published, but the read back found nothing");
    });
  });

  describe.concurrent("a live channel that does not deliver", () => {
    it("no map delta at all fails live, and no other flow", async () => {
      const reports = await run({ connect: lossy((event) => event === "map") });
      expectOnlyFailed(reports, ["live"]);
      expect(byFlow(reports).live.detail).toMatch(
        /^timed out after 4000 ms waiting for a room delta/,
      );
    });

    it("the close never arriving fails live after a claim", async () => {
      const reports = await run({
        connect: lossy(
          (event, payload) => event === "map" && (payload as { kind?: string }).kind === "roomGone",
        ),
      });
      expectOnlyFailed(reports, ["live"]);
      expect(byFlow(reports).live.detail).toMatch(
        /waiting for a roomGone delta .+ after the claim$/,
      );
    });

    it("a socket that never connects fails live, and the REST flows still run", async () => {
      const reports = await run({ connect: lossy(() => false, true) });
      expectOnlyFailed(reports, ["live"]);
      expect(byFlow(reports).live.detail).toBe(
        "timed out after 4000 ms waiting for the map socket to connect",
      );
    });
  });
});
