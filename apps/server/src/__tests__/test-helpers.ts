import { Readable } from "node:stream";
import { createWallet, signOpWithWallet } from "@beaconsgg/identity";
import { HttpException } from "@nestjs/common";
import type { Room, ServerAccessLevel } from "@beaconsgg/protocol-types";
import { ulid } from "ulid";
import { AdminGate } from "../common/admin-gate";
import { SenderBlocklist } from "../common/blocklist";
import { GameGate } from "../common/game-gate";
import { MemberList } from "../common/member-list";
import { SignedRequestGate } from "../common/signed-request-gate";
import { DidBudgets } from "../common/did-budgets";
import { NonceService } from "../common/nonce.service";
import type { MediaBlobStore } from "../media/media-blob";
import { PlacesAdminService } from "../places/admin.service";
import { AtlasSurveys } from "../places/atlas-survey";
import { AtlasStaging } from "../places/atlas-staging";
import { PlacesService } from "../places/places.service";
import { ContributionsController } from "../places/contributions.controller";
import { ContributionsService, type MediaPresence } from "../places/contributions.service";
import { PlacesAdminController } from "../places/places-admin.controller";
import { SnapshotService } from "../places/snapshot.service";
import type { PlaceRecord, PlaceSourceRecord } from "../stores/place-store";
import {
  MemoryAccessStore,
  MemoryBlocklistStore,
  memoryNonces,
  MemoryPlaceStore,
} from "./memory-stores";
import { TEST_GAME } from "@beaconsgg/policy-engine/testing";

/** The HTTP status a controller promise rejects with (0 when it resolves) — shared across suites. */
export async function statusOf(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 0;
  } catch (err) {
    if (err instanceof HttpException) return err.getStatus();
    throw err;
  }
}

/**
 * The {@link HttpException} a rejecting call throws, so one call answers both "what status" and
 * "what code" (fails if it resolves). Takes a thunk rather than a promise so the sync controllers
 * (`ScoutsController.scout`) and the async ones share it; `await` on a non-promise is a no-op.
 */
export async function rejectedWith(fn: () => unknown): Promise<HttpException> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof HttpException) return err;
    throw err;
  }
  throw new Error("expected the call to reject");
}

/** A map-backed {@link MediaBlobStore} double — shared by every suite that fakes the byte backend. */
export function memoryBlobStore(): { blob: MediaBlobStore; blobs: Map<string, Buffer> } {
  const blobs = new Map<string, Buffer>();
  return {
    blobs,
    blob: {
      put: (hash, bytes) => {
        blobs.set(hash, bytes);
        return Promise.resolve();
      },
      locate: () => Promise.resolve(undefined),
      read: (hash) => {
        const bytes = blobs.get(hash);
        return Promise.resolve(bytes === undefined ? undefined : Readable.from([bytes]));
      },
      list: async function* () {
        for (const [hash, bytes] of blobs) yield { hash, size: bytes.length };
      },
      delete: (hash) => {
        blobs.delete(hash);
        return Promise.resolve();
      },
    },
  };
}

/** A minimal jar-shaped room at a point; every store treats `state` as opaque JSON. */
export function makeJarRoom(
  id: string,
  version = 1,
  lat = 47.6205,
  lng = -122.3493,
  contents: unknown[] = [],
): Room {
  return {
    id,
    type: "jar",
    version,
    location: { lat, lng },
    state: { contents },
    policy: { ops: {} },
    placedBy: "did:key:z6MkSmokeTestAccountKeyAbCdEfGhJkLm",
  } as Room;
}

export const PLACE_T0 = "2026-07-23T00:00:00.000Z";

/** A canonical-place fixture (Seattle cafe by default). */
export function makePlace(unique: string, over: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    unique,
    category: "sweets",
    name: "Blue Bottle",
    point: { lat: 47.61, lng: -122.33 },
    status: "active",
    createdAt: PLACE_T0,
    updatedAt: PLACE_T0,
    ...over,
  };
}

/** A matching osm source-record fixture. */
export function makeSource(
  placeUnique: string,
  over: Partial<PlaceSourceRecord> = {},
): PlaceSourceRecord {
  return {
    source: "osm",
    sourceId: `node/${placeUnique}`,
    placeUnique,
    fields: { category: "sweets", name: "Blue Bottle", point: { lat: 47.61, lng: -122.33 } },
    attribution: "© OpenStreetMap contributors (ODbL)",
    syncedAt: PLACE_T0,
    ...over,
  };
}

