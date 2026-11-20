import type { DidKey } from "@beaconsgg/protocol-types";
import { beforeEach, describe, expect, it } from "vitest";
import type { MailboxStore, StoredMessage } from "../stores/mailbox-store";
import { PgMailboxStore } from "../stores/mailbox.pg.store";
import { memoryMailbox } from "./memory-stores";
import { memoryTwin, pgTwin, type StoreTwin } from "./pg-twin";

/**
 * The mailbox store (`0002_mailbox`, `doc/spec/mailbox-and-media.md` §4.5), run against Postgres
 * and the memory fake the service suites use.
 *
 * `ack` is `id = ANY($2::text[])` on Postgres, a form that once went unexecuted by any test. It is also
 * where a bug would be a privacy bug rather than a wrong number, since the recipient clause is the
 * only thing stopping one reader from deleting another's mail, so it is asserted from both sides
 * here: the ids that belong to the caller go, and an id that does not stays.
 */

const ALICE = "did:key:zAlice" as DidKey;
const BOB = "did:key:zBob" as DidKey;

const T0 = "2026-07-01T00:00:00.000Z";
const T1 = "2026-07-01T01:00:00.000Z";
const T2 = "2026-07-01T02:00:00.000Z";
const T3 = "2026-07-01T03:00:00.000Z";

const GAME = "game-a";

function message(id: string, over: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id,
    to: ALICE,
    from: BOB,
    body: "opaque",
    game: GAME,
    receivedAt: T1,
    expiresAt: T3,
    ...over,
  } as StoredMessage;
}

const twins: StoreTwin<MailboxStore>[] = [
  memoryTwin(memoryMailbox),
  pgTwin((pool) => new PgMailboxStore(pool), ["mailbox"]),
];

describe.each(twins)("MailboxStore parity ($name)", (twin) => {
  beforeEach(() => twin.reset());

  it("stores a message opaquely and hands the reader back everything but the recipient", async () => {
    const store = await twin.open();
    await store.send(message("m1"), "nonce-1");

    // The fetch DTO is reader-scoped: `to` is who asked, so it is not echoed back.
    expect(await store.fetch(ALICE, GAME, T2)).toEqual([
      { id: "m1", from: BOB, body: "opaque", receivedAt: T1, expiresAt: T3 },
    ]);
  });

  it("a retried send returns the id already stored, and does not add a second message", async () => {
    const store = await twin.open();
    const first = await store.send(message("m1"), "nonce-1");
    // The retry: the client generated a new id, but the nonce is what decides.
    const retry = await store.send(message("m2"), "nonce-1");

    expect(first).toEqual({ id: "m1", deduped: false });
    expect(retry).toEqual({ id: "m1", deduped: true });
    expect(await store.fetch(ALICE, GAME, T2)).toHaveLength(1);
  });

  it("dedups per sender: another sender's send with the same nonce is a message of its own", async () => {
    const store = await twin.open();
    await store.send(message("m1"), "nonce-1");
    const other = await store.send(message("m2", { from: ALICE, to: ALICE }), "nonce-1");

    expect(other).toEqual({ id: "m2", deduped: false });
    expect((await store.fetch(ALICE, GAME, T2)).map((m) => m.id).sort()).toEqual(["m1", "m2"]);
  });

  it("fetches only this recipient's live mail, oldest first", async () => {
    const store = await twin.open();
    await store.send(message("late", { receivedAt: T2 }), "n1");
    await store.send(message("early", { receivedAt: T1 }), "n2");
    await store.send(message("expired", { receivedAt: T0, expiresAt: T1 }), "n3");
    await store.send(message("bobs", { to: BOB }), "n4");

    expect((await store.fetch(ALICE, GAME, T2)).map((m) => m.id)).toEqual(["early", "late"]);
  });

  it("acks only the caller's own ids, and reports how many it took", async () => {
    const store = await twin.open();
    await store.send(message("a1"), "n1");
    await store.send(message("a2"), "n2");
    await store.send(message("b1", { to: BOB }), "n3");

    // Bob's id is in the list and must survive: the recipient clause, not the id list, is what
    // decides. `a2` is left alone to prove the id list narrows as well.
    expect(await store.ack(ALICE, GAME, ["a1", "b1"])).toBe(1);
    expect((await store.fetch(ALICE, GAME, T2)).map((m) => m.id)).toEqual(["a2"]);
    expect((await store.fetch(BOB, GAME, T2)).map((m) => m.id)).toEqual(["b1"]);
  });

  it("reads and acks only the reader's game, so one game never sees another's message format", async () => {
    const store = await twin.open();
    await store.send(message("a"), "n1");
    await store.send(message("b", { game: "game-b" }), "n2");

    expect((await store.fetch(ALICE, GAME, T2)).map((m) => m.id)).toEqual(["a"]);
    expect((await store.fetch(ALICE, "game-b", T2)).map((m) => m.id)).toEqual(["b"]);
    // `b` is in the list and must survive an ack made as `game-a`.
    expect(await store.ack(ALICE, GAME, ["a", "b"])).toBe(1);
    expect((await store.fetch(ALICE, "game-b", T2)).map((m) => m.id)).toEqual(["b"]);
  });

  it("acking nothing is a no-op rather than a statement with no ids in it", async () => {
    const store = await twin.open();
    await store.send(message("a1"), "n1");

    expect(await store.ack(ALICE, GAME, [])).toBe(0);
    expect(await store.fetch(ALICE, GAME, T2)).toHaveLength(1);
  });

  it("sweeps at exactly the expiry the fetch stopped serving at", async () => {
    const store = await twin.open();
    await store.send(message("live", { expiresAt: T3 }), "n1");
    await store.send(message("stale", { expiresAt: T2 }), "n2");

    expect((await store.fetch(ALICE, GAME, T2)).map((m) => m.id)).toEqual(["live"]); // `expires_at > now`
    expect(await store.sweepExpired(T2)).toBe(1); // `expires_at <= now`: the same instant
    expect((await store.fetch(ALICE, GAME, T1)).map((m) => m.id)).toEqual(["live"]);
  });
});
