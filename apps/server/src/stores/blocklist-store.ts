import type { BlockEntry } from "@beaconsgg/protocol-types";

/**
 * Durable persistence for the admin-managed sender blocklist (`doc/spec/admin-api.md` §3): the
 * dynamic replacement for the env-only `BEACON_BLOCKLIST` set, which now just seeds this table at
 * boot (`SenderBlocklist.onModuleInit` hydrates first and `put`s only absent env DIDs, so an
 * admin-refreshed row is never clobbered). `SenderBlocklist` keeps an in-memory write-through cache
 * over it so the per-request `has` consult stays synchronous.
 *
 * Same pattern as the other stores: {@link PgBlocklistStore} implements it, and the service suites run on an in-memory fake
 * (`__tests__/memory-stores.ts`) held to the same parity suite.
 */
export interface BlocklistStore {
  /** Upsert an entry (a re-add refreshes reason/addedBy/addedAt). */
  put(entry: BlockEntry): Promise<void>;
  /** Delete an entry; true if a row was actually removed. */
  remove(did: string): Promise<boolean>;
  /**
   * Every entry, oldest first with the DID breaking a tie in byte order (uppercase before
   * lowercase), so a seeded env DID holds its position whichever backend is underneath: env seeds
   * share one `addedAt`, and a did:key is mixed-case base58. Boot rehydrate + the admin fetch.
   */
  all(): Promise<BlockEntry[]>;
}
