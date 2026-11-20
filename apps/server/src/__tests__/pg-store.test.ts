import type { OpResult } from "@beaconsgg/protocol-types";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PgStore } from "../stores/pg.store";

/**
 * A Pool double whose single client either resolves every query or rejects them all, recording
 * every `release(...)` arg — so we can assert the commit error path evicts a broken connection
 * rather than returning it clean to the pool.
 */
function mockPool(behavior: "ok" | "fail") {
  const released: unknown[] = [];
  const client = {
    query: vi.fn(() =>
      behavior === "fail"
        ? Promise.reject(new Error("connection terminated unexpectedly"))
        : Promise.resolve({ rows: [] }),
    ),
    release: vi.fn((arg?: unknown) => released.push(arg)),
  };
  const pool = {
    connect: () => Promise.resolve(client),
  } as unknown as Pool;
  return { pool, released };
}

const nonceMutation = {
  kind: "putNonce" as const,
  nonce: "n1",
  result: { ok: true, version: 1 } as OpResult,
};

describe("PgStore.commit — connection handling", () => {
  it("releases the client clean (no arg) on a successful commit", async () => {
    const { pool, released } = mockPool("ok");
    await new PgStore(pool).commit([nonceMutation]);
    expect(released).toEqual([undefined]); // returned to the pool for reuse
  });

  it("releases the client AS FAILED when the transaction errors (evicts the broken connection)", async () => {
    const { pool, released } = mockPool("fail");
    await expect(new PgStore(pool).commit([nonceMutation])).rejects.toThrow();
    expect(released).toHaveLength(1);
    expect(released[0]).toBeInstanceOf(Error); // release(err) → node-postgres destroys it
  });
});
