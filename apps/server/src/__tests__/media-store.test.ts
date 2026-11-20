import type { DidKey } from "@beaconsgg/protocol-types";
import { beforeEach, describe, expect, it } from "vitest";
import type { MediaRecord, MediaStore } from "../stores/media-store";
import { PgMediaStore } from "../stores/media.pg.store";
import { memoryMedia } from "./memory-stores";
import { memoryTwin, pgTwin, type StoreTwin } from "./pg-twin";

// The admin media list + review state (`doc/spec/admin-api.md` §3), run against EVERY twin so the
// keyset order, filters, cursor round-trip, and review stamping can never drift between them.
//
// Postgres is the one that had none of this. It is also the twin with the most room to disagree:
// `size` is BIGINT, which `pg` hands back as a string, so both the per-row decode and the two
// aggregates (`SUM(size)`, `COUNT(*) FILTER`) have to convert or a byte total silently becomes
// text. The assertions below are `toBe`/`toEqual` against numbers for exactly that reason.

const ALICE = "did:key:zAlice" as DidKey;
const BOB = "did:key:zBob" as DidKey;
const ADMIN = "did:key:zAdmin" as DidKey;

const T1 = "2026-07-01T00:00:00.000Z";
const T2 = "2026-07-02T00:00:00.000Z";
const T3 = "2026-07-03T00:00:00.000Z";

function record(hash: string, uploadedAt: string, over: Partial<MediaRecord> = {}): MediaRecord {
  return {
    hash,
    type: "image/png",
    size: 10,
    owner: ALICE,
    uploadedAt,
    lastAccessAt: null,
    reviewedAt: null,
    reviewedBy: null,
    ...over,
  };
}

async function seed(store: MediaStore, recs: MediaRecord[]): Promise<void> {
  for (const r of recs) await store.put(r);
}

const twins: StoreTwin<MediaStore>[] = [
  memoryTwin(memoryMedia),
  pgTwin((pool) => new PgMediaStore(pool), ["media"]),
];

