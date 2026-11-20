import { describe, expect, it, vi } from "vitest";
import { DidRateLimiter } from "../common/did-rate-limit";
import { gamesPolicyFrom } from "../common/game-gate";
import { OutboundHttp, OutboundLimiter, type FetchImpl } from "../common/outbound-http";
import { type ServerConfig } from "../config";
import { geocodeConfigFrom } from "../geocode/geocode.service";
import { MailboxService, mailboxConfigFrom } from "../mailbox/mailbox.service";
import { createMediaBlob } from "../media/media-blob";
import { mediaConfigFrom } from "../media/media.service";
import { placesAdminConfigFrom } from "../places/admin.service";
import { contributionsConfigFrom } from "../places/contributions.service";
import { placesConfigFrom } from "../places/places.service";
import type { MediaTransfer } from "../media/media-transfer";
import { SnapshotService, snapshotConfigFrom } from "../places/snapshot.service";
import { createLiveConfig } from "../settings/live-config";
import {
  DEPLOY_TIME_KEYS,
  RUNTIME_SETTING_KEYS,
  SETTING_SPECS,
  runtimeSettingsFrom,
  type RuntimeSettingKey,
} from "../settings/registry";
import { SettingsService } from "../settings/settings.service";
import { testConfig } from "./test-config";
import { MemorySettingsStore } from "./memory-stores";

/**
 * The claim these tests demonstrate rather than assert (`doc/spec/runtime-settings.md` §5): **a
 * change takes effect without a restart**. A storable setting moves nothing on its own if every
 * consumer has already copied its value out of `loadConfig()` at boot.
 *
 * So these tests are deliberately not about the view's internals. They set a setting the way an
 * admin op will and then read the thing the request path reads.
 */

const ADMIN = "did:key:zAdmin";

/**
 * A baseline with the places family on, so a single-key change is always a legal configuration.
 *
 * Places is on and contributions off, which is the one baseline from which *every* individual key
 * can move in some direction without tripping a prerequisite: turning contributions on is legal
 * because places is on, and turning places off is legal because contributions is off.
 */
function baseline(): ServerConfig {
  return testConfig({
    BEACON_PLACES: "true",
    BEACON_MAILBOX: "true",
    BEACON_MEDIA: "true",
    BEACON_GEOCODE: "true",
  } as NodeJS.ProcessEnv);
}

async function liveOver(boot: ServerConfig): Promise<{
  config: ServerConfig;
  settings: SettingsService;
}> {
  const settings = new SettingsService(new MemorySettingsStore(), runtimeSettingsFrom(boot));
  await settings.load();
  return { config: createLiveConfig(boot, settings), settings };
}

/**
 * A value this key will accept that differs from `current`.
 *
 * Candidates rather than a type switch, because the schemas are the authority on what a key accepts
 * and several of them are much narrower than their TypeScript type (`publicUrl` is an http(s) URL,
 * `coverage` is geohashes, `mediaTypes` are MIME types). Whatever the schema takes first, wins.
 */
function probeFor(key: RuntimeSettingKey, current: unknown): unknown | undefined {
  // An enum knows its own legal values, and guessing at them is how `accessLevel` (open | request |
  // private) would silently land on the exemption list instead of being exercised.
  const options = (SETTING_SPECS[key].schema as { options?: readonly unknown[] }).options;
  // One candidate per shape (two for arrays, which are either geohashes or MIME types). Deliberately
  // no fallback ladder: a spare candidate that happens to parse would silently rescue a key whose
  // accessor had stopped working, which is the exact regression this file exists to catch.
  const candidates: unknown[] = options
    ? [...options]
    : typeof current === "boolean"
      ? [!current]
      : typeof current === "number"
        ? [current - 1]
        : Array.isArray(current)
          ? [["9q8y"], ["text/plain"]]
          : ["https://probe.example/x"];

  for (const candidate of candidates) {
    if (!SETTING_SPECS[key].schema.safeParse(candidate).success) continue;
    if (JSON.stringify(candidate) !== JSON.stringify(current)) return candidate;
  }
  return undefined;
}

