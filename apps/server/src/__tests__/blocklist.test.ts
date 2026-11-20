import type { BlockEntry, DidKey } from "@beaconsgg/protocol-types";
import { describe, expect, it } from "vitest";
import { SenderBlocklist } from "../common/blocklist";
import { MemoryBlocklistStore } from "./memory-stores";

const T0 = "2026-07-24T00:00:00.000Z";
const DID_A = "did:key:zAlice" as DidKey;
const DID_B = "did:key:zBob" as DidKey;

const entry = (did: DidKey, over: Partial<BlockEntry> = {}): BlockEntry => ({
  did,
  reason: "abuse",
  addedBy: "did:key:zAdmin",
  addedAt: T0,
  ...over,
});

describe("SenderBlocklist — store-backed write-through cache (`doc/spec/admin-api.md` §3)", () => {
  it("env seeds deny from construction, persist durably, and survive a restart", async () => {
    const store = new MemoryBlocklistStore();
    const bl = new SenderBlocklist(store, [DID_A]);
    expect(bl.has(DID_A)).toBe(true); // before init — pre-Phase-B behavior preserved
    await bl.onModuleInit();
    expect((await store.all())[0]).toMatchObject({ did: DID_A, addedBy: "env" });

    // "Restart": a fresh cache over the same durable store, no env seed this time.
    const rebooted = new SenderBlocklist(store, []);
    expect(rebooted.has(DID_A)).toBe(false); // not yet hydrated
    await rebooted.onModuleInit();
    expect(rebooted.has(DID_A)).toBe(true);
  });

  it("a boot seed never clobbers an admin-managed row", async () => {
    const store = new MemoryBlocklistStore();
    await store.put(entry(DID_A, { reason: "admin says", addedBy: "did:key:zAdmin" }));
    const bl = new SenderBlocklist(store, [DID_A]);
    await bl.onModuleInit();
    expect((await store.all())[0]).toMatchObject({ reason: "admin says" });
  });

  it("add denies immediately and durably; remove lifts both cache and store", async () => {
    const store = new MemoryBlocklistStore();
    const bl = new SenderBlocklist(store, []);
    await bl.onModuleInit();

    await bl.add(entry(DID_B));
    expect(bl.has(DID_B)).toBe(true);
    expect(await bl.list()).toHaveLength(1);

    expect(await bl.remove(DID_B)).toBe(true);
    expect(bl.has(DID_B)).toBe(false);
    expect(await bl.list()).toHaveLength(0);
    expect(await bl.remove(DID_B)).toBe(false);
  });

  it("protected (admin) DIDs are never blocked — add refuses, env seeds are skipped", async () => {
    const store = new MemoryBlocklistStore();
    const bl = new SenderBlocklist(store, [DID_A, DID_B], [DID_A]);
    expect(bl.has(DID_A)).toBe(false); // a protected env seed never denies, even pre-init
    expect(bl.has(DID_B)).toBe(true);
    await bl.onModuleInit();
    expect((await store.all()).map((e) => e.did)).toEqual([DID_B]); // A skipped, B seeded
    expect(bl.isProtected(DID_A)).toBe(true);
    await expect(bl.add(entry(DID_A))).rejects.toThrow(/protected/);
    expect(bl.has(DID_A)).toBe(false);
  });
});
