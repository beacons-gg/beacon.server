import type { ProfileDoc } from "@beaconsgg/protocol-types";

/**
 * Durable persistence for the published-profile registry (beacon.core `doc/spec/identity.md` §6) —
 * the thing that gives offline revocation *teeth*. Without it, a restart drops every published
 * profile and a revoked device silently becomes valid again until re-published. `ProfilesService`
 * keeps an in-memory write-through cache over this so the per-op `isDeviceRevoked` consult stays
 * synchronous, rehydrating from {@link all} on boot.
 *
 * {@link PgProfileStore} implements it, and the service suites run on an in-memory fake
 * (`__tests__/memory-stores.ts`) held to the same parity suite. Writes are async, so the
 * interface is promise-based.
 */
export interface ProfileStore {
  /** Upsert the latest accepted profile for an account (keyed by `id` = account did:key). */
  put(profile: ProfileDoc): Promise<void>;
  /** Every stored profile — read once on boot to rehydrate the in-memory registry. */
  all(): Promise<ProfileDoc[]>;
  /** Registry size — a cheap operational count for `admin.status` (`doc/spec/admin-api.md` §3). */
  count(): Promise<number>;
}