/**
 * Keys no probe can move, with the reason. A key may only be here because its schema admits exactly
 * one value, which the test checks rather than takes on trust — otherwise this list would be a place
 * to quietly park a key that stopped working.
 */
const SINGLE_VALUED: readonly RuntimeSettingKey[] = ["geocodeProvider"];

describe("the live config view carries an admin change to the reader", () => {
  it("reports a new value for every runtime setting, with no restart", async () => {
    const stale: string[] = [];

    for (const key of RUNTIME_SETTING_KEYS) {
      // A fresh service per key, so each change is measured against the baseline rather than
      // against whatever the previous iteration left behind.
      const { config, settings } = await liveOver(baseline());
      const before = config[key];
      const probe = probeFor(key, before);

      if (probe === undefined) {
        // Nothing to set. Legitimate only when the schema admits a single value.
        if (!SINGLE_VALUED.includes(key)) stale.push(`${key} (no probe value)`);
        continue;
      }

      await settings.set(key, probe, ADMIN);
      if (JSON.stringify(config[key]) !== JSON.stringify(probe)) {
        stale.push(`${key} (still ${JSON.stringify(before)})`);
      }
    }

    expect(stale).toEqual([]);
  });

  it("admits exactly one value for every key the sweep above could not move", async () => {
    const { config } = await liveOver(baseline());

    for (const key of SINGLE_VALUED) {
      // If a second value ever becomes legal, the key belongs in the sweep, not on the exemption
      // list — so this fails the moment the exemption stops being true.
      expect(probeFor(key, config[key])).toBeUndefined();
    }
  });

  it("holds every deploy-time setting at its boot value", async () => {
    const boot = baseline();
    const { config } = await liveOver(boot);

    for (const key of DEPLOY_TIME_KEYS) {
      expect(config[key]).toEqual(boot[key]);
    }
  });

  it("has exactly the keys the boot config has, present and absent alike", async () => {
    const boot = baseline();
    const { config } = await liveOver(boot);

    // The view is built key by key rather than spread, so it could drift from `loadConfig`'s own
    // shape. It must never *lose* a key: a deploy-time field boot assigns as present-and-undefined
    // (`mnemonic`, always assigned) has to survive the `in` filter that keeps genuinely absent
    // optional keys absent.
    const missing = Object.keys(boot).filter((k) => !(k in config));
    expect(missing).toEqual([]);

    // It may hold *more*, and exactly one kind more: an **optional runtime** key that is currently
    // unset. `loadConfig` only assigns `description` / `contact` / `mediaCdnUrl` when they have a
    // value, whereas an accessor cannot be conditionally absent — and must not be, because an admin
    // can set one of these at runtime and the key has to appear when they do. So the extras are
    // present with value `undefined`, which every reader already treats as unset.
    const extra = Object.keys(config).filter((k) => !(k in boot));
    for (const key of extra) {
      expect(RUNTIME_SETTING_KEYS).toContain(key);
      expect(config[key as RuntimeSettingKey]).toBeUndefined();
    }
  });
});

describe("derived fields recompute from the live toggles", () => {
  it("advertises a capability the moment an admin turns it on", async () => {
    const boot = testConfig();
    const { config, settings } = await liveOver(boot);
    expect(config.capabilities).not.toContain("mailbox");

    await settings.set("mailboxEnabled", true, ADMIN);

    // The half that is easy to miss: deriving this at boot changed the routes and not the signed
    // descriptor, so the network kept reading a server that said it had no mailbox.
    expect(config.capabilities).toContain("mailbox");
  });

  it("withdraws a capability when it is turned off", async () => {
    const { config, settings } = await liveOver(baseline());
    expect(config.capabilities).toContain("places");

    await settings.set("placesEnabled", false, ADMIN);

    expect(config.capabilities).not.toContain("places");
  });

  it("tracks the admitted game list, which rides the same capability array", async () => {
    const { config, settings } = await liveOver(baseline());
    expect(config.capabilities).not.toContain("game:kites");

    await settings.set("games", ["kites"], ADMIN);

    expect(config.capabilities).toContain("game:kites");
  });

  it("does not advertise places-proposals once the environment drops places underneath it", async () => {
    // The restart path from `doc/spec/runtime-settings.md` §4.1, which is the one an operator
    // actually hits: turn contributions on with places enabled, then set BEACON_PLACES=0 in the
    // compose file and redeploy over the row. (Turning places off with `set` in the same process is
    // *refused*, which is why the admin op takes several keys in one signed write.)
    const store = new MemorySettingsStore();
    const on = new SettingsService(store, runtimeSettingsFrom(baseline()));
    await on.load();
    await on.set("placesContributionsEnabled", true, ADMIN);
    expect(createLiveConfig(baseline(), on).capabilities).toContain("places-proposals");

    const bootWithoutPlaces = testConfig();
    const after = new SettingsService(store, runtimeSettingsFrom(bootWithoutPlaces));
    await after.load();
    const config = createLiveConfig(bootWithoutPlaces, after);

    // The dependent is coerced off in the assembled view, so the signed descriptor cannot advertise
    // a submission surface the contributions route would 404.
    expect(config.capabilities).not.toContain("places-proposals");
    expect(config.capabilities).not.toContain("places");
  });
});

