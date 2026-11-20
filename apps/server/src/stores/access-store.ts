import type { AccessEntry } from "@beaconsgg/protocol-types";

/**
 * Durable persistence for the member list (`doc/spec/admin-api.md` §6), over the `access_members`
 * table (`0030_access`). `MemberList` keeps an in-memory write-through cache over it, so the
 * per-write membership consult stays synchronous.
 *
 * {@link PgAccessStore} implements it, and the service suites run on an in-memory fake
 * (`__tests__/memory-stores.ts`) held to the same parity suite.
 */
export interface AccessStore {
  /** Upsert entries, all or none. */
  put(entries: readonly AccessEntry[]): Promise<void>;
  /** Delete an entry; true if a row was actually removed. */
  remove(did: string): Promise<boolean>;
  /** Every entry, by DID in byte order. The boot rehydrate. */
  all(): Promise<AccessEntry[]>;
}
