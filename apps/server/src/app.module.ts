import { AboutController } from "./about/about.controller";
import { Logger, Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import type { Store } from "@beaconsgg/policy-engine";
import { AdminController } from "./admin/admin.controller";
import { AdminService } from "./admin/admin.service";
import { BackupController } from "./backup/backup.controller";
import { BackupService } from "./backup/backup.service";
import { ADMINS, AdminGate } from "./common/admin-gate";
import { GAMES_POLICY, GameGate, gamesPolicyFrom, type GamesPolicy } from "./common/game-gate";
import { DEVICE_REVOCATIONS, SignedRequestGate } from "./common/signed-request-gate";
import { SenderBlocklist } from "./common/blocklist";
import { MemberList } from "./common/member-list";
import { AccessController } from "./access/access.controller";
import { AccessAdminController } from "./access/access-admin.controller";
import { DidBudgets } from "./common/did-budgets";
import { NonceService } from "./common/nonce.service";
import {
  DescriptorRateLimitGuard,
  PlayerReadRateLimitGuard,
  ReadRateLimitGuard,
} from "./common/read-rate-limit.guard";
import { WriteRateLimitGuard } from "./common/rate-limit.guard";
import { SIGNED_REQUEST_WINDOW_MS } from "./common/signed-request";
import { UnderstandsFilter } from "./common/understands.filter";
import { WriteLockGuard } from "./common/write-lock.guard";
import { loadConfig, type ServerConfig } from "./config";
import { DiscoveryController } from "./discovery/discovery.controller";
import { GeocodeController } from "./geocode/geocode.controller";
import { createGeocodeProvider } from "./geocode/geocode-provider";
import { GeocodeService, geocodeConfigFrom } from "./geocode/geocode.service";
import { PlacesController } from "./places/places.controller";
import { PlacesAdminController } from "./places/places-admin.controller";
import { ContributionsController } from "./places/contributions.controller";
import { PlacesService, placesConfigFrom } from "./places/places.service";
import { PlacesAdminService, placesAdminConfigFrom } from "./places/admin.service";
import { ContributionsService, contributionsConfigFrom } from "./places/contributions.service";
import { createMediaTransferOutbound, MediaTransfer } from "./media/media-transfer";
import { SnapshotService, snapshotConfigFrom } from "./places/snapshot.service";
import { AtlasStaging } from "./places/atlas-staging";
import { AtlasSurveys } from "./places/atlas-survey";
import { ATLAS_OUTBOUND, ATLAS_VOLUMES_DIR, atlasOutbound } from "./places/connectors/atlas";
import { HealthController } from "./health/health.controller";
import { HomeController } from "./home/home.controller";
import { HomeService, roomActivityOf } from "./home/home.service";
import { MailboxController } from "./mailbox/mailbox.controller";
import { MailboxGateway } from "./mailbox/mailbox.gateway";
import { MailboxService, mailboxConfigFrom } from "./mailbox/mailbox.service";
import { MediaController } from "./media/media.controller";
import { type MediaBlobStore, MEDIA_BLOB, createMediaBlob } from "./media/media-blob";
import { MediaService, mediaConfigFrom } from "./media/media.service";
import { ProfilesController } from "./profiles/profiles.controller";
import { ProfilesService } from "./profiles/profiles.service";
import { RoomsController } from "./rooms/rooms.controller";
import { RoomsGateway } from "./rooms/rooms.gateway";
import { RoomsService } from "./rooms/rooms.service";
import { ScoutsController } from "./scouts/scouts.controller";
import { ScoutsService } from "./scouts/scouts.service";
import { ServerIdentity } from "./server-identity";
import { runtimeSettingsFrom } from "./settings/registry";
import {
  BOOT_CONFIG,
  BOOT_ENV,
  RESTORED_IDENTITY,
  SERVER_CONFIG,
  createLiveConfig,
  liveView,
} from "./settings/live-config";
import { SettingsService } from "./settings/settings.service";
import type { BackupRunStore } from "./stores/backup-run-store";
import { withRunClient } from "./backup/backup-db";
import { readRestoredIdentity, type RestoredIdentity } from "./stores/restored-identity";
import type { DbConnections } from "./stores/store.factory";
import type { AccessStore } from "./stores/access-store";
import type { BlocklistStore } from "./stores/blocklist-store";
import type { GeocodeCacheStore } from "./stores/geocode-cache-store";
import type { MailboxStore } from "./stores/mailbox-store";
import type { MediaStore } from "./stores/media-store";
import type { NonceStore } from "./stores/nonce-store";
import type { PlaceStore } from "./stores/place-store";
import type { ProfileStore } from "./stores/profile-store";
import type { SettingsStore } from "./stores/settings-store";
import {
  ACCESS_STORE,
  BACKUP_RUN_STORE,
  BLOCKLIST_STORE,
  DB_CONNECTIONS,
  GEOCODE_CACHE_STORE,
  MAILBOX_STORE,
  MEDIA_STORE,
  NONCE_STORE,
  PLACE_STORE,
  PROFILE_STORE,
  SETTINGS_STORE,
  STORE,
  StoreModule,
} from "./stores/store.module";

/** The exit status after a restore: EX_TEMPFAIL, "come back", not a crash. */
const RESTART_EXIT_CODE = 75;

/**
 * The server's root module.
 *
 * `StoreModule` (global) is the custody spine: it constructs the durable store bundle behind the
 * factory (Postgres, via `BEACON_DATABASE_URL`) and exposes each store as a DI token (`STORE` /
 * `PROFILE_STORE` + the capability stores), draining them all on shutdown. Over that seam sit the
 * shell modules: Rooms (place/resolve/op REST + the timer-wheel + the socket.io gateway), Scouts
 * (the relay), Profiles (the revocation registry write-through cache), Discovery (spatial query +
 * signed descriptor), and Health (liveness/readiness), plus the opt-in capability modules (Mailbox,
 * Media, Geocode, Places) and the signed, never-advertised **admin** surface (`BEACON_ADMINS`
 * behind the shared AdminGate, `doc/spec/admin-api.md` §2). All game logic lives in `@beaconsgg/*`;
 * these are thin.
 */
@Module({
  imports: [StoreModule],
  controllers: [
    RoomsController,
    DiscoveryController,
    ScoutsController,
    ProfilesController,
    AccessController,
    MailboxController,
    MediaController,
    GeocodeController,
    PlacesController,
    PlacesAdminController,
    ContributionsController,
    AdminController,
    AccessAdminController,
    BackupController,
    HealthController,
    HomeController,
    AboutController,
  ],
  providers: [
    // Every HTTP refusal goes out through this, so a code newer than its caller is sent as the one
    // that caller already handles. See the filter.
    { provide: APP_FILTER, useClass: UnderstandsFilter },
    // Every HTTP write is refused while the server is locked read-only, by default: a route answers
    // only by carrying `@AllowWhileLocked()`, so one added without thought stays refused.
    { provide: APP_GUARD, useClass: WriteLockGuard },
    ServerIdentity,
    RoomsGateway,
    RoomsService,
    ScoutsService,
    ProfilesService,
    MailboxGateway,
    {
      // The environment, parsed once *for this module*. Every provider below takes it from here
      // rather than calling loadConfig() again. `main.ts` and `StoreModule` still parse their own
      // (both before this module resolves, both reading deploy-time fields only), so the claim is
      // "one snapshot behind the live view", not "one in the process.
      provide: BOOT_CONFIG,
      useFactory: (): ServerConfig => loadConfig(),
    },
    {
      // The environment that produced BOOT_CONFIG, for the one question the parsed config cannot
      // answer: whether a variable is exported at all (`doc/spec/runtime-settings.md` §5).
      provide: BOOT_ENV,
      useValue: process.env,
    },
    {
      // Operator-editable runtime settings (0022_settings, `doc/spec/runtime-settings.md`): the 42
      // policy fields of ServerConfig live in the database so an operator changes them with a
      // signed admin op instead of a redeploy. The environment still supplies every default, and
      // the presence of an override row is what decides whether a later env change lands.
      //
      // Loaded here, not in an init hook, so the stored settings are in force before anything can
      // read them: Nest awaits a provider's factory before building what depends on it and before
      // any init hook runs, and those hooks all start at once. A restart cannot lift a lock.
      provide: SettingsService,
      useFactory: async (store: SettingsStore, boot: ServerConfig): Promise<SettingsService> => {
        const settings = new SettingsService(store, runtimeSettingsFrom(boot));
        await settings.load();
        return settings;
      },
      inject: [SETTINGS_STORE, BOOT_CONFIG],
    },
    {
      // The live view (`doc/spec/runtime-settings.md` §5.1). Same shape and type as loadConfig()'s
      // result, but its runtime fields read the settings service per access, so everything below
      // sees an admin's change without a redeploy. **Inject this, never loadConfig().**
      provide: SERVER_CONFIG,
      useFactory: (
        boot: ServerConfig,
        settings: SettingsService,
        restored: RestoredIdentity | null,
      ): ServerConfig => {
        if (restored && restored.host !== boot.host) {
          new Logger("Config").log(
            `this server's name is ${restored.host}, from its restore; BEACON_HOST=${boot.host} is not used`,
          );
        }
        return createLiveConfig(restored ? { ...boot, host: restored.host } : boot, settings);
      },
      inject: [BOOT_CONFIG, SettingsService, RESTORED_IDENTITY],
    },
    {
      // Awaited here so the name and key are settled before anything mints an id or signs.
      provide: RESTORED_IDENTITY,
      useFactory: (connections: DbConnections): Promise<RestoredIdentity | null> =>
        withRunClient(connections, new AbortController().signal, readRestoredIdentity),
      inject: [DB_CONNECTIONS],
    },
    {
      // Store-backed sender blocklist (0009_admin): BEACON_BLOCKLIST seeds it at boot; admins
      // manage it live via admin.blocklist.* (`doc/spec/admin-api.md` §3). BEACON_ADMINS DIDs are
      // protected: the gate checks blocklist before allowlist, so a blocked admin could never reach
      // the op that unblocks them.
      provide: SenderBlocklist,
      useFactory: (store: BlocklistStore, cfg: ServerConfig): SenderBlocklist =>
        new SenderBlocklist(store, undefined, cfg.admins),
      inject: [BLOCKLIST_STORE, SERVER_CONFIG],
    },
    {
      // The member list a `request` or `private` server takes writes from (`0030_access`,
      // `doc/spec/admin-api.md` §6). It reads the level from the live config on every consult, so
      // a change to `accessLevel` applies to the next write.
      provide: MemberList,
      useFactory: (store: AccessStore, cfg: ServerConfig): MemberList =>
        new MemberList(store, cfg, cfg.admins),
      inject: [ACCESS_STORE, SERVER_CONFIG],
    },
    // The one bracket every signed request passes through: block + revocation, the two consults
    // that are true of every surface (`doc/spec/room-operation.md` §5). The revocation source is
    // bound by token rather than injected as a class, so `common/` stays clear of `profiles/`.
    { provide: DEVICE_REVOCATIONS, useExisting: ProfilesService },
    SignedRequestGate,
    WriteRateLimitGuard,
    ReadRateLimitGuard,
    PlayerReadRateLimitGuard,
    DescriptorRateLimitGuard,
    DidBudgets,
    {
      // Durable replay/idempotency log shared by the signed capabilities
      // (`doc/spec/mailbox-and-media.md` §3.2): mailbox, media, and the places admin surface; its
      // sweep runs when any of them is on. Retention ≥ the request freshness window so any
      // in-window replay is still remembered.
      provide: NonceService,
      useFactory: (nonces: NonceStore, cfg: ServerConfig): NonceService =>
        new NonceService(
          nonces,
          Object.assign(liveView(cfg, { writeLocked: "writeLocked" }), {
            // Unconditional (`doc/spec/runtime-settings.md` §3.4). This used to read a boot-derived
            // `signedSurfaceEnabled`, which only ever gated the **sweep** — `check`/`remember`
            // always ran, so replay protection was never the question. Once the capability toggles
            // became runtime, deriving it at boot meant an operator enabling the mailbox later left
            // its nonces accumulating with no sweep to age them out. An interval over an empty
            // table is cheaper than tracking that, so the condition is gone rather than made live.
            retentionMs: 2 * SIGNED_REQUEST_WINDOW_MS,
          }),
        ),
      inject: [NONCE_STORE, SERVER_CONFIG],
    },
    {
      // Built from config (mailbox knobs) over the injected durable store. Its TTL sweep runs on a
      // fixed interval and checks the capability per tick, because the toggle is runtime now. The
      // gateway is the live-channel push seam — the service broadcasts a delivered message after it
      // commits (beacon.core `doc/spec/mailbox-client.md` §3).
      provide: MailboxService,
      useFactory: (
        store: MailboxStore,
        gateway: MailboxGateway,
        cfg: ServerConfig,
      ): MailboxService =>
        new MailboxService(store, mailboxConfigFrom(cfg), () => Date.now(), gateway),
      inject: [MAILBOX_STORE, MailboxGateway, SERVER_CONFIG],
    },
    {
      // The blob byte backend, selected by config (`doc/spec/mailbox-and-media.md` §5.4).
      provide: MEDIA_BLOB,
      useFactory: (cfg: ServerConfig): MediaBlobStore => createMediaBlob(cfg),
      inject: [SERVER_CONFIG],
    },
    {
      // Media capability over the metadata store + blob backend (`doc/spec/mailbox-and-media.md`
      // §5).
      provide: MediaService,
      useFactory: (store: MediaStore, blob: MediaBlobStore, cfg: ServerConfig): MediaService =>
        new MediaService(store, blob, mediaConfigFrom(cfg)),
      inject: [MEDIA_STORE, MEDIA_BLOB, SERVER_CONFIG],
    },
    {
      // The server-wide operator allowlist (BEACON_ADMINS) behind the shared AdminGate — one list
      // gates every admin route (`doc/spec/admin-api.md` §2).
      provide: ADMINS,
      useFactory: (cfg: ServerConfig): string[] => cfg.admins,
      inject: [SERVER_CONFIG],
    },
    AdminGate,
    {
      // The operator's game-admission policy (BEACON_GAMES) behind the shared GameGate: one verdict
      // for every game write, the one rule every write path consults. A runtime setting, so this
      // reads through `gamesPolicyFrom` and must NOT be flattened to a copy: opening or closing
      // this server to a game is a signed admin write, not a redeploy. Slugs are still validated at
      // boot by loadConfig and on every admin write by the registry's gameSlugSchema.
      provide: GAMES_POLICY,
      useFactory: (cfg: ServerConfig): GamesPolicy => gamesPolicyFrom(cfg),
      inject: [SERVER_CONFIG],
    },
    GameGate,
    {
      // The admin.status assembly: descriptor facts (one source — ServerIdentity) + cheap counts
      // from every durable store.
      provide: AdminService,
      useFactory: (
        store: Store,
        profiles: ProfileStore,
        media: MediaStore,
        places: PlaceStore,
        identity: ServerIdentity,
        cfg: ServerConfig,
        members: MemberList,
      ): AdminService =>
        new AdminService(
          store,
          profiles,
          media,
          places,
          () => identity.descriptorFacts(),
          () => cfg.writeLocked,
          () => members.pendingCount(),
          cfg.mediaLimitBytes,
        ),
      inject: [
        STORE,
        PROFILE_STORE,
        MEDIA_STORE,
        PLACE_STORE,
        ServerIdentity,
        SERVER_CONFIG,
        MemberList,
      ],
    },
    {
      // Backups: the job log, a connection of its own, and what a backup reads. `start` hands back
      // a durable run and the work happens here in the process, as a place import's does.
      provide: BackupService,
      useFactory: (
        runs: BackupRunStore,
        connections: DbConnections,
        blobs: MediaBlobStore,
        settings: SettingsService,
        identity: ServerIdentity,
        config: ServerConfig,
        env: NodeJS.ProcessEnv,
        snapshots: SnapshotService,
      ): BackupService =>
        new BackupService(runs, {
          connections,
          blobs,
          settings,
          identity,
          config: {
            host: config.host,
            version: config.version,
            keyPassphrase: config.keyPassphrase,
            mediaLimitBytes: config.mediaLimitBytes,
            restoreDatabaseLimitBytes: config.restoreDatabaseLimitBytes,
          },
          env,
          bucket: { allowPrivateEndpoints: config.backupPrivateEndpoints },
          placeRunActive: () => snapshots.hasActiveRun(),
          // Non-zero, so a process manager restarting only on failure brings it back too.
          restart: () => process.exit(RESTART_EXIT_CODE),
        }),
      inject: [
        BACKUP_RUN_STORE,
        DB_CONNECTIONS,
        MEDIA_BLOB,
        SettingsService,
        ServerIdentity,
        SERVER_CONFIG,
        BOOT_ENV,
        SnapshotService,
      ],
    },
    {
      // The home page a browser gets at `/`: the live config and the descriptor's facts, the store
      // for readiness, the room counts where the store can give them (the Postgres one), and the
      // active-place count the console's overview shows.
      provide: HomeService,
      useFactory: (
        cfg: ServerConfig,
        identity: ServerIdentity,
        store: Store,
        places: PlaceStore,
      ): HomeService =>
        new HomeService(cfg, () => identity.descriptorFacts(), store, {
          rooms: roomActivityOf(store),
          placeCount: () => places.countActive(),
        }),
      inject: [SERVER_CONFIG, ServerIdentity, STORE, PLACE_STORE],
    },
    {
      // Geocode capability: a reverse-geocode provider (Nominatim) over the read-through cache
      // (`doc/spec/location-lookups.md` §4). Its TTL sweep checks the capability per tick, not at
      // boot.
      provide: GeocodeService,
      useFactory: (store: GeocodeCacheStore, cfg: ServerConfig): GeocodeService =>
        new GeocodeService(createGeocodeProvider(cfg), store, geocodeConfigFrom(cfg)),
      inject: [GEOCODE_CACHE_STORE, SERVER_CONFIG],
    },
    {
      // Places read path (`doc/spec/places.md` §5): serve the owned dataset, always — a pure store
      // read. Population lives on the SnapshotService below.
      provide: PlacesService,
      useFactory: (store: PlaceStore, cfg: ServerConfig): PlacesService =>
        new PlacesService(store, placesConfigFrom(cfg)),
      inject: [PLACE_STORE, SERVER_CONFIG],
    },
    {
      // The places run engine (`doc/spec/places.md` §6): admin-triggered population of the owned
      // dataset, from the three place inputs only (`apps/atlas/doc/spec/beacon-integration.md` §6).
      // No connector lives here — an Atlas import is a runtime, one-shot admin op
      // (`places.atlas.import`) that verifies and maps a volume during the run; the connector is
      // constructed then, used, and discarded, and the trust decision (the pinned publisher) lives
      // in the store beside the data it protects.
      provide: SnapshotService,
      useFactory: (
        store: PlaceStore,
        media: MediaService,
        identity: ServerIdentity,
        cfg: ServerConfig,
      ): SnapshotService => {
        const owner = (): typeof identity.account.did => identity.account.did;
        // Built unconditionally and offered conditionally. It used to be omitted outright when
        // media was off at boot, which is fine for an env-only toggle and wrong now that an
        // operator can turn media on at runtime (`doc/spec/runtime-settings.md` §3.4): the routes
        // would come up and snapshot runs would still have no way to fetch a photo. Construction is
        // cheap — an outbound client opens nothing until it is used.
        const transfer = new MediaTransfer(
          createMediaTransferOutbound(
            liveView(cfg, {
              userAgent: "geoUserAgent",
              timeoutMs: "placesImageTimeoutMs",
              minIntervalMs: "placesImageMinIntervalMs",
            }),
          ),
          media,
          owner,
          liveView(cfg, { maxBytes: "placesImageMaxBytes", timeoutMs: "placesImageTimeoutMs" }),
        );
        return new SnapshotService(store, snapshotConfigFrom(cfg), {
          // One transfer, and a volume's photos skip its pacing anyway: the Atlas connector hands
          // its own unpaced client over on `mediaTransport`, so there is no second instance here
          // to keep in step with the first.
          get mediaTransfer(): MediaTransfer | undefined {
            return cfg.mediaEnabled ? transfer : undefined;
          },
        });
      },
      inject: [PLACE_STORE, MediaService, ServerIdentity, SERVER_CONFIG],
    },
    // In-memory and per process: a survey is a convenience the operator can rerun.
    { provide: AtlasSurveys, useFactory: (): AtlasSurveys => new AtlasSurveys() },
    // The staging dir for uploaded Atlas archives (transient by design; swept at boot) and the
    // unpaced client Atlas runs use for tiles + media — a volume is static files that owe nobody
    // fairness, so it deliberately does not share the image budget's limiter.
    {
      provide: AtlasStaging,
      useFactory: (cfg: ServerConfig): AtlasStaging => new AtlasStaging(cfg.atlasStagingDir),
      inject: [SERVER_CONFIG],
    },
    {
      provide: ATLAS_OUTBOUND,
      useFactory: (cfg: ServerConfig): ReturnType<typeof atlasOutbound> =>
        atlasOutbound(liveView(cfg, { userAgent: "geoUserAgent", timeoutMs: "placesTimeoutMs" })),
      inject: [SERVER_CONFIG],
    },
    {
      provide: ATLAS_VOLUMES_DIR,
      useFactory: (cfg: ServerConfig): string | undefined => cfg.atlasVolumesDir,
      inject: [SERVER_CONFIG],
    },
    {
      // The places direct-curation admin surface: create, edit, conflicts, export and import.
      provide: PlacesAdminService,
      useFactory: (store: PlaceStore, cfg: ServerConfig): PlacesAdminService =>
        new PlacesAdminService(store, placesAdminConfigFrom(cfg)),
      inject: [PLACE_STORE, SERVER_CONFIG],
    },
    {
      // Player contributions (`doc/spec/place-proposals.md`): submissions land as pending proposals
      // and an operator's approval applies them as a `contrib` source. MediaService is passed only
      // as a presence check — a proposal may only reference photos THIS server can serve, so a
      // reviewer can always see what they're judging. With media off, photo-bearing submissions are
      // refused rather than silently accepted photo-less.
      provide: ContributionsService,
      useFactory: (
        store: PlaceStore,
        media: MediaService,
        identity: ServerIdentity,
        cfg: ServerConfig,
      ): ContributionsService =>
        new ContributionsService(
          store,
          contributionsConfigFrom(cfg),
          // A thunk, so turning media on at runtime stops photo-bearing submissions being refused.
          () => (cfg.mediaEnabled ? media : undefined),
          // Lazily — the identity's key resolves during module init, after this factory runs.
          () => identity.account.did,
        ),
      inject: [PLACE_STORE, MediaService, ServerIdentity, SERVER_CONFIG],
    },
  ],
})
export class AppModule {}