describe("mediaMaxBytes is bounded by what the boot body parser can accept (runtime-settings.md §3.4)", () => {
  it("lets an admin lower it, which the service can honour", async () => {
    const { config, settings } = await liveOver(baseline());
    const boot = config.mediaMaxBytes;

    await settings.set("mediaMaxBytes", boot - 1000, ADMIN);

    expect(config.mediaMaxBytes).toBe(boot - 1000);
  });

  it("clamps a raise, so the reported limit is one the server can actually enforce", async () => {
    const bootCfg = baseline();
    const { config, settings } = await liveOver(bootCfg);

    await settings.set("mediaMaxBytes", bootCfg.mediaMaxBytes * 10, ADMIN);

    // `main.ts` sized the JSON body parser from the boot value and body-parser reads its limit once,
    // so a larger upload is rejected by the parser before MediaService ever sees it. Reporting the
    // raised number would be reporting a limit the server cannot honour.
    expect(config.mediaMaxBytes).toBe(bootCfg.mediaMaxBytes);
    // The clamp lives in `reconcileRuntimeSettings`, not in the view, so `value` means "in force"
    // here exactly as it does for a coerced prerequisite, and `storedValue` carries the admin's
    // intent. A console reading the state can therefore say *why* the two differ; when the clamp
    // lived in the view, `SettingsService` had no idea it existed and could not.
    const state = settings.state("mediaMaxBytes");
    expect(state.value).toBe(bootCfg.mediaMaxBytes);
    expect(state.storedValue).toBe(bootCfg.mediaMaxBytes * 10);
  });
});

/**
 * The seven `*ConfigFrom` functions are where the round could silently regress: they used to copy
 * values into plain objects, and a future edit that "simplifies" an accessor back to a value would
 * re-freeze that service with every test still passing. So the mechanism is asserted directly,
 * across all seven at once, and then one behavioural case each.
 */