/** A controllable clock so time-dependent behavior is deterministic across suites. */
export function makeClock(startIso = "2026-07-23T00:00:00.000Z"): {
  now: () => number;
  advanceSeconds: (s: number) => number;
} {
  let ms = Date.parse(startIso);
  return { now: () => ms, advanceSeconds: (s: number) => (ms += s * 1000) };
}

export const TEST_ADMIN = "did:key:zAdmin";

/** The shared Seattle test bbox (matches the containment-vector park block). */
export const SEATTLE_BBOX = { minLat: 47.6, minLng: -122.34, maxLat: 47.62, maxLng: -122.32 };

/** The shared park polygon (the same ring the geo conformance vectors use). */
export const PARK_GEOMETRY = {
  type: "Polygon" as const,
  coordinates: [
    [
      [-122.34, 47.6],
      [-122.32, 47.6],
      [-122.32, 47.62],
      [-122.34, 47.62],
      [-122.34, 47.6],
    ] as [number, number][],
  ],
};

/**
 * A sender blocklist for a test: empty by default, or denying `denied` from construction (env seeds
 * deny before `onModuleInit`, so this needs no hydration). Every surface that consults admission
 * takes one, so a test that isn't about admission passes the empty one.
 */
export function testBlocklist(denied: string[] = []): SenderBlocklist {
  return new SenderBlocklist(new MemoryBlocklistStore(), denied);
}

/**
 * A {@link MemberList} for a test: an `open` server by default, which is the shipped default and so
 * what a suite that isn't about membership should be holding. `config` is held, not copied, so a
 * case can change the level the way the live setting would. Add members with `await list.add(...)`.
 */
export function testMemberList(
  config: { accessLevel: ServerAccessLevel } = { accessLevel: "open" },
  admins: string[] = [],
): MemberList {
  return new MemberList(new MemoryAccessStore(), config, admins);
}

/**
 * A {@link SignedRequestGate} for a test: nobody blocked and nothing revoked by default, which is what
 * a suite that isn't about admission should be holding. `revokedDevices` takes device DIDs, since
 * that is what the consult keys on once the owner's account is established by the signature.
 *
 * The profile registry is a double rather than a real {@link ProfilesService}, so a suite can revoke
 * a device without publishing a whole signed profile to say so. The real registry path is exercised
 * end to end in `signed-request-gate.test.ts`, which is where that belongs.
 */
export function testSignedRequestGate(
  opts: { blocklist?: SenderBlocklist; revokedDevices?: string[]; members?: MemberList } = {},
): SignedRequestGate {
  const revoked = opts.revokedDevices ?? [];
  // `testBlocklist()` by default, so an ambient `BEACON_BLOCKLIST` cannot reach a suite that never
  // asked for one; the two suites that seed a block that way pass `testBlocklistFromEnv()`.
  return new SignedRequestGate(
    opts.blocklist ?? testBlocklist(),
    { isRevoked: (_account, device) => revoked.includes(device) },
    opts.members ?? testMemberList(),
  );
}

/**
 * A blocklist seeded from `BEACON_BLOCKLIST` the way production constructs one. Only the mailbox
 * and media suites want this: they set the env var and rebuild, which is how they exercise a block.
 */
export function testBlocklistFromEnv(): SenderBlocklist {
  return new SenderBlocklist(new MemoryBlocklistStore());
}

/**
 * A {@link GameGate} for a test: **open to every game by default**, which is the shipped default
 * and therefore what a test that isn't about game admission should be holding. Pass `admitted` to
 * close it to a list. A write naming no game is refused either way.
 */
export function testGameGate(admitted: string[] = []): GameGate {
  return new GameGate({ admitted });
}

/** The game the test helpers sign as, so every write names one: the engine suites' own. */
export { TEST_GAME };

/**
 * Fresh {@link DidBudgets} built under `knobs`, which are read at construction and then restored to
 * whatever they were (not blindly deleted, so a suite that sets one globally keeps it).
 */
