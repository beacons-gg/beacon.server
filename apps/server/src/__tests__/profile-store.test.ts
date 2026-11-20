import { buildProfile, createAccount, signUtf8, verifyProfile } from "@beaconsgg/identity";
import { canonicalJson, type ProfileDoc } from "@beaconsgg/protocol-types";
import { beforeEach, describe, expect, it } from "vitest";
import { PgProfileStore } from "../stores/profile.pg.store";
import type { ProfileStore } from "../stores/profile-store";
import { memoryProfiles } from "./memory-stores";
import { pgTwin, type StoreTwin } from "./pg-twin";

/**
 * Durability of the revocation registry: a published profile — and therefore a device revocation —
 * survives a restart. Parametrized over Postgres, where a reopen is a fresh store on the same
 * database, and the memory fake the service suites use.
 */

function profile(id: string, version: number, revoked: string[] = []): ProfileDoc {
  // The store treats a ProfileDoc as opaque JSON; a minimal shape is enough for durability.
  return { id, version, revoked } as unknown as ProfileDoc;
}

/**
 * The fake the service suites run on. Its reopen is the same map, which is all a service restart
 * over it can mean; the durable half of each case is Postgres's.
 */
function memoryBackend(): StoreTwin<ProfileStore> {
  let store = memoryProfiles();
  return {
    name: "memory",
    open: (): Promise<ProfileStore> => Promise.resolve(store),
    reset(): Promise<void> {
      store = memoryProfiles();
      return Promise.resolve();
    },
  };
}

const backends: StoreTwin<ProfileStore>[] = [
  memoryBackend(),
  {
    ...pgTwin((pool) => new PgProfileStore(pool), ["profiles"]),
    name: "PgProfileStore",
  },
];

describe.each(backends)("ProfileStore durability — $name", (backend) => {
  beforeEach(() => backend.reset());

  it("a published profile (and its revocations) survives a reopen", async () => {
    const a = await backend.open();
    await a.put(profile("did:key:acct1", 2, ["did:key:deviceX"]));

    const b = await backend.open();
    const all = await b.all();
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe("did:key:acct1");
    expect((all[0] as unknown as { revoked: string[] }).revoked).toContain("did:key:deviceX");
  });

  it("keeps a newer app's field through a reopen, still verifiable", async () => {
    // Postgres keeps the doc as JSONB, which reorders keys; the signature is over canonical JSON.
    const account = createAccount();
    const { proof: _p, ...body } = buildProfile(account, { version: 3, devices: [] });
    const newer = { ...body, pronouns: "they/them" };
    const sig = signUtf8(canonicalJson(newer), account.root.privateKey);
    const doc = { ...newer, proof: { type: "Ed25519", key: account.did, sig } } as ProfileDoc;
    const a = await backend.open();
    await a.put(doc);

    const [stored] = await (await backend.open()).all();
    expect(stored).toMatchObject({ pronouns: "they/them" });
    expect(verifyProfile(stored)).toBe(true);
  });

  it("upserts by account id (latest write wins)", async () => {
    const s = await backend.open();
    await s.put(profile("did:key:acct1", 1));
    await s.put(profile("did:key:acct1", 5, ["did:key:deviceY"]));
    const all = await s.all();
    expect(all).toHaveLength(1);
    expect((all[0] as unknown as { version: number }).version).toBe(5);
  });

  it("copies in and out: changing a profile after put, or after all, does not reach the store", async () => {
    const s = await backend.open();
    const doc = profile("did:key:acct1", 2, ["did:key:deviceX"]);
    await s.put(doc);
    (doc as unknown as { revoked: string[] }).revoked.push("did:key:deviceY");
    const [read] = await s.all();
    (read as unknown as { revoked: string[] }).revoked.length = 0;
    expect(await s.all()).toEqual([profile("did:key:acct1", 2, ["did:key:deviceX"])]);
  });
});