describe("every service config slice reads through rather than copying", () => {
  it("exposes every field as an accessor, in every config slice", async () => {
    const { config } = await liveOver(baseline());
    const slices = {
      mailbox: mailboxConfigFrom(config),
      media: mediaConfigFrom(config),
      places: placesConfigFrom(config),
      geocode: geocodeConfigFrom(config),
      snapshot: snapshotConfigFrom(config),
      placesAdmin: placesAdminConfigFrom(config),
      contributions: contributionsConfigFrom(config),
      gamesPolicy: gamesPolicyFrom(config),
    };
    const copied: string[] = [];

    for (const [name, slice] of Object.entries(slices)) {
      for (const field of Object.keys(slice)) {
        const desc = Object.getOwnPropertyDescriptor(slice, field);
        if (desc?.get === undefined) copied.push(`${name}.${field}`);
      }
    }

    expect(copied).toEqual([]);
  });

  it("carries a change into each slice's own reader", async () => {
    const { config, settings } = await liveOver(baseline());
    const mailbox = mailboxConfigFrom(config);
    const media = mediaConfigFrom(config);
    const places = placesConfigFrom(config);
    const geocode = geocodeConfigFrom(config);
    const snapshot = snapshotConfigFrom(config);
    const placesAdmin = placesAdminConfigFrom(config);
    const contributions = contributionsConfigFrom(config);

    await settings.set("mailboxTtlSeconds", 99, ADMIN);
    await settings.set("mediaQuotaBytes", 12_345, ADMIN);
    await settings.set("placesQueryPageSize", 7, ADMIN);
    await settings.set("geocodePrecision", 5, ADMIN);
    await settings.set("placesContribExportEnabled", true, ADMIN);
    await settings.set("placesProposalMaxPending", 3, ADMIN);

    expect(mailbox.ttlSeconds).toBe(99);
    expect(media.quotaBytes).toBe(12_345);
    expect(places.pageSize).toBe(7);
    expect(geocode.precision).toBe(5);
    expect(contributions.maxPending).toBe(3);
    expect(placesAdmin.contribExportEnabled).toBe(true);

    // The prerequisite reaches two more slices. It can only be turned off once nothing overrides a
    // dependent, which is `set` refusing rather than a wiring problem (§4.1).
    await settings.reset("placesContribExportEnabled", ADMIN);
    await settings.set("placesEnabled", false, ADMIN);

    expect(places.enabled).toBe(false);
    expect(snapshot.enabled).toBe(false);
  });

  it("keeps a deploy-time field in a slice pinned to boot", async () => {
    const boot = baseline();
    const { config } = await liveOver(boot);

    // `host` and `cellPrecision` ride these slices too and are deliberately not editable: one is a
    // bind address, the other is the shape of the place_cells index (§3.4).
    expect(mediaConfigFrom(config).host).toBe(boot.host);
    expect(snapshotConfigFrom(config).cellPrecision).toBe(boot.placesCellPrecision);
  });
});

/**
 * The consumers that build something *from* a config value rather than reading one, which is where
 * this round could half-land: the config goes live, the object built from it stays frozen, and every
 * test still passes because nothing looked past the config object.
 *
 * **The 41-key sweep above cannot catch this**, and it is worth being explicit about why: it sets a
 * key and then asserts on `config[key]`, which is the accessor it is testing. It can never fail for
 * a key whose *consumer* copied the value, because it never asks the consumer. `mediaCdnUrl` shipped
 * exactly that way — reported as set by the view, and pinned to the boot value inside the blob store
 * — and was caught in review rather than here.
 *
 * So this block observes the value **through the object built from it**. It covers the consumers
 * that construct something and hold it for the process lifetime, which is the whole risky class;
 * a key whose only consumer reads `this.cfg.x` per request is covered by the accessor-descriptor
 * check on the slices instead.
 */
