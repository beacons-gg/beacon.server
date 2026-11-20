import { beforeEach, describe, expect, it } from "vitest";
import type { NonceKey, NonceStore } from "../stores/nonce-store";
import { NonceService } from "../common/nonce.service";
import { PgNonceStore } from "../stores/nonce.pg.store";
import { memoryNonces } from "./memory-stores";
import { memoryTwin, pgTwin, type StoreTwin } from "./pg-twin";

/**
 * The capability-nonce store (`0004_nonces`, `doc/spec/mailbox-and-media.md` §3.2), run against
 * Postgres and the memory fake the service suites use, so the replay guarantee cannot hold on one
 * and not the other.
 *
 * This table is what makes a signed op idempotent: a client that retries after a timeout must get
 * the result the server already committed, not a second execution. That guarantee is spelled as
 * `ON CONFLICT DO NOTHING`, and "the second write loses" is the kind of thing that reads correct
 * and can still be wrong.
 */

/** A key for `nonce`, signed by one actor under one op unless a test says otherwise. */
const k = (nonce: string, actor = "did:key:zA", op = "mailbox.send"): NonceKey => ({
  actor,
  op,
  nonce,
});

const T0 = "2026-07-01T00:00:00.000Z";
const T1 = "2026-07-01T01:00:00.000Z";
const T2 = "2026-07-01T02:00:00.000Z";

const pg = pgTwin((pool) => new PgNonceStore(pool), ["capability_nonces"]);
const twins: StoreTwin<NonceStore>[] = [memoryTwin(memoryNonces), pg];

describe.each(twins)("NonceStore parity ($name)", (twin) => {
  beforeEach(() => twin.reset());

  it("returns the committed result while the nonce is live", async () => {
    const store = await twin.open();
    await store.put(k("n1"), '{"ok":true}', T2);

    expect(await store.get(k("n1"), T1)).toEqual({ result: '{"ok":true}' });
    expect(await store.get(k("never-seen"), T1)).toBeUndefined();
  });

  it("a replayed op gets the first result back, not the second one", async () => {
    const store = await twin.open();
    await store.put(k("n1"), "first", T2);
    await store.put(k("n1"), "second", T2); // the retry: same nonce, recomputed result

    // The whole point of the table. A second write that won would hand a client a result the
    // server never committed for that op.
    expect(await store.get(k("n1"), T1)).toEqual({ result: "first" });
  });

  it("keys a nonce per actor and op, so one request never reads another's memo", async () => {
    const store = await twin.open();
    await store.put(k("n1"), "send", T2);

    // Another op from the same actor, and the same op from another actor, are new requests.
    expect(await store.get(k("n1", "did:key:zA", "mailbox.ack"), T1)).toBeUndefined();
    expect(await store.get(k("n1", "did:key:zB"), T1)).toBeUndefined();

    // Each records its own result beside the first, which stays as it was.
    await store.put(k("n1", "did:key:zA", "mailbox.ack"), "ack", T2);
    await store.put(k("n1", "did:key:zB"), "other", T2);
    expect(await store.get(k("n1"), T1)).toEqual({ result: "send" });
    expect(await store.get(k("n1", "did:key:zA", "mailbox.ack"), T1)).toEqual({ result: "ack" });
    expect(await store.get(k("n1", "did:key:zB"), T1)).toEqual({ result: "other" });
  });

  it("a nonce expires exactly at expires_at, and the sweep takes it from there", async () => {
    const store = await twin.open();
    await store.put(k("n1"), "r", T1);

    // `get` is `expires_at > now`, so the boundary instant is already a miss.
    expect(await store.get(k("n1"), T0)).toEqual({ result: "r" });
    expect(await store.get(k("n1"), T1)).toBeUndefined();

    // The sweep is `expires_at <= now`: the same instant, the other side of the comparison, so a
    // row can never be both unreadable and unreclaimable.
    expect(await store.sweepExpired(T0)).toBe(0);
    expect(await store.sweepExpired(T1)).toBe(1);
    expect(await store.get(k("n1"), T0)).toBeUndefined();
  });

  it("the sweep reports how many it took, and leaves live nonces alone", async () => {
    const store = await twin.open();
    await store.put(k("gone1"), "r", T0);
    await store.put(k("gone2"), "r", T1);
    await store.put(k("live"), "r", T2);

    expect(await store.sweepExpired(T1)).toBe(2);
    expect(await store.get(k("live"), T1)).toEqual({ result: "r" });
  });
});

describe("NonceService across the 0029 upgrade", () => {
  beforeEach(() => pg.reset());

  it("answers a record from before nonces were scoped, for one retention window after it starts", async () => {
    const store = await pg.open();
    // What `0029_nonce_scope` leaves of a row recorded before it: no actor and no op.
    await pg.query(
      "INSERT INTO capability_nonces (nonce, result, expires_at) VALUES ('n1', 'before', $1)",
      [T2],
    );
    let now = Date.parse(T0);
    const service = new NonceService(
      store,
      { retentionMs: 600_000, writeLocked: false },
      () => now,
    );

    // The store reads keys exactly; the service reads the old record for a retry of any request.
    expect(await store.get(k("n1"), T0)).toBeUndefined();
    expect(await service.check(k("n1"))).toEqual({ result: "before" });
    expect(await service.check(k("n1", "did:key:zB", "media.put"))).toEqual({ result: "before" });

    // Past the window no request from before the upgrade is fresh, so the old record is not read.
    now += 600_000;
    expect(await service.check(k("n1"))).toBeUndefined();
  });
});