describe.each(twins)("MediaStore.list/setReviewed/stats — $name twin", (twin) => {
  let store: MediaStore;
  beforeEach(async () => {
    await twin.reset();
    store = await twin.open();
  });

  // Two rows share T3 → hash is the tiebreak (DESC), so order is hb, ha, then the older rows.
  const ordering = () => [record("hb", T3), record("ha", T3), record("hc", T2), record("hd", T1)];

  it("orders newest-first with hash as the tiebreak on equal timestamps", async () => {
    await seed(store, ordering());
    const page = await store.list({ limit: 10, sort: "recent" });
    expect(page.items.map((i) => i.hash)).toEqual(["hb", "ha", "hc", "hd"]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("paginates by keyset without skipping or repeating across a timestamp tie", async () => {
    await seed(store, ordering());
    const p1 = await store.list({ limit: 2, sort: "recent" });
    expect(p1.items.map((i) => i.hash)).toEqual(["hb", "ha"]);
    expect(p1.nextCursor).toEqual({ uploadedAt: T3, hash: "ha", size: 10 });

    const p2 = await store.list({ limit: 2, sort: "recent", cursor: p1.nextCursor! });
    expect(p2.items.map((i) => i.hash)).toEqual(["hc", "hd"]);
    expect(p2.nextCursor).toBeUndefined();
  });

  // Sizes 50, 30, 30, 10 → largest-first with a 30/30 tie broken by hash DESC (sb before sa).
  const bySize = () => [
    record("sc", T1, { size: 50 }),
    record("sb", T2, { size: 30 }),
    record("sa", T3, { size: 30 }),
    record("sd", T1, { size: 10 }),
  ];

  it("orders largest-first with hash as the tiebreak on equal sizes", async () => {
    await seed(store, bySize());
    const page = await store.list({ limit: 10, sort: "size" });
    expect(page.items.map((i) => i.hash)).toEqual(["sc", "sb", "sa", "sd"]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("paginates by keyset in size order without skipping or repeating across a size tie", async () => {
    await seed(store, bySize());
    const p1 = await store.list({ limit: 2, sort: "size" });
    expect(p1.items.map((i) => i.hash)).toEqual(["sc", "sb"]);
    expect(p1.nextCursor).toEqual({ uploadedAt: T2, hash: "sb", size: 30 });

    const p2 = await store.list({ limit: 2, sort: "size", cursor: p1.nextCursor! });
    expect(p2.items.map((i) => i.hash)).toEqual(["sa", "sd"]);
    expect(p2.nextCursor).toBeUndefined();
  });

  // A hash is base64url, so mixed-case, and `hb`/`hC` split byte order from a linguistic one
  // (0023_byte_order). The ORDER BY and the cursor's `<` have to agree, or a page skips a row.
  it("breaks a tie by hash in byte order, and pages across it", async () => {
    await seed(store, [record("hC", T3), record("hb", T3)]);
    expect((await store.list({ limit: 10, sort: "recent" })).items.map((i) => i.hash)).toEqual([
      "hb",
      "hC",
    ]);
    const p1 = await store.list({ limit: 1, sort: "recent" });
    const p2 = await store.list({ limit: 1, sort: "recent", cursor: p1.nextCursor! });
    expect([...p1.items, ...p2.items].map((i) => i.hash)).toEqual(["hb", "hC"]);
    expect(p2.nextCursor).toBeUndefined();
  });

  it("copies in and out: changing a row after put, get or list does not reach the store", async () => {
    const put = record("h1", T1);
    await seed(store, [put]);
    put.type = "image/gif";
    const got = await store.get("h1");
    got!.size = 99;
    const listed = (await store.list({ limit: 10, sort: "recent" })).items[0];
    listed!.owner = BOB;
    expect(await store.get("h1")).toEqual(record("h1", T1));
  });

  it("filters by owner and type (exact match, AND-combined)", async () => {
    await seed(store, [
      record("a1", T1, { owner: ALICE, type: "image/png" }),
      record("a2", T2, { owner: ALICE, type: "image/jpeg" }),
      record("b1", T3, { owner: BOB, type: "image/png" }),
    ]);
    expect(
      (await store.list({ limit: 10, sort: "recent", owner: ALICE })).items.map((i) => i.hash),
    ).toEqual(["a2", "a1"]);
    expect(
      (await store.list({ limit: 10, sort: "recent", type: "image/png" })).items.map((i) => i.hash),
    ).toEqual(["b1", "a1"]);
    expect(
      (await store.list({ limit: 10, sort: "recent", owner: BOB, type: "image/png" })).items.map(
        (i) => i.hash,
      ),
    ).toEqual(["b1"]);
  });

  it("stamps + clears review state and filters/counts on it", async () => {
    await seed(store, [record("r1", T1, { size: 10 }), record("r2", T2, { size: 20 })]);

    expect(await store.setReviewed("r2", ADMIN, T3)).toBe(true);
    const reviewed = await store.list({ limit: 10, sort: "recent", reviewed: "reviewed" });
    expect(reviewed.items.map((i) => i.hash)).toEqual(["r2"]);
    expect(reviewed.items[0]).toMatchObject({ reviewedAt: T3, reviewedBy: ADMIN });
    expect(
      (await store.list({ limit: 10, sort: "recent", reviewed: "unreviewed" })).items.map(
        (i) => i.hash,
      ),
    ).toEqual(["r1"]);
    expect(await store.stats()).toEqual({ objects: 2, bytes: 30, unreviewed: 1 });

    // Un-review restores it to the queue; an unknown hash is a clean false.
    expect(await store.setReviewed("r2", null, null)).toBe(true);
    expect((await store.get("r2"))?.reviewedAt).toBeNull();
    expect((await store.stats()).unreviewed).toBe(2);
    expect(await store.setReviewed("nope", ADMIN, T3)).toBe(false);
  });

  it("keeps the first upload of a hash, and totals bytes per owner as a number", async () => {
    await seed(store, [record("h1", T1, { size: 10 }), record("h2", T2, { size: 32, owner: BOB })]);

    // Content-addressed: a re-upload of the same bytes is a hit, not a rewrite.
    expect(await store.put(record("h1", T3, { size: 999 }))).toEqual({ existed: true });
    expect((await store.get("h1"))?.size).toBe(10);

    // The quota check adds this to an incoming upload's size, so a string here would concatenate
    // instead of add and let a full account keep uploading.
    expect(await store.totalBytesFor(ALICE)).toBe(10);
    expect(await store.totalBytesFor(BOB)).toBe(32);
    expect(await store.totalBytesFor("did:key:zNobody" as DidKey)).toBe(0); // no rows, not null
  });

  it("stamps last access on a fetch, and delete says whether the row was there", async () => {
    await seed(store, [record("h1", T1)]);
    expect((await store.get("h1"))?.lastAccessAt).toBeNull(); // nullable until first fetch

    await store.touch("h1", T3);
    expect((await store.get("h1"))?.lastAccessAt).toBe(T3);

    expect(await store.delete("h1")).toBe(true);
    expect(await store.delete("h1")).toBe(false); // the eviction path's "already gone"
    expect(await store.get("h1")).toBeUndefined();
  });
});
