import { Logger } from "@nestjs/common";
import type { Store } from "@beaconsgg/policy-engine";
import { Pool, type PoolClient } from "pg";
import type { ServerConfig } from "../config";
import type { BackupRunStore } from "./backup-run-store";
import { PgBackupRunStore } from "./backup-run.pg.store";
import type { AccessStore } from "./access-store";
import { PgAccessStore } from "./access.pg.store";
import type { BlocklistStore } from "./blocklist-store";
import { PgBlocklistStore } from "./blocklist.pg.store";
import type { GeocodeCacheStore } from "./geocode-cache-store";
import { PgGeocodeCacheStore } from "./geocode-cache.pg.store";
import type { MailboxStore } from "./mailbox-store";
import { PgMailboxStore } from "./mailbox.pg.store";
import type { MediaStore } from "./media-store";
import { PgMediaStore } from "./media.pg.store";
import type { NonceStore } from "./nonce-store";
import { PgNonceStore } from "./nonce.pg.store";
import { migrate } from "./pg.migrations";
import { PgStore } from "./pg.store";
import type { PlaceStore } from "./place-store";
import { PgPlaceStore } from "./place.pg.store";
import type { ProfileStore } from "./profile-store";
import { PgProfileStore } from "./profile.pg.store";
import type { SettingsStore } from "./settings-store";
import { PgSettingsStore } from "./settings.pg.store";
import { waitForDatabase } from "./db-ready";
import { takeWriterLock, type WriterLock } from "./writer-lock";

/**
 * A connection of its own for a run (backup and restore both stream `COPY` over one). The pool
 * satisfies this: a run holds one client out of it for the database phase and hands it back.
 */
export interface DbConnections {
  connect(): Promise<PoolClient>;
}

/** The durable stores the server runs on, all on the one database and one connection pool. */
export interface StoreBundle {
  store: Store;
  profiles: ProfileStore;
  mailbox: MailboxStore;
  media: MediaStore;
  nonces: NonceStore;
  geocodeCache: GeocodeCacheStore;
  places: PlaceStore;
  blocklist: BlocklistStore;
  /** The member list a non-open server takes writes from (`0030_access`). */
  access: AccessStore;
  settings: SettingsStore;
  /** The job log for backup and restore runs (`0026_backup_runs`). */
  backupRuns: BackupRunStore;
  /** Dedicated connections for a backup's or restore's `COPY`: held out of the one pool. */
  connections: DbConnections;
  /** End the pool every store runs on (idempotent). The stores own nothing to release themselves. */
  close(): Promise<void>;
}

/**
 * The slice of {@link ServerConfig} the factory reads (ignores host/CORS/etc.). `writerLockWaitMs`
 * is required on purpose, `null` being the only way to skip the lock: the suites build many bundles
 * on one database, a server never does, and the type makes every caller say which it is.
 */
export type StoreConfig = Pick<ServerConfig, "databaseUrl" | "pgPoolSize" | "maxNonces"> & {
  writerLockWaitMs: ServerConfig["writerLockWaitMs"] | null;
};

const POOL_KEEPALIVE_DELAY_MS = 30_000;

/** What a server does when it loses the writer lock while serving: stop, before a second writer can start. */
function stopOnLostLock(reason: Error): never {
  new Logger("WriterLock").error(
    `Lost the writer lock on BEACON_DATABASE_URL (${reason.message}); stopping, so no second writer can start.`,
  );
  process.exit(1);
}

/**
 * Build the custody stores from config: all nine (room, profile, mailbox, media, nonce, the geocode
 * cache, the places dataset, the blocklist and the settings table) on the Postgres at
 * `BEACON_DATABASE_URL`, which `loadConfig` has already refused to start without.
 *
 * It first waits for the database to accept a connection (`db-ready.ts`), for a Postgres that is
 * still starting. Then it takes the writer lock (`writer-lock.ts`, `BEACON_WRITER_LOCK_WAIT_MS`):
 * one server per database, enforced. One pool of `BEACON_PG_POOL_SIZE` connections serves every store, and the
 * migrations run once on it before any store is built, so callers can serve immediately. Then the room store's
 * {@link PgStore.healLifecycleDue} repair runs, once per boot. A failure on the way ends the pool.
 *
 * The single construction site the store wiring lives behind, so a backend swap is a one-file
 * concern.
 */
export async function createStores(
  config: StoreConfig,
  options: { onWriterLockLost?: (reason: Error) => void } = {},
): Promise<StoreBundle> {
  await waitForDatabase(config.databaseUrl);
  // The lock comes first: the migrations and the lifecycle repair below both write.
  const lock: WriterLock | undefined =
    config.writerLockWaitMs === null
      ? undefined
      : await takeWriterLock(config.databaseUrl, {
          waitMs: config.writerLockWaitMs,
          onLost: options.onWriterLockLost ?? stopOnLostLock,
        });
  // Keepalive so a backup's long-held connection (`backup/backup-job.ts`) learns of a dead peer.
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.pgPoolSize,
    keepAlive: true,
    keepAliveInitialDelayMillis: POOL_KEEPALIVE_DELAY_MS,
  });
  // The lock goes last and always, even if ending the pool fails.
  const shutdown = async () => {
    try {
      await pool.end();
    } finally {
      await lock?.release();
    }
  };
  try {
    await migrate(pool);
    const store = new PgStore(pool, config.maxNonces);
    await store.healLifecycleDue();
    const mailbox = new PgMailboxStore(pool);
    // In the background, never in the boot's way: two counts for one log line.
    void warnUnstamped(store, mailbox);
    let ended: Promise<void> | undefined;
    return {
      store,
      profiles: new PgProfileStore(pool),
      mailbox,
      media: new PgMediaStore(pool),
      nonces: new PgNonceStore(pool),
      geocodeCache: new PgGeocodeCacheStore(pool),
      places: new PgPlaceStore(pool),
      blocklist: new PgBlocklistStore(pool),
      access: new PgAccessStore(pool),
      settings: new PgSettingsStore(pool),
      backupRuns: new PgBackupRunStore(pool),
      connections: pool,
      close: () => (ended ??= shutdown()),
    };
  } catch (err) {
    await shutdown();
    throw err;
  }
}

/**
 * Rooms and mail with no game, counted once per boot and logged: data from before game slugs, which
 * no game can read or act on until the operator stamps it (doc/deploy.md). Never repaired here,
 * since no shipped code names a game, and a missed backfill should be loud rather than silent.
 */
async function warnUnstamped(store: PgStore, mailbox: PgMailboxStore): Promise<void> {
  const logger = new Logger("GameStamps");
  try {
    const [rooms, mail] = await Promise.all([store.countWithoutGame(), mailbox.countWithoutGame()]);
    if (rooms === 0 && mail === 0) return;
    logger.warn(
      `${rooms} room(s) and ${mail} mailbox message(s) carry no game: no game can read or act on ` +
        "them until they are stamped (see doc/deploy.md)",
    );
  } catch (err) {
    logger.warn(`could not count rooms and mail with no game: ${String(err)}`);
  }
}