describe("consumers built from config track it rather than capturing it", () => {
  it("re-reads the rate-limit budget on every check, without dropping in-flight windows", () => {
    let max = 1;
    const limiter = new DidRateLimiter({
      windowMs: 60_000,
      get max(): number {
        return max;
      },
    });

    expect(limiter.check("did:key:zA", 1_000)).toBe(true);
    expect(limiter.check("did:key:zA", 1_100)).toBe(false); // budget of 1 is spent

    max = 3; // an operator raises the send budget

    // The next check sees it, in the *same* window: a rebuild-on-change design would have had to
    // discard this window, which hands everyone currently throttled a fresh full budget.
    expect(limiter.check("did:key:zA", 1_200)).toBe(true);
    expect(limiter.size).toBe(1);
  });

  it("refuses sooner when the budget is lowered mid-window", () => {
    let max = 5;
    const limiter = new DidRateLimiter({
      windowMs: 60_000,
      get max(): number {
        return max;
      },
    });
    expect(limiter.check("did:key:zA", 1_000)).toBe(true);
    expect(limiter.check("did:key:zA", 1_010)).toBe(true);

    max = 1;

    expect(limiter.check("did:key:zA", 1_020)).toBe(false);
  });

  it("sends the User-Agent an operator last set, not the one it booted with", async () => {
    let userAgent = "beacon-server/0.0.1 (before)";
    const seen: string[] = [];
    const http = new OutboundHttp({
      get userAgent(): string {
        return userAgent;
      },
      timeoutMs: 1_000,
      fetchImpl: ((_url, init) => {
        seen.push((init?.headers as Record<string, string> | undefined)?.["User-Agent"] ?? "");
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as FetchImpl,
    });

    await http.getJson("https://example.test/a");
    userAgent = "beacon-server/0.0.1 (after)";
    await http.getJson("https://example.test/b");

    // Nominatim's fair-use policy keys off this string, so an operator correcting their contact
    // address is exactly the change that must not wait for a redeploy.
    expect(seen).toEqual(["beacon-server/0.0.1 (before)", "beacon-server/0.0.1 (after)"]);
  });

  it("paces against the interval in force, so raising it slows the next slot", async () => {
    let minIntervalMs = 0;
    const slept: number[] = [];
    let clock = 0;
    const limiter = new OutboundLimiter(
      () => minIntervalMs,
      () => clock,
      (ms: number) => {
        slept.push(ms);
        clock += ms;
        return Promise.resolve();
      },
    );

    await limiter.acquire(); // unpaced
    expect(slept).toEqual([]);

    minIntervalMs = 1_000; // an operator asks the server to be politer to the upstream

    await limiter.acquire();
    await limiter.acquire();
    expect(slept).toEqual([1_000]);
  });

  it("redirects to the CDN an operator last set, not the one the blob store booted with", async () => {
    const boot = testConfig({
      BEACON_MEDIA: "true",
      BEACON_MEDIA_BACKEND: "s3",
      BEACON_MEDIA_S3_BUCKET: "b",
      BEACON_MEDIA_S3_ACCESS_KEY_ID: "k",
      BEACON_MEDIA_S3_SECRET_ACCESS_KEY: "s",
    } as NodeJS.ProcessEnv);
    const { config, settings } = await liveOver(boot);
    const blob = createMediaBlob(config); // exactly what the MEDIA_BLOB factory does

    await settings.set("mediaCdnUrl", "https://cdn.example/media", ADMIN);

    // The redirect path issues no S3 call, so this observes the setting and nothing else. Before the
    // review this returned a stream fallback: the view reported the CDN and the store never saw it.
    const located = await blob.locate("f".repeat(64));
    expect(located?.kind).toBe("redirect");
    expect(located?.kind === "redirect" && located.url).toContain("https://cdn.example/media/");
  });

  it("starts the capability sweeps unconditionally and asks per tick", async () => {
    vi.useFakeTimers();
    try {
      const boot = testConfig(); // mailbox off
      const settings = new SettingsService(new MemorySettingsStore(), runtimeSettingsFrom(boot));
      const config = createLiveConfig(boot, settings);
      const store = { sweepExpired: vi.fn().mockResolvedValue(0) };
      const svc = new MailboxService(
        store as unknown as ConstructorParameters<typeof MailboxService>[0],
        mailboxConfigFrom(config),
      );

      svc.onModuleInit(); // Nest boot, with the capability off
      vi.advanceTimersByTime(120_000);
      expect(store.sweepExpired).not.toHaveBeenCalled(); // nothing to sweep, nothing swept

      // An admin turns the mailbox on. Before the review the interval had never been started, so
      // every delivered message stayed on disk until the next restart — the exact window this round
      // exists to remove. Reads always filtered on `expires_at`, so nothing was ever served wrongly.
      await settings.set("mailboxEnabled", true, ADMIN);
      vi.advanceTimersByTime(120_000);
      expect(store.sweepExpired).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers the media transfer only while media is enabled, and offers it again after", () => {
    let mediaEnabled = false;
    const transfer = {} as MediaTransfer;
    const svc = new SnapshotService(
      {} as never,
      { enabled: true, cellPrecision: 6, host: "example.test", writeLocked: false },
      {
        get mediaTransfer(): MediaTransfer | undefined {
          return mediaEnabled ? transfer : undefined;
        },
      },
    );
    const held = (): unknown => (svc as unknown as { mediaTransfer: unknown }).mediaTransfer;

    expect(held()).toBeUndefined();

    mediaEnabled = true;

    // Captured at boot, the transfer would be omitted from the options entirely when media was off,
    // so this would stay undefined for the life of the process while the routes came up.
    expect(held()).toBe(transfer);
  });
});
