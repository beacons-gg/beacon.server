/**
 * A server that starts beside its Postgres waits for the database instead of exiting on the first
 * `ECONNREFUSED`, for a bounded time, and fails at once on an answer that waiting would not change.
 */
import { describe, expect, it } from "vitest";
import { createServer, type Socket } from "node:net";
import { isNotUpYet, probeOnce, waitForDatabase } from "../stores/db-ready";
import { testDatabaseUrl } from "./pg-twin";

const coded = (code: string, message = code): Error => Object.assign(new Error(message), { code });

/** A clock that only moves when the wait sleeps, and a log that keeps every line. */
function harness(failures: unknown[]) {
  let t = 0;
  const sleeps: number[] = [];
  const warnings: string[] = [];
  let attempts = 0;
  return {
    sleeps,
    warnings,
    attempts: () => attempts,
    options: {
      probe: () => {
        attempts += 1;
        const next = failures.shift();
        return next === undefined ? Promise.resolve() : Promise.reject(next);
      },
      sleep: (ms: number) => {
        sleeps.push(ms);
        t += ms;
        return Promise.resolve();
      },
      now: () => t,
      logger: { warn: (line: string) => void warnings.push(line) },
    },
  };
}

describe("waitForDatabase", () => {
  it("retries a refused connection with backoff, logging each attempt, until it answers", async () => {
    const h = harness([coded("ECONNREFUSED"), coded("ECONNREFUSED"), coded("57P03")]);
    await waitForDatabase("postgres://u:secret@db/x", h.options);
    expect(h.attempts()).toBe(4);
    expect(h.sleeps).toEqual([500, 1000, 2000]);
    expect(h.warnings).toHaveLength(3);
    expect(h.warnings[0]).toMatch(/ECONNREFUSED.*attempt 1, retrying in 500ms/);
    // The URL carries the password and never reaches the log.
    expect(h.warnings.join("\n")).not.toContain("secret");
  });

  it("gives up after the wait, saying why, without the URL", async () => {
    const h = harness(Array.from({ length: 100 }, () => coded("ECONNREFUSED")));
    const err = await waitForDatabase("postgres://u:secret@db/x", {
      ...h.options,
      waitMs: 10_000,
    }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/did not accept a connection within 10s .*ECONNREFUSED/);
    expect(err?.message).not.toContain("secret");
    // 500 + 1000 + 2000 + 4000, then the 2500 left, capped at the backoff's 5000.
    expect(h.sleeps).toEqual([500, 1000, 2000, 4000, 2500]);
  });

  it("fails at once on an answer from a running database", async () => {
    const auth = coded("28P01", "password authentication failed for user");
    const h = harness([auth]);
    await expect(waitForDatabase("postgres://db/x", h.options)).rejects.toBe(auth);
    expect(h.attempts()).toBe(1);
    expect(h.sleeps).toEqual([]);
  });

  it("connects at once to a database that is up", async () => {
    await expect(waitForDatabase(testDatabaseUrl(), { waitMs: 0 })).resolves.toBeUndefined();
  });

  it("really retries a port nobody listens on, and gives up", async () => {
    const warnings: string[] = [];
    await expect(
      waitForDatabase("postgres://u@127.0.0.1:1/x", {
        waitMs: 600,
        logger: { warn: (line: string) => void warnings.push(line) },
      }),
    ).rejects.toThrow(/did not accept a connection/);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });
});

describe("probeOnce", () => {
  it("gives up on a host that accepts and never answers, with a code the wait retries", async () => {
    // A listener that takes the connection and stays silent: pg alone would wait forever here.
    const sockets: Socket[] = [];
    const silent = createServer((socket) => void sockets.push(socket));
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const { port } = silent.address() as { port: number };
    try {
      const started = Date.now();
      const err: unknown = await probeOnce(`postgres://u@127.0.0.1:${port}/x`, 200).catch(
        (e: unknown) => e,
      );
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(err).toMatchObject({ code: "ETIMEDOUT" });
      expect(isNotUpYet(err)).toBe(true);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });
});

describe("isNotUpYet", () => {
  it("knows a database that is not up yet from one that refused this server", () => {
    expect(isNotUpYet(coded("ECONNREFUSED"))).toBe(true);
    expect(isNotUpYet(coded("ENOTFOUND"))).toBe(true);
    expect(isNotUpYet(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isNotUpYet(new AggregateError([coded("ECONNREFUSED"), coded("ECONNREFUSED")]))).toBe(
      true,
    );
    expect(isNotUpYet(coded("28P01"))).toBe(false); // wrong password
    expect(isNotUpYet(coded("3D000"))).toBe(false); // no such database
    expect(isNotUpYet("ECONNREFUSED")).toBe(false);
  });
});
