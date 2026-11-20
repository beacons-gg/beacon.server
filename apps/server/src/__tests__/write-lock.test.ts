import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWallet } from "@beaconsgg/identity";
import { nowSeconds } from "@beaconsgg/policy-engine";
import { InMemoryStore, timedPotPolicy } from "@beaconsgg/policy-engine/testing";
import type { Policy, Room } from "@beaconsgg/protocol-types";
import type { ExecutionContext, INestApplication } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import type { PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../app.module";
import { DidBudgets } from "../common/did-budgets";
import { NonceService } from "../common/nonce.service";
import { WriteLockGuard } from "../common/write-lock.guard";
import type { GeocodeProvider } from "../geocode/geocode-provider";
import { GeocodeService, type GeocodeConfig } from "../geocode/geocode.service";
import { MailboxService, type MailboxConfig } from "../mailbox/mailbox.service";
import type { MediaBlobStore } from "../media/media-blob";
import { MediaService, type MediaConfig } from "../media/media.service";
import { ProfilesService } from "../profiles/profiles.service";
import type { RoomsGateway } from "../rooms/rooms.gateway";
import { RoomsService } from "../rooms/rooms.service";
import { SettingsService } from "../settings/settings.service";
import type { ServerIdentity } from "../server-identity";
import { createStores, type StoreBundle } from "../stores/store.factory";
import { memoryBlobStore, testBlocklist, testGameGate, testMemberList } from "./test-helpers";
import {
  MemoryAccessStore,
  MemoryBlocklistStore,
  memoryGeocodeCache,
  memoryMailbox,
  memoryMedia,
  memoryNonces,
  MemoryPlaceStore,
  memoryProfiles,
  MemoryBackupRunStore,
  MemorySettingsStore,
} from "./memory-stores";

/**
 * The read-only lock: a global guard that fails closed, background writers that wait, and GET
 * routes that keep answering without writing.
 *
 * The HTTP half boots the **real `AppModule`** through Nest, so the route table it walks is the one
 * the server mounts, and the guard, the filter and the live config are the server's own. Only the
 * store factory is replaced: a booted app takes the database's writer lock, which would contend with
 * `writer-lock`'s cases on the shared test database and race the parity suites' truncates.
 *
 * Vitest compiles with esbuild, which emits no `design:paramtypes`, so a provider's dependencies
 * that are not written with `@Inject` arrive undefined. That is why these cases ask only what the
 * guard decided, a 503 or not, and never what a handler went on to do, and why an unlock here goes
 * through the real `SettingsService`, whose factory wires it by token.
 */
vi.mock("../stores/store.factory", () => ({ createStores: vi.fn() }));

const ADMIN = createWallet();
const DAY = 86_400;

const POT_POLICY: Policy = timedPotPolicy({
  lockDelaySec: DAY,
  unlockDelaySec: DAY,
  claimTtl: "7d",
});

/** A pot still `filling`: past `lockAt` it is due, and the only thing that moves it is the wheel. */
function filling(id: string, lockAt: number): Room {
  return {
    id,
    type: "pot",
    version: 1,
    location: { lat: 47.61, lng: -122.34 },
    state: {
      contents: [],
      contributors: { a: [] },
      claimed: [],
      phase: "filling",
      lockAt,
      unlockAt: lockAt + 30 * DAY,
    },
    policy: POT_POLICY,
    placedBy: "did:key:z6MkSmokeTestAccountKeyAbCdEfGhJkLm",
  } as Room;
}

const phaseOf = async (store: InMemoryStore, id: string): Promise<unknown> =>
  (await store.getRoom(id))?.state["phase"];

/** The memory stores an `AppModule` boots on, with the rooms and settings a case wants to see. */
function storeBundle(store: InMemoryStore, settings: MemorySettingsStore): StoreBundle {
  return {
    store,
    settings,
    profiles: memoryProfiles(),
    mailbox: memoryMailbox(),
    media: memoryMedia(),
    nonces: memoryNonces(),
    geocodeCache: memoryGeocodeCache(),
    places: new MemoryPlaceStore(),
    blocklist: new MemoryBlocklistStore(),
    access: new MemoryAccessStore(),
    backupRuns: new MemoryBackupRunStore(),
    // Only boot's read of the restored identity comes here: a server that was never restored.
    connections: {
      connect: () =>
        Promise.resolve({
          query: () => Promise.resolve({ rows: [] }),
          on: () => undefined,
          off: () => undefined,
          release: () => undefined,
        } as unknown as PoolClient),
    },
    close: () => Promise.resolve(),
  };
}

/** Every POST route Express has mounted, as a path a request can hit. */
function postPaths(app: INestApplication): string[] {
  interface Layer {
    route?: { path: string; methods: Record<string, boolean> };
  }
  const { _router } = app.getHttpAdapter().getInstance() as { _router: { stack: Layer[] } };
  return _router.stack.flatMap((layer) =>
    layer.route?.methods["post"] ? [layer.route.path.replace(/:\w+/g, "x")] : [],
  );
}

describe("the write lock over a real app", () => {
  let app: INestApplication | undefined;

  let stagingDir: string | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.unstubAllEnvs();
    if (stagingDir) await rm(stagingDir, { recursive: true, force: true });
    stagingDir = undefined;
  });

  /** Boot the real module on memory stores and listen on an ephemeral port. */
  async function boot(store: InMemoryStore, settings: MemorySettingsStore): Promise<string> {
    vi.mocked(createStores).mockResolvedValue(storeBundle(store, settings));
    vi.stubEnv("BEACON_DATABASE_URL", "postgres://unused@127.0.0.1:1/unused");
    vi.stubEnv("BEACON_ADMINS", ADMIN.account.did);
    // A booting app sweeps its Atlas staging directory, so it must not be the shared default that
    // the Atlas suites are staging into at this moment.
    stagingDir = await mkdtemp(join(tmpdir(), "beacon-write-lock-"));
    vi.stubEnv("BEACON_ATLAS_STAGING_DIR", stagingDir);
    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    return app.getUrl();
  }

  const post = (base: string, path: string, body: unknown = {}): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  /**
   * The test the guard is for. It reads the routes off Express rather than off a list, so a route
   * added tomorrow is in this walk and is refused until somebody writes `@AllowWhileLocked()` on it,
   * which then fails this exact-match assertion and makes them say so in the diff.
   */
  it("refuses every POST route on a locked server except the ones decorated to pass", async () => {
    vi.stubEnv("BEACON_WRITE_LOCK", "1");
    const base = await boot(new InMemoryStore(), new MemorySettingsStore());

    const paths = postPaths(app as INestApplication);
    // Without this, a Nest or Express upgrade that moved the stack would make the walk vacuous.
    expect(paths.length).toBeGreaterThan(30);
    expect(paths).toContain("/rooms");
    expect(paths).toContain("/admin/rooms/remove");

    const passed: string[] = [];
    for (const path of paths) {
      const res = await post(base, path);
      if (res.status !== 503) {
        passed.push(path);
        continue;
      }
      expect(res.headers.get("retry-after"), path).toBe("60");
      expect(await res.json(), path).toMatchObject({ ok: false, error: "writeLocked" });
    }

    expect(passed.sort()).toEqual([
      "/admin/backup/runs",
      "/admin/backup/start",
      "/admin/restore/inspect",
      "/admin/restore/start",
      "/admin/settings/get",
      "/admin/settings/reset",
      "/admin/settings/set",
      "/admin/status",
      "/places/admin/snapshots/cancel",
      "/places/admin/snapshots/fetch",
    ]);
  });

  it("keeps answering reads while locked", async () => {
    vi.stubEnv("BEACON_WRITE_LOCK", "1");
    const base = await boot(new InMemoryStore(), new MemorySettingsStore());
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/health`, { method: "HEAD" })).status).toBe(200);
    expect((await fetch(`${base}/health`, { method: "OPTIONS" })).status).not.toBe(503);
  });

  it("takes and lifts the lock on the next request, with no restart", async () => {
    const base = await boot(new InMemoryStore(), new MemorySettingsStore());
    const settings = (app as INestApplication).get(SettingsService);

    expect((await post(base, "/rooms")).status).not.toBe(503);

    await settings.set("writeLocked", true, ADMIN.account.did);
    const refused = await post(base, "/rooms");
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("60");

    await settings.set("writeLocked", false, ADMIN.account.did);
    expect((await post(base, "/rooms")).status).not.toBe(503);
  });

  /**
   * The boot-order case. Nest starts every provider's init hook at once, so without the provider
   * factory awaiting the settings read, the wheel armed by `RoomsService` fires on an already-due
   * room while the stored lock is still on its way back from the database. The delay makes that
   * race certain instead of occasional.
   */
  it("has the stored lock in force before the wheel can move a room at boot", async () => {
    const settings = new MemorySettingsStore();
    await settings.put({
      key: "writeLocked",
      value: true,
      updatedBy: ADMIN.account.did,
      updatedAt: new Date().toISOString(),
    });
    const read = settings.all.bind(settings);
    settings.all = async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return read();
    };
    const store = new InMemoryStore();
    await store.commit([{ kind: "putRoom", room: filling("due@h", nowSeconds(Date.now()) - 10) }]);

    await boot(store, settings);
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(await phaseOf(store, "due@h")).toBe("filling");
  });
});

describe("the guard's edges", () => {
  const guard = (writeLocked: boolean): WriteLockGuard =>
    new WriteLockGuard(new Reflector(), { writeLocked });

  const http = (method: string): ExecutionContext =>
    ({
      getType: () => "http",
      getHandler: () => function undecorated() {},
      switchToHttp: () => ({
        getRequest: () => ({ method }),
        getResponse: () => ({ setHeader: () => undefined }),
      }),
    }) as unknown as ExecutionContext;

  it("passes a socket gateway, which is never a write", () => {
    expect(guard(true).canActivate({ getType: () => "ws" } as unknown as ExecutionContext)).toBe(
      true,
    );
  });

  it("does nothing at all while unlocked", () => {
    expect(guard(false).canActivate(http("POST"))).toBe(true);
    expect(guard(false).canActivate(http("DELETE"))).toBe(true);
  });

  it("treats a write method other than POST the same way, so a future PUT is covered", () => {
    expect(() => guard(true).canActivate(http("PUT"))).toThrow(/locked read-only/);
    expect(() => guard(true).canActivate(http("DELETE"))).toThrow(/locked read-only/);
    expect(guard(true).canActivate(http("OPTIONS"))).toBe(true);
  });
});

describe("background writers wait out a lock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A real RoomsService on the memory store, and the mutable config a settings write stands for. */
  async function wheel(store: InMemoryStore) {
    const config = { writeLocked: true };
    const service = new RoomsService(
      { broadcast: () => undefined, broadcastMap: () => undefined } as unknown as RoomsGateway,
      { config: { host: "beacon.test" } } as unknown as ServerIdentity,
      new ProfilesService(testBlocklist()),
      testBlocklist(),
      testMemberList(),
      testGameGate(),
      new DidBudgets(),
      store,
      config,
    );
    await service.onModuleInit();
    return { service, config };
  }

  it("holds due rooms in the wheel while locked and fires them after an unlock, without a restart", async () => {
    vi.useFakeTimers();
    const store = new InMemoryStore();
    const now = nowSeconds(Date.now());
    await store.commit([
      { kind: "putRoom", room: filling("overdue@h", now - 10) },
      // Comes due only once the lock is on, which is the case a boot-time seed cannot cover.
      { kind: "putRoom", room: filling("during@h", now + 30) },
    ]);
    const { service, config } = await wheel(store);

    // If a locked wake re-armed itself this would hit the fake timer loop limit and throw.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(await phaseOf(store, "overdue@h")).toBe("filling");
    expect(await phaseOf(store, "during@h")).toBe("filling");

    config.writeLocked = false;
    // One reconcile, then the wake it arms.
    await vi.advanceTimersByTimeAsync(61_000);
    expect(await phaseOf(store, "overdue@h")).not.toBe("filling");
    expect(await phaseOf(store, "during@h")).not.toBe("filling");

    service.onModuleDestroy();
  });

  const sweeps: Array<
    [
      string,
      (cfg: { writeLocked: boolean }) => { start(): void; stop(): void; swept: () => number },
    ]
  > = [
    [
      "nonce",
      (cfg) => {
        const store = memoryNonces();
        const spy = vi.spyOn(store, "sweepExpired");
        const svc = new NonceService(
          store,
          Object.defineProperties(
            { retentionMs: 1000 },
            { writeLocked: { get: () => cfg.writeLocked } },
          ) as { retentionMs: number; writeLocked: boolean },
        );
        return {
          start: () => svc.onModuleInit(),
          stop: () => svc.onModuleDestroy(),
          swept: () => spy.mock.calls.length,
        };
      },
    ],
    [
      "mailbox",
      (cfg) => {
        const store = memoryMailbox();
        const spy = vi.spyOn(store, "sweepExpired");
        const svc = new MailboxService(store, {
          enabled: true,
          ttlSeconds: 60,
          maxBody: 256,
          sendMax: 60,
          sendWindowMs: 60_000,
          get writeLocked() {
            return cfg.writeLocked;
          },
        } satisfies MailboxConfig);
        return {
          start: () => svc.onModuleInit(),
          stop: () => svc.onModuleDestroy(),
          swept: () => spy.mock.calls.length,
        };
      },
    ],
    [
      "geocode",
      (cfg) => {
        const store = memoryGeocodeCache();
        const spy = vi.spyOn(store, "sweepExpired");
        const svc = new GeocodeService(unusedProvider(), store, {
          enabled: true,
          precision: 7,
          ttlSeconds: 60,
          negativeTtlSeconds: 60,
          get writeLocked() {
            return cfg.writeLocked;
          },
        } satisfies GeocodeConfig);
        return {
          start: () => svc.onModuleInit(),
          stop: () => svc.onModuleDestroy(),
          swept: () => spy.mock.calls.length,
        };
      },
    ],
  ];

  it.each(sweeps)("skips the %s sweep while locked and resumes after", (_name, build) => {
    vi.useFakeTimers();
    const cfg = { writeLocked: true };
    const sweep = build(cfg);
    sweep.start();
    vi.advanceTimersByTime(180_000);
    expect(sweep.swept()).toBe(0);

    cfg.writeLocked = false;
    vi.advanceTimersByTime(60_000);
    expect(sweep.swept()).toBe(1);
    sweep.stop();
  });
});

function unusedProvider(): GeocodeProvider {
  return { id: "test", attribution: "test", reverse: () => Promise.resolve(undefined) };
}

describe("reads still answer and write nothing while locked", () => {
  const MEDIA: Omit<MediaConfig, "writeLocked"> = {
    enabled: true,
    host: "test.example",
    maxBytes: 1_000,
    types: ["image/webp"],
    quotaBytes: 1_000,
    rateMax: 10,
    rateWindowMs: 60_000,
  };

  it("serves media without stamping last_access_at, and stamps again after an unlock", async () => {
    const store = memoryMedia();
    await store.put({
      hash: "h1",
      type: "image/webp",
      size: 1,
      owner: "did:key:zOwner",
      uploadedAt: new Date(0).toISOString(),
      lastAccessAt: null,
      reviewedAt: null,
      reviewedBy: null,
    });
    const touch = vi.spyOn(store, "touch");
    const blob: MediaBlobStore = {
      ...memoryBlobStore().blob,
      locate: () => Promise.resolve({ kind: "redirect", url: "https://cdn.example/h1" }),
    };
    const cfg = { ...MEDIA, writeLocked: true };
    const service = new MediaService(store, blob, cfg);

    expect(await service.get("h1")).toMatchObject({ type: "image/webp" });
    expect(touch).not.toHaveBeenCalled();

    cfg.writeLocked = false;
    await service.get("h1");
    expect(touch).toHaveBeenCalledOnce();
  });

  it("answers a geocode lookup without caching it, and caches again after an unlock", async () => {
    const store = memoryGeocodeCache();
    const put = vi.spyOn(store, "put");
    const reverse = vi.fn().mockResolvedValue({ city: "Seattle" });
    const provider: GeocodeProvider = { id: "test", attribution: "test", reverse };
    const cfg = {
      enabled: true,
      precision: 5,
      ttlSeconds: 60,
      negativeTtlSeconds: 60,
      writeLocked: true,
    };
    const service = new GeocodeService(provider, store, cfg);

    expect(await service.lookup("c23nb")).toMatchObject({ ok: true, cached: false });
    expect(put).not.toHaveBeenCalled();

    cfg.writeLocked = false;
    expect(await service.lookup("c23nb")).toMatchObject({ ok: true, cached: false });
    expect(put).toHaveBeenCalledOnce();
    expect(await service.lookup("c23nb")).toMatchObject({ ok: true, cached: true });
    expect(reverse).toHaveBeenCalledTimes(2); // the locked read asked the provider, and was not stored
  });
});
