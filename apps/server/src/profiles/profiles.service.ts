import { acceptProfile, isDeviceRevoked } from "@beaconsgg/identity";
import {
  conformsTo,
  MAX_PROFILE_BYTES,
  profileBytes,
  profileDocReadSchema,
  type DidKey,
  type ProfileDoc,
} from "@beaconsgg/protocol-types";
import { KeyedMutex } from "@beaconsgg/server-runtime";
import { Inject, Injectable, Optional, type OnModuleInit } from "@nestjs/common";
import { SenderBlocklist } from "../common/blocklist";
import type { ProfileStore } from "../stores/profile-store";
import { PROFILE_STORE } from "../stores/store.module";
import type { DeviceRevocations } from "../common/signed-request-gate";

/**
 * Is `body` over `MAX_PROFILE_BYTES`? Canonicalizing a body near the JSON limit (several MB) blocks
 * the event loop for about a second, so a native `JSON.stringify` refuses it first: its length is the
 * canonical form's (same escapes and numbers, keys only reordered), in UTF-16 units, which never
 * outnumber the UTF-8 bytes. What passes is small enough to count exactly.
 */
function overProfileCap(body: unknown): boolean {
  let json: string | undefined;
  try {
    json = JSON.stringify(body);
  } catch {
    return true; // nested past the stack, which the canonicalizer cannot take either
  }
  if ((json?.length ?? 0) > MAX_PROFILE_BYTES) return true;
  try {
    return profileBytes(body) > MAX_PROFILE_BYTES;
  } catch {
    // Not canonicalizable, so no signature can cover it (`1e400` parses to Infinity): the
    // signature check answers `invalid`, as it did before the cap ran first.
    return false;
  }
}

/**
 * The published-profile registry (beacon.core `doc/spec/identity.md` §6) — what gives offline
 * revocation *teeth* online. It keeps the latest accepted profile per account, high-water by signed
 * `version` so a replayed pre-revocation profile is rejected (`acceptProfile`). The op pipeline
 * consults `isRevoked` to deny a revoked device's ops.
 *
 * The in-memory map is a **write-through cache** over the durable {@link ProfileStore} (injected
 * from the store factory): reads (`isRevoked`, called per op by the
 * engine) stay synchronous and fast, while every accepted profile is persisted, so **revocations
 * survive a restart** (without persistence a restart un-revokes every revoked device until re-
 * published). Revocation stays online + best-effort + per-server. When constructed without a store
 * (unit tests), it is a pure in-memory registry.
 */
@Injectable()
export class ProfilesService implements OnModuleInit, DeviceRevocations {
  private readonly profiles = new Map<DidKey, ProfileDoc>();
  /** Per-account lock: serializes publish's read→accept→persist so the durable write order can't race. */
  private readonly locks = new KeyedMutex();

  constructor(
    private readonly blocklist: SenderBlocklist,
    @Optional() @Inject(PROFILE_STORE) private readonly store?: ProfileStore,
  ) {}

  /** Rehydrate the registry from the durable store so revocations survive a restart. */
  async onModuleInit(): Promise<void> {
    if (!this.store) return;
    for (const profile of await this.store.all()) this.profiles.set(profile.id, profile);
  }

  /**
   * Accept a published profile if it verifies and its `version` advances past the one on file
   * (rollback guard). Returns `stale` for a non-advancing version, `invalid` for a bad signature,
   * and `denied` for a blocked account. Every rejection is a returned verdict the controller
   * maps to a status, never a throw, so the return type stays the whole story.
   * An accepted profile is persisted write-through, so the high-water and any revocations are durable.
   *
   * Takes the body exactly as it came off the wire and keeps it that way: the signature covers the
   * whole doc, so a field a newer app added (which this build does not know) is verified, stored
   * and served back with the rest, and a revocation on that doc takes effect here too. The shape
   * check is the read twin's, the rule `verifyProfile` follows on every read. Size is checked first
   * (`tooLarge`, see `MAX_PROFILE_BYTES`).
   */
  async publish(
    profile: unknown,
  ): Promise<
    | { ok: true; profile: ProfileDoc }
    | { ok: false; error: "invalid" | "stale" | "denied" | "tooLarge" }
  > {
    if (overProfileCap(profile)) return { ok: false, error: "tooLarge" };
    if (!conformsTo(profileDocReadSchema, profile)) return { ok: false, error: "invalid" };
    // Serialize per account: without the lock two concurrent publishes for the same id both read the
    // same current profile and their durable `store.put`s can complete out of order, leaving the store
    // on a lower version than memory — so a revocation is lost after a restart's rehydrate.
    return this.locks.run(profile.id, async () => {
      const accepted = acceptProfile(this.profiles.get(profile.id), profile);
      if (!accepted.ok) return { ok: false, error: accepted.reason };
      // `acceptProfile` is what makes the id cryptographic: until the doc's self-signature verifies,
      // `profile.id` is a claim anyone could put in a body, so a controller-level block check here
      // would gate on nothing while looking like a control. Tested before either write, so a blocked
      // account's publish takes no effect. It can no longer publish a revocation either, which is
      // contained: every op from that account is refused by the same blocklist on this server, so a
      // device it cannot revoke here can do nothing here.
      if (this.blocklist.has(accepted.profile.id)) return { ok: false, error: "denied" };
      this.profiles.set(profile.id, accepted.profile);
      await this.store?.put(accepted.profile);
      return { ok: true, profile: accepted.profile };
    });
  }

  /**
   * The latest accepted profile this server holds for `account` (its self-signed doc), or undefined
   * if none is on file. Reads the in-memory map (fully rehydrated on boot), so it's synchronous.
   * The doc is self-signed, so a fetching client verifies it independently — the server is just a
   * copy host (beacon.core `doc/spec/identity.md` §6.2).
   */
  get(account: DidKey): ProfileDoc | undefined {
    return this.profiles.get(account);
  }

  /** Every account with a profile on this server, from the rehydrated map: `admin.access.admitAll`. */
  accounts(): IterableIterator<DidKey> {
    return this.profiles.keys();
  }

  /** Best-effort online check: true only if we hold a profile for `account` that revokes `device`. */
  isRevoked(account: DidKey, device: DidKey): boolean {
    const profile = this.profiles.get(account);
    return profile ? isDeviceRevoked(profile, device) : false;
  }
}
