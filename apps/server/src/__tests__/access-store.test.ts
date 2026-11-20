import type { AccessEntry } from "@beaconsgg/protocol-types";
import { beforeEach, describe, expect, it } from "vitest";
import type { AccessStore } from "../stores/access-store";
import { PgAccessStore } from "../stores/access.pg.store";
import { MemoryAccessStore } from "./memory-stores";
import { memoryTwin, pgTwin, type StoreTwin } from "./pg-twin";

/**
 * The member list store (`0030_access`, `doc/spec/admin-api.md` §6), run against Postgres and the
 * memory store the service suites use: the upsert, the optional columns coming back absent rather
 * than null, the delete's report, byte order, and a put larger than one batch.
 */

const ADMIN = "did:key:zAdmin" as AccessEntry["did"];
const T1 = "2026-11-15T00:00:00.000Z";

function entry(did: string, over: Partial<AccessEntry> = {}): AccessEntry {
  return { did: did as AccessEntry["did"], status: "pending", requestedAt: T1, ...over };
}

const twins: StoreTwin<AccessStore>[] = [
  memoryTwin(() => new MemoryAccessStore()),
  pgTwin((pool) => new PgAccessStore(pool), ["access_members"]),
];

describe.each(twins)("AccessStore parity ($name)", (twin) => {
  beforeEach(() => twin.reset());

  it("a second put of a DID replaces the entry", async () => {
    const store = await twin.open();
    await store.put([entry("did:key:zA", { note: "hi" })]);
    const approved = entry("did:key:zA", { status: "member", decidedBy: ADMIN, decidedAt: T1 });
    await store.put([approved]);
    expect(await store.all()).toEqual([approved]);
  });

  it("an entry without its optional fields comes back without them, not with nulls", async () => {
    const store = await twin.open();
    const bare: AccessEntry = { did: "did:key:zA" as AccessEntry["did"], status: "member" };
    await store.put([bare]);
    const [row] = await store.all();
    expect(row).toEqual(bare);
    expect(row).not.toHaveProperty("note");
  });

  it("remove says whether a row was there", async () => {
    const store = await twin.open();
    await store.put([entry("did:key:zA")]);
    expect(await store.remove("did:key:zA")).toBe(true);
    expect(await store.remove("did:key:zA")).toBe(false);
  });

  it("lists by DID in byte order, and takes a put larger than one batch", async () => {
    const store = await twin.open();
    // `zb` and `zC` split byte order (`zC` first) from a linguistic collation (`zb` first).
    const many = Array.from({ length: 1205 }, (_, i) =>
      entry(`did:key:zm${String(i).padStart(4, "0")}`),
    );
    await store.put([entry("did:key:zb"), entry("did:key:zC"), ...many]);
    const dids = (await store.all()).map((e) => e.did);
    expect(dids).toHaveLength(1207);
    expect(dids.slice(0, 2)).toEqual(["did:key:zC", "did:key:zb"]);
  });
});
