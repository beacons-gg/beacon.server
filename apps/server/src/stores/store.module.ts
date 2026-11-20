import { type BeforeApplicationShutdown, Global, Inject, Module } from "@nestjs/common";
import type { Store } from "@beaconsgg/policy-engine";
import { loadConfig } from "../config";
import { type DbConnections, type StoreBundle, createStores } from "./store.factory";
import type { AccessStore } from "./access-store";
import type { BlocklistStore } from "./blocklist-store";
import type { GeocodeCacheStore } from "./geocode-cache-store";
import type { PlaceStore } from "./place-store";
import type { MailboxStore } from "./mailbox-store";
import type { MediaStore } from "./media-store";
import type { NonceStore } from "./nonce-store";
import type { ProfileStore } from "./profile-store";
import type { SettingsStore } from "./settings-store";
import type { BackupRunStore } from "./backup-run-store";

/**
 * DI token for the resolved {@link StoreBundle} (room + profile + mailbox + media + nonce +
 * geocode-cache + places-dataset + blocklist + access + settings stores).
 */
export const STORE_BUNDLE = "BEACON_STORE_BUNDLE";
/** DI token for the custodied-room {@link Store}. */
export const STORE = "BEACON_STORE";
/** DI token for the durable {@link ProfileStore} (revocation registry). */
export const PROFILE_STORE = "BEACON_PROFILE_STORE";
/** DI token for the durable {@link MailboxStore} (per-recipient notification drop). */
export const MAILBOX_STORE = "BEACON_MAILBOX_STORE";
/** DI token for the durable {@link MediaStore} (content-addressed media metadata index). */
export const MEDIA_STORE = "BEACON_MEDIA_STORE";
/** DI token for the durable {@link NonceStore} (capability replay/idempotency log). */
export const NONCE_STORE = "BEACON_NONCE_STORE";
/** DI token for the durable {@link GeocodeCacheStore} (reverse-geocode label cache). */
export const GEOCODE_CACHE_STORE = "BEACON_GEOCODE_CACHE_STORE";
/** DI token for the durable {@link PlaceStore} (the owned places dataset, `doc/spec/places.md` §3). */
export const PLACE_STORE = "BEACON_PLACE_STORE";
/** DI token for the durable {@link BlocklistStore} (the admin-managed sender blocklist). */
export const BLOCKLIST_STORE = "BEACON_BLOCKLIST_STORE";
/** DI token for the durable {@link AccessStore} (the member list, `doc/spec/admin-api.md` §6). */
export const ACCESS_STORE = "BEACON_ACCESS_STORE";
/** DI token for the durable {@link SettingsStore} (operator-editable runtime settings). */
export const SETTINGS_STORE = "BEACON_SETTINGS_STORE";
/** DI token for the durable {@link BackupRunStore} (the backup/restore job log). */
export const BACKUP_RUN_STORE = "BEACON_BACKUP_RUN_STORE";
/** DI token for dedicated database connections, held out of the pool for a run's `COPY`. */
export const DB_CONNECTIONS = "BEACON_DB_CONNECTIONS";

/**
 * The single store construction site, behind {@link createStores}. The `STORE_BUNDLE` async
 * provider builds the bundle on the Postgres at `BEACON_DATABASE_URL`, running migrations before it
 * resolves; `STORE`, `PROFILE_STORE`, and the seven other tokens unwrap it so services inject a
 * bare store.
 *
 * `@Global` so the Rooms/Profiles services can inject without re-importing. On shutdown it ends the
 * bundle's pool (`close()`, which graceful shutdown relies on; needs `app.enableShutdownHooks()`).
 */
@Global()
@Module({
  providers: [
    { provide: STORE_BUNDLE, useFactory: (): Promise<StoreBundle> => createStores(loadConfig()) },
    { provide: STORE, useFactory: (b: StoreBundle): Store => b.store, inject: [STORE_BUNDLE] },
    {
      provide: PROFILE_STORE,
      useFactory: (b: StoreBundle): ProfileStore => b.profiles,
      inject: [STORE_BUNDLE],
    },
    {
      provide: MAILBOX_STORE,
      useFactory: (b: StoreBundle): MailboxStore => b.mailbox,
      inject: [STORE_BUNDLE],
    },
    {
      provide: MEDIA_STORE,
      useFactory: (b: StoreBundle): MediaStore => b.media,
      inject: [STORE_BUNDLE],
    },
    {
      provide: NONCE_STORE,
      useFactory: (b: StoreBundle): NonceStore => b.nonces,
      inject: [STORE_BUNDLE],
    },
    {
      provide: GEOCODE_CACHE_STORE,
      useFactory: (b: StoreBundle): GeocodeCacheStore => b.geocodeCache,
      inject: [STORE_BUNDLE],
    },
    {
      provide: PLACE_STORE,
      useFactory: (b: StoreBundle): PlaceStore => b.places,
      inject: [STORE_BUNDLE],
    },
    {
      provide: BLOCKLIST_STORE,
      useFactory: (b: StoreBundle): BlocklistStore => b.blocklist,
      inject: [STORE_BUNDLE],
    },
    {
      provide: ACCESS_STORE,
      useFactory: (b: StoreBundle): AccessStore => b.access,
      inject: [STORE_BUNDLE],
    },
    {
      provide: SETTINGS_STORE,
      useFactory: (b: StoreBundle): SettingsStore => b.settings,
      inject: [STORE_BUNDLE],
    },
    {
      provide: BACKUP_RUN_STORE,
      useFactory: (b: StoreBundle): BackupRunStore => b.backupRuns,
      inject: [STORE_BUNDLE],
    },
    {
      provide: DB_CONNECTIONS,
      useFactory: (b: StoreBundle): DbConnections => b.connections,
      inject: [STORE_BUNDLE],
    },
  ],
  exports: [
    STORE,
    PROFILE_STORE,
    MAILBOX_STORE,
    MEDIA_STORE,
    NONCE_STORE,
    GEOCODE_CACHE_STORE,
    PLACE_STORE,
    BLOCKLIST_STORE,
    ACCESS_STORE,
    SETTINGS_STORE,
    BACKUP_RUN_STORE,
    DB_CONNECTIONS,
  ],
})
export class StoreModule implements BeforeApplicationShutdown {
  constructor(@Inject(STORE_BUNDLE) private readonly bundle: StoreBundle) {}

  /** Graceful shutdown: end the one pool every store runs on. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.bundle.close();
  }
}
