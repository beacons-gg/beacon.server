import type { BlockEntry } from "@beaconsgg/protocol-types";
import { beforeEach, describe, expect, it } from "vitest";
import { type BlocklistStore } from "../stores/blocklist-store";
import { PgBlocklistStore } from "../stores/blocklist.pg.store";
import { MemoryBlocklistStore } from "./memory-stores";
import { memoryTwin, pgTwin, type StoreTwin } from "./pg-twin";

/**
 * The blocklist store (`0009_admin`, `doc/spec/admin-api.md` §3), run against Postgres and the
 * memory store the service suites use.
 *
 * This table decides who the server refuses, so the two writes that matter are the upsert (an
 * admin re-adding a DID must refresh the note, not fail or duplicate) and the delete's report (the
 * admin op answers "was it actually there?" from `rowCount`). The optional `reason` is the third: it is absent rather than null on the way back out,
 * and only a real round trip through the driver's NULL handling proves that.
 */

const ADMIN = "did:key:zAdmin";
const T1 = "2026-07-01T00:00:00.000Z";
const T2 = "2026-07-02T00:00:00.000Z";
const T3 = "2026-07-03T00:00:00.000Z";

function entry(did: string, over: Partial<BlockEntry> = {}): BlockEntry {
  return { did, addedBy: ADMIN, addedAt: T1, ...over } as BlockEntry;
}

const twins: StoreTwin<BlocklistStore>[] = [
  memoryTwin(() => new MemoryBlocklistStore()),
  pgTwin((pool) => new PgBlocklistStore(pool), ["blacklist"]),
];

describe.each(twins)("BlocklistStore parity ($name)", (twin) => {
  beforeEach(() => twin.reset());

  it("re-adding a DID refreshes the entry instead of duplicating it", async () => {
    const store = await twin.open();
    await store.put(entry("did:key:zBad", { reason: "spam", addedAt: T1 }));
    await store.put(
      entry("did:key:zBad", { reason: "still spam", addedBy: "did:key:zOther", addedAt: T2 }),
    );

    const all = await store.all();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual({
      did: "did:key:zBad",
      reason: "still spam",
      addedBy: "did:key:zOther",
      addedAt: T2,
    });
  });

  it("an entry with no reason comes back with no reason, not a null one", async () => {
    const store = await twin.open();
    await store.put(entry("did:key:zBad"));

    // `exactOptionalPropertyTypes` is on, so the DTO must not carry `reason: null`. Postgres
    // stores SQL NULL and the row decoder drops the key; a twin that returned the column
    // verbatim would put a null into an admin console field typed `string | undefined`.
    const [row] = await store.all();
    expect(row).toEqual({ did: "did:key:zBad", addedBy: ADMIN, addedAt: T1 });
    expect(row).not.toHaveProperty("reason");
  });

  it("remove says whether a row was actually there", async () => {
    const store = await twin.open();
    await store.put(entry("did:key:zBad"));

    expect(await store.remove("did:key:zBad")).toBe(true);
    expect(await store.remove("did:key:zBad")).toBe(false); // the admin op's "not found" answer
    expect(await store.all()).toEqual([]);
  });

  it("lists oldest-first, with the DID breaking ties on a shared timestamp", async () => {
    const store = await twin.open();
    // Three orders deliberately disagree. By DID alone `zA` leads, so a twin that lost `added_at`
    // from its ORDER BY fails. The tie is the case every env seed is in (one shared `addedAt`), and
    // `zb`/`zC` split byte order (`zC` first) from a linguistic collation like Postgres's en_US
    // default (`zb` first), so a twin sorting the DID by the database's collation fails too. They
    // go in with `zb` first, so a twin returning insertion order fails as well.
    await store.put(entry("did:key:zA", { addedAt: T3 }));
    await store.put(entry("did:key:zb", { addedAt: T2 }));
    await store.put(entry("did:key:zC", { addedAt: T2 }));

    // The admin fetch reads this, and a seeded env DID must not move with the backend underneath.
    expect((await store.all()).map((e) => e.did)).toEqual([
      "did:key:zC",
      "did:key:zb",
      "did:key:zA",
    ]);
  });
});