export function budgetsWith(knobs: Record<string, string>): DidBudgets {
  const prior = Object.keys(knobs).map((k) => [k, process.env[k]] as const);
  Object.assign(process.env, knobs);
  try {
    return new DidBudgets();
  } finally {
    for (const [k, v] of prior) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/**
 * The places controller graph, wired for a test — the DI the three places suites all need
 * (admin routes, `places.create`, and contributions). Every store in it is in memory, so there is
 * nothing to close and a caller just destructures what it needs.
 *
 * `admins` defaults to the returned `admin` wallet, and `stranger` is a second wallet that is never
 * on the allowlist — the 403 case every admin suite needs.
 */
export function placesHarness(
  opts: {
    /** `BEACON_PLACES` (default on). Off ⇒ every places route 404s as absent. */
    placesEnabled?: boolean;
    /** `BEACON_PLACES_PROPOSALS` (default on). Off ⇒ submissions refused, queue still reviewable. */
    contributions?: boolean;
    admins?: string[];
    /** Media presence double; omit for "media capability off" (photo submissions refused). */
    media?: MediaPresence;
    maxPending?: number;
    rateMax?: number;
    /** `BEACON_ATLAS_VOLUMES_DIR` — the mounted tree root that enables `path` imports. */
    atlasVolumesDir?: string;
    /** Serves hosted-volume URLs for suites that exercise the controller's own URL handling. */
    atlasGetText?: (url: string) => Promise<string>;
    /** `BEACON_PLACES_PROPOSALS_EXPORT` (default OFF, as in production). */
    contribExport?: boolean;
    /** The operator's admitted game slugs; empty (the default) leaves the app gate open. */
    games?: string[];
    /** Treat the harness's own `stranger` as having revoked the device it signs with. */
    revokedStranger?: boolean;
  } = {},
) {
  const placesEnabled = opts.placesEnabled ?? true;
  const admin = createWallet();
  const stranger = createWallet();
  const store = new MemoryPlaceStore();
  const snapshots = new SnapshotService(
    store,
    { enabled: placesEnabled, cellPrecision: 6, host: "test.example", writeLocked: false },
    {},
  );
  const nonce = new NonceService(memoryNonces(), { retentionMs: 10 * 60_000, writeLocked: false });
  const adminService = new PlacesAdminService(store, {
    host: "test.example",
    cellPrecision: 6,
    contribExportEnabled: opts.contribExport ?? false,
  });
  const contributions = new ContributionsService(
    store,
    {
      // ANDed exactly as `loadConfig` does, so the harness can't build a config the loader can't.
      submissionsEnabled: placesEnabled && (opts.contributions ?? true),
      cellPrecision: 6,
      rateMax: opts.rateMax ?? 20,
      rateWindowMs: 60_000,
      maxPending: opts.maxPending ?? 10,
    },
    () => opts.media,
    () => "did:key:zServerTest",
  );
  const staging = new AtlasStaging();
  const signed = testSignedRequestGate({
    revokedDevices: opts.revokedStranger ? [stranger.device.did] : [],
  });
  const gate = new AdminGate(signed, nonce, opts.admins ?? [admin.account.did]);
  return {
    admin,
    staging,
    stranger,
    store,
    snapshots,
    controller: new PlacesAdminController(
      snapshots,
      adminService,
      gate,
      nonce,
      contributions,
      staging,
      new AtlasSurveys(),
      // A never-fetching outbound double unless a suite serves URLs itself: URL imports in unit
      // suites otherwise use fakes at the reader layer.
      {
        http: {
          getText: opts.atlasGetText ?? (() => Promise.reject(new Error("no network in tests"))),
        },
        limiter: { schedule: <T>(fn: () => Promise<T>) => fn() },
      } as never,
      opts.atlasVolumesDir,
    ),
    contributionsController: new ContributionsController(
      contributions,
      signed,
      testGameGate(opts.games ?? []),
      nonce,
    ),
    /** The public read side, so a suite can assert what a contribution actually did to a place. */
    reads: new PlacesService(store, {
      enabled: placesEnabled,
      cellPrecision: 6,
      pageSize: 50,
      queryMaxCells: 64,
    }),
  };
}

/** A test wallet — declared once rather than in each suite. */
export type TestWallet = ReturnType<typeof createWallet>;

/**
 * A signed `OpEnvelope` for a test wallet — the shape every places suite was re-declaring. Signed as
 * {@link TEST_GAME} unless told otherwise, since every game write names its game; `null` signs one
 * that names none, which is an operator console's envelope.
 */
export function signedEnv(
  wallet: TestWallet,
  op: string,
  params: Record<string, unknown> = {},
  nonce: string = ulid(),
  game: string | null = TEST_GAME,
): ReturnType<typeof signOpWithWallet> {
  // Signed WITH the slug, never stamped on afterwards: a slug added after the signature is a
  // tampered envelope and would 401 before any gate saw it.
  return signOpWithWallet(wallet, { op, nonce, params, ...(game !== null ? { game } : {}) });
}
