import { createWallet, signOpWithWallet } from "@beaconsgg/identity";
import { adminSettingsSchema, type AdminSetting } from "@beaconsgg/protocol-types";
import { HttpException, Logger } from "@nestjs/common";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";
import { AdminController } from "../admin/admin.controller";
import type { AdminService } from "../admin/admin.service";
import { AdminGate } from "../common/admin-gate";
import { SenderBlocklist } from "../common/blocklist";
import { NonceService } from "../common/nonce.service";
import type { MediaService } from "../media/media.service";
import type { RoomsService } from "../rooms/rooms.service";
import type { SnapshotService } from "../places/snapshot.service";
import { createLiveConfig } from "../settings/live-config";
import {
  DEPLOY_TIME_FIELDS,
  DEPLOY_TIME_KEYS,
  RUNTIME_SETTING_KEYS,
  SECRET_KEYS,
  runtimeSettingsFrom,
} from "../settings/registry";
import { SettingsService } from "../settings/settings.service";
import { testConfig } from "./test-config";
import { MemoryBlocklistStore, memoryNonces, MemorySettingsStore } from "./memory-stores";
import { rejectedWith, statusOf, testSignedRequestGate } from "./test-helpers";

/**
 * The admin settings ops (`doc/spec/runtime-settings.md` §5, PR 3): read the whole configuration,
 * override part of it, hand part of it back to the environment.
 *
 * The moderation collaborators are passed as `undefined`, which is the point rather than a shortcut:
 * a settings op that reached `MediaService` or `RoomsService` would throw here instead of quietly
 * working, so "these routes touch nothing but settings" is checked rather than claimed.
 */

function untouched<T>(): T {
  return undefined as unknown as T;
}

async function setup(
  bootEnv: NodeJS.ProcessEnv = {},
  admins: string[] = [],
  placeRunActive: () => boolean = () => false,
) {
  const nonce = new NonceService(memoryNonces(), { retentionMs: 10 * 60_000, writeLocked: false });
  const blocklist = new SenderBlocklist(new MemoryBlocklistStore(), [], admins);
  const gate = new AdminGate(testSignedRequestGate({ blocklist }), nonce, admins);

  const store = new MemorySettingsStore();
  const boot = testConfig(bootEnv);
  const settings = new SettingsService(store, runtimeSettingsFrom(boot));
  await settings.load();
  const config = createLiveConfig(boot, settings);

  const controller = new AdminController(
    gate,
    untouched<AdminService>(),
    nonce,
    untouched<RoomsService>(),
    untouched<MediaService>(),
    blocklist,
    settings,
    config,
    bootEnv,
    { hasActiveRun: placeRunActive } as unknown as SnapshotService,
  );
  return { controller, settings, config, store, boot };
}

type Wallet = ReturnType<typeof createWallet>;
const env = (w: Wallet, op: string, params: Record<string, unknown>, nonce = ulid()) =>
  signOpWithWallet(w, { op, nonce, params });

/** The reported row for one key, or a failure naming it (never `undefined` slipping into a match). */
function row(settings: AdminSetting[], key: string): AdminSetting {
  const found = settings.find((s) => s.key === key);
  if (!found) throw new Error(`no reported setting for "${key}"`);
  return found;
}

/** The 400 body's message, which is where a refusal's reasons are. */
function message(err: HttpException): string {
  const body = err.getResponse() as { message?: string };
  return body.message ?? "";
}

describe("the admin settings surface is behind the same gate as the rest", () => {
  // Every signed op on this surface, so a new one cannot be added past the gate by pattern-matching
  // an existing route and forgetting the check (the Tier 0 lesson).
  const calls = [
    [
      "admin.settings.get",
      (c: AdminController, w: Wallet) => c.settingsGet(env(w, "admin.settings.get", {})),
    ],
    [
      "admin.settings.set",
      (c: AdminController, w: Wallet) =>
        c.settingsSet(env(w, "admin.settings.set", { settings: { mailboxTtlSeconds: 60 } })),
    ],
    [
      "admin.settings.reset",
      (c: AdminController, w: Wallet) =>
        c.settingsReset(env(w, "admin.settings.reset", { keys: ["mailboxTtlSeconds"] })),
    ],
  ] as const;

  for (const [op, call] of calls) {
    it(`404s ${op} when no admins are configured, even for a valid signer`, async () => {
      const { controller } = await setup({}, []);
      expect(await statusOf(call(controller, createWallet()))).toBe(404);
    });

    it(`403s ${op} for a valid signer who is not an admin`, async () => {
      const admin = createWallet();
      const { controller } = await setup({}, [admin.account.did]);
      expect(await statusOf(call(controller, createWallet()))).toBe(403);
    });
  }

  it("refuses a replayed read nonce, so a captured settings read cannot be re-run", async () => {
    const admin = createWallet();
    const { controller } = await setup({}, [admin.account.did]);
    const read = env(admin, "admin.settings.get", {});
    await controller.settingsGet(read);
    expect(await statusOf(controller.settingsGet(read))).toBe(409);
  });

  it("keeps a read's nonce and a write's apart, so reusing one across both applies the write", async () => {
    // A console that loads this screen and saves from it is the natural client for reusing one
    // nonce across both. The nonce log keys on the op as well as the nonce, so the write is a new
    // request rather than a replay of the read, and the read's own replay is still refused.
    const admin = createWallet();
    const { controller } = await setup({}, [admin.account.did]);
    const nonce = ulid();
    const read = env(admin, "admin.settings.get", {}, nonce);
    await controller.settingsGet(read);
    const write = env(admin, "admin.settings.set", { settings: { mailboxTtlSeconds: 60 } }, nonce);

    const { settings } = await controller.settingsSet(write);
    expect(settings.find((s) => s.key === "mailboxTtlSeconds")?.value).toBe(60);
    expect(await statusOf(controller.settingsGet(read))).toBe(409);
  });
});

describe("admin.settings.get reports the whole configuration", () => {
  it("lists every field, editable ones first, and nothing else", async () => {
    const admin = createWallet();
    const { controller } = await setup({}, [admin.account.did]);
    const { settings } = await controller.settingsGet(env(admin, "admin.settings.get", {}));

    // The wire contract, checked against the schema rather than by spot-reading fields: a row that
    // grew a field or lost a required one fails here.
    expect(adminSettingsSchema.parse({ settings })).toBeTruthy();
    expect(settings.map((s) => s.key)).toEqual([...RUNTIME_SETTING_KEYS, ...DEPLOY_TIME_KEYS]);
    // Derived, not configured: `admin.status` reports it beside the descriptor facts it belongs to.
    expect(settings.some((s) => s.key === "capabilities")).toBe(false);
  });

  it("marks the runtime half editable and the deploy half read-only, each naming its variable", async () => {
    const admin = createWallet();
    const { controller } = await setup({}, [admin.account.did]);
    const { settings } = await controller.settingsGet(env(admin, "admin.settings.get", {}));

    expect(row(settings, "mailboxTtlSeconds")).toMatchObject({
      editable: true,
      provenance: "env",
      env: "BEACON_MAILBOX_TTL",
      value: 604_800,
      envValue: 604_800,
    });
    // Read-only, and the row says what to edit instead. No `envValue`: for these it *is* the value,
    // and a second copy would invite a console to draw a "differs from default" badge over two
    // identical numbers.
    const admins = row(settings, "admins");
    expect(admins).toMatchObject({ editable: false, provenance: "env", env: "BEACON_ADMINS" });
    expect(admins.envValue).toBeUndefined();
    expect(row(settings, "port")).toMatchObject({ env: "PORT", value: 3001 });
  });

  it("never reports the database URL by value, password included", async () => {
    // The finding that made secrecy a required field on the deploy-time table rather than a separate
    // list: `databaseUrl` was not on the list, and a Postgres DSN carries its own password, so an
    // admin read published the database credential to anyone who could moderate.
    const admin = createWallet();
    const { controller } = await setup(
      { BEACON_DATABASE_URL: "postgres://beacon:s3cr3t-pw@db:5432/beacon" } as NodeJS.ProcessEnv,
      [admin.account.did],
    );
    const { settings } = await controller.settingsGet(env(admin, "admin.settings.get", {}));

    expect(row(settings, "databaseUrl")).toMatchObject({ secret: true, configured: true });
    expect(JSON.stringify(settings)).not.toContain("s3cr3t-pw");
  });

  it("redacts every key the one secrecy declaration marks, whatever that set becomes", async () => {
    // Deliberately driven off `SECRET_KEYS` rather than a written-out list, so a key marked secret
    // later is covered by this test the day it is marked, and a key that stops being redacted fails
    // it. The previous version of this test could only ever check the five somebody remembered.
    const admin = createWallet();
    const SECRET = "correct-horse-battery-staple";
    const boot = Object.fromEntries(
      SECRET_KEYS.map((key) => [DEPLOY_TIME_FIELDS[key].env, SECRET]),
    ) as NodeJS.ProcessEnv;
    const { controller } = await setup(boot, [admin.account.did]);
    const { settings } = await controller.settingsGet(env(admin, "admin.settings.get", {}));

    expect(SECRET_KEYS.length).toBeGreaterThan(0);
    for (const key of SECRET_KEYS) {
      expect(row(settings, key)).toMatchObject({ secret: true, editable: false, configured: true });
      expect(row(settings, key).value).toBeUndefined();
    }
    expect(JSON.stringify(settings)).not.toContain(SECRET);
  });

  it("says whether each variable is actually exported, not only what the value is", async () => {
    // "I set that variable and nothing changed" is the question this screen exists to answer, and a
    // field on its built-in default is otherwise indistinguishable from one an operator set to that
    // same value. Which is why this cannot be a comparison against a fresh loadConfig({}).
    const admin = createWallet();
    const { controller } = await setup({ PORT: "3001" } as NodeJS.ProcessEnv, [admin.account.did]);
    const { settings } = await controller.settingsGet(env(admin, "admin.settings.get", {}));

    // Exported, and to the value it would have had anyway: the value alone cannot tell you.
    expect(row(settings, "port")).toMatchObject({ configured: true, value: 3001 });
    expect(row(settings, "host")).toMatchObject({ configured: false, value: "localhost:3001" });
    expect(row(settings, "mailboxTtlSeconds").configured).toBe(false);
    expect(row(settings, "keyPassphrase")).toMatchObject({ secret: true, configured: false });
  });
});

describe("admin.settings.set overrides settings without a redeploy", () => {
  it("puts the change in force on the next read of the live config", async () => {
    const admin = createWallet();
    const { controller, config } = await setup({}, [admin.account.did]);
    expect(config.mailboxTtlSeconds).toBe(604_800);

    const { settings } = await controller.settingsSet(
      env(admin, "admin.settings.set", { settings: { mailboxTtlSeconds: 3600 }, reason: "trim" }),
    );

    expect(config.mailboxTtlSeconds).toBe(3600);
    expect(row(settings, "mailboxTtlSeconds")).toMatchObject({
      value: 3600,
      provenance: "admin",
      updatedBy: admin.account.did,
      envValue: 604_800,
    });
  });

  it("takes several keys in one write, which is the only order that works", async () => {
    // The whole reason the op is multi-key. With places and its contributions flag both on, turning
    // places off alone is a combination `loadConfig` cannot produce, so it is refused; the operator
    // who means to turn the capability off says so in one signed write.
    const admin = createWallet();
    const { controller, config, store } = await setup(
      { BEACON_PLACES: "true", BEACON_PLACES_PROPOSALS: "true" } as NodeJS.ProcessEnv,
      [admin.account.did],
    );

    const refused = await rejectedWith(() =>
      controller.settingsSet(
        env(admin, "admin.settings.set", { settings: { placesEnabled: false } }),
      ),
    );
    expect(refused.getStatus()).toBe(400);
    expect(message(refused)).toContain("placesContributionsEnabled");
    // Refused means nothing landed: not the key it named, and not a row for it either.
    expect(config.placesEnabled).toBe(true);
    expect(await store.all()).toEqual([]);

    await controller.settingsSet(
      env(admin, "admin.settings.set", {
        settings: { placesEnabled: false, placesContributionsEnabled: false },
      }),
    );
    expect(config.placesEnabled).toBe(false);
    expect(config.placesContributionsEnabled).toBe(false);
  });

  it("reports every bad value at once, each beside the key it belongs to", async () => {
    const admin = createWallet();
    const { controller, store } = await setup({}, [admin.account.did]);

    const refused = await rejectedWith(() =>
      controller.settingsSet(
        env(admin, "admin.settings.set", {
          settings: { mailboxTtlSeconds: -1, name: "", geocodeTimeoutMs: 500 },
        }),
      ),
    );
    expect(refused.getStatus()).toBe(400);
    const issues = JSON.parse(message(refused)) as { path: string[] }[];
    // One form, one round trip: an operator fixing three fields should not need three refusals.
    expect(issues.map((i) => i.path[0]).sort()).toEqual(["mailboxTtlSeconds", "name"]);
    expect(await store.all()).toEqual([]);
  });

  it("refuses a key it cannot write, and says which kind of refusal it is", async () => {
    const admin = createWallet();
    const { controller } = await setup({}, [admin.account.did]);

    const refused = await rejectedWith(() =>
      controller.settingsSet(
        env(admin, "admin.settings.set", {
          settings: { admins: ["did:key:zNope"], capabilities: [], nonsense: 1 },
        }),
      ),
    );
    expect(refused.getStatus()).toBe(400);
    // One encoding for every refusal: a caller should not have to test whether `message` parses as
    // JSON to learn whether it got a per-field list or a prose paragraph, and a key refusal keeps the
    // same `path: [key]` association a bad value gets.
    const issues = JSON.parse(message(refused)) as { path: string[]; message: string }[];
    const byKey = Object.fromEntries(issues.map((i) => [i.path[0] ?? "", i.message]));
    // Three different sentences on purpose: they send an operator to three different places.
    expect(byKey["admins"]).toContain("BEACON_ADMINS");
    expect(byKey["admins"]).toContain("restart");
    expect(byKey["capabilities"]).toContain("derived from the capability toggles");
    expect(byKey["nonsense"]).toBe("not a setting");
  });

  it("reports an unwritable key and a bad value together, in one round trip", async () => {
    // The flow this op exists to give an operator. Refusing the key first and the value only on the
    // resubmit is the one-field-at-a-time form the multi-key write is an argument against.
    const admin = createWallet();
    const { controller } = await setup({}, [admin.account.did]);

    const refused = await rejectedWith(() =>
      controller.settingsSet(
        env(admin, "admin.settings.set", { settings: { admins: [], mailboxTtlSeconds: -1 } }),
      ),
    );
    const issues = JSON.parse(message(refused)) as { path: string[] }[];
    expect(issues.map((i) => i.path[0]).sort()).toEqual(["admins", "mailboxTtlSeconds"]);
  });

  it("refuses a patch that names more keys than the server has settings", async () => {
    // Every unwritable key produces a refusal and the refusals are assembled into one response, so
    // an uncapped patch is work proportional to the body. The wire is the cheapest place to stop it.
    const admin = createWallet();
    const { controller } = await setup({}, [admin.account.did]);
    const many = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, 1]));

    const refused = await rejectedWith(() =>
      controller.settingsSet(env(admin, "admin.settings.set", { settings: many })),
    );
    expect(refused.getStatus()).toBe(400);
    expect(message(refused).length).toBeLessThan(2_000);
    const reset = await rejectedWith(() =>
      controller.settingsReset(env(admin, "admin.settings.reset", { keys: Object.keys(many) })),
    );
    expect(reset.getStatus()).toBe(400);
  });

  it("overrides an optional setting to no value, which is not a reset", async () => {
    const admin = createWallet();
    const { controller, config } = await setup(
      { BEACON_CONTACT: "ops@example.com" } as NodeJS.ProcessEnv,
      [admin.account.did],
    );

    const set = await controller.settingsSet(
      env(admin, "admin.settings.set", { settings: { contact: null } }),
    );
    expect(config.contact).toBeUndefined();
    // The override stands and the environment stays out of it: `null` says "no value", where a reset
    // says "let the environment supply it again".
    expect(row(set.settings, "contact")).toMatchObject({
      provenance: "admin",
      envValue: "ops@example.com",
    });
    expect(row(set.settings, "contact").value).toBeUndefined();

    const reset = await controller.settingsReset(
      env(admin, "admin.settings.reset", { keys: ["contact"] }),
    );
    expect(config.contact).toBe("ops@example.com");
    expect(row(reset.settings, "contact")).toMatchObject({
      provenance: "env",
      value: "ops@example.com",
    });
  });

  it("is idempotent by nonce: a replay does not re-apply a change that was undone", async () => {
    const admin = createWallet();
    const { controller, config } = await setup({}, [admin.account.did]);
    const write = env(admin, "admin.settings.set", { settings: { mailboxTtlSeconds: 60 } });

    await controller.settingsSet(write);
    await controller.settingsReset(
      env(admin, "admin.settings.reset", { keys: ["mailboxTtlSeconds"] }),
    );
    await controller.settingsSet(write); // the retry a flaky network produces

    expect(config.mailboxTtlSeconds).toBe(604_800);
  });
});

describe("the settings ops answer with the whole configuration", () => {
  it("shows a field the write did not name, because a write can move one", async () => {
    // The reason a write returns everything rather than the rows it touched. Resetting a
    // prerequisite leaves its dependant's override standing but dormant, and a console that
    // refreshed only the key it sent would still be showing contributions as on.
    const admin = createWallet();
    const { controller, config } = await setup({}, [admin.account.did]);
    await controller.settingsSet(
      env(admin, "admin.settings.set", {
        settings: { placesEnabled: true, placesContributionsEnabled: true },
      }),
    );
    expect(config.placesContributionsEnabled).toBe(true);

    const { settings } = await controller.settingsReset(
      env(admin, "admin.settings.reset", { keys: ["placesEnabled"] }),
    );

    expect(config.placesContributionsEnabled).toBe(false);
    // Dormant, not deleted: the admin's stated intent is still on the row and reported as
    // `storedValue`, so a console never shows `false (admin)` with nothing to explain it.
    expect(row(settings, "placesContributionsEnabled")).toMatchObject({
      value: false,
      storedValue: true,
      provenance: "admin",
    });
    expect(row(settings, "placesEnabled")).toMatchObject({ value: false, provenance: "env" });
  });

  it("says which rule held a stored value back, because the remedies differ", async () => {
    // `storedValue` alone leaves a console with one generic "not in force" badge over two situations
    // that want opposite things from an operator: turn the capability on, against raise the variable
    // and restart.
    const admin = createWallet();
    const { controller } = await setup({ BEACON_MEDIA_MAX_BYTES: "1000" } as NodeJS.ProcessEnv, [
      admin.account.did,
    ]);
    await controller.settingsSet(
      env(admin, "admin.settings.set", {
        settings: { placesEnabled: true, placesContributionsEnabled: true },
      }),
    );
    await controller.settingsSet(
      env(admin, "admin.settings.set", { settings: { mediaMaxBytes: 5000 } }),
    );

    const { settings } = await controller.settingsReset(
      env(admin, "admin.settings.reset", { keys: ["placesEnabled"] }),
    );

    expect(row(settings, "placesContributionsEnabled")).toMatchObject({
      storedValue: true,
      storedReason: "prerequisite",
    });
    expect(row(settings, "mediaMaxBytes")).toMatchObject({
      value: 1000,
      storedValue: 5000,
      storedReason: "ceiling",
    });
  });
});

describe("the settings ops log what happened and only what happened", () => {
  /** Every line either the controller's audit or the service's per-key log wrote. */
  function captureLog() {
    const lines: string[] = [];
    const spy = vi.spyOn(Logger.prototype, "log").mockImplementation((msg: unknown) => {
      lines.push(String(msg));
    });
    return { lines, restore: () => spy.mockRestore() };
  }

  it("does not audit a replayed write as a second change", async () => {
    // The audit line sits inside the nonce bracket for this reason. Outside it, a retried envelope
    // records a configuration change that `idempotentResult` correctly declined to make, and an
    // operator reading the stream sees two where they made one.
    const admin = createWallet();
    const { controller } = await setup({}, [admin.account.did]);
    const write = env(admin, "admin.settings.set", { settings: { mailboxTtlSeconds: 60 } });
    await controller.settingsSet(write);

    const { lines, restore } = captureLog();
    await controller.settingsSet(write);
    restore();

    expect(lines.filter((l) => l.startsWith("admin.settings.set"))).toEqual([]);
    expect(lines.filter((l) => l.startsWith("settings:"))).toEqual([]);
  });

  it("records what a half-failed write actually changed", async () => {
    // The store has no multi-row transaction, so this state is reachable: some rows written, some
    // not, on a live server. It is the case where silence is worst, and the case a log line written
    // only on success cannot cover.
    const admin = createWallet();
    const { controller, store } = await setup({}, [admin.account.did]);
    const put = store.put.bind(store);
    let writes = 0;
    store.put = (row) => (++writes > 1 ? Promise.reject(new Error("store died")) : put(row));

    const { lines, restore } = captureLog();
    await expect(
      controller.settingsSet(
        env(admin, "admin.settings.set", { settings: { mailboxTtlSeconds: 60, mediaRateMax: 5 } }),
      ),
    ).rejects.toThrow("store died");
    restore();

    // What changed is logged; that the op completed is not, because it did not.
    expect(lines.filter((l) => l.includes('"mailboxTtlSeconds"'))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("admin.settings.set"))).toEqual([]);
  });
});

describe("the write lock is refused over a running place import", () => {
  async function locked(active: boolean, bootEnv: NodeJS.ProcessEnv = {}) {
    const admin = createWallet();
    const ctx = await setup(bootEnv, [admin.account.did], () => active);
    return { ...ctx, admin };
  }

  it("refuses to set the lock while a run is queued or running, with the reason on the key", async () => {
    const { controller, admin, settings } = await locked(true);
    const err = await rejectedWith(() =>
      controller.settingsSet(env(admin, "admin.settings.set", { settings: { writeLocked: true } })),
    );
    expect(err.getStatus()).toBe(400);
    expect(message(err)).toMatch(/place import is queued or running/);
    expect(message(err)).toContain("writeLocked");
    expect(settings.get("writeLocked")).toBe(false);
  });

  it("does not stop an unlock, or any other setting, during a run", async () => {
    const { controller, admin, settings } = await locked(true);
    await controller.settingsSet(
      env(admin, "admin.settings.set", { settings: { writeLocked: false, mailboxTtlSeconds: 60 } }),
    );
    expect(settings.get("mailboxTtlSeconds")).toBe(60);
  });

  it("sets the lock once no run is active", async () => {
    const { controller, admin, settings } = await locked(false);
    await controller.settingsSet(
      env(admin, "admin.settings.set", { settings: { writeLocked: true } }),
    );
    expect(settings.get("writeLocked")).toBe(true);
  });

  it("refuses the reset that would hand the lock to an environment holding it on", async () => {
    const { controller, admin, settings } = await locked(true, { BEACON_WRITE_LOCK: "1" });
    await settings.set("writeLocked", false, admin.account.did);

    const err = await rejectedWith(() =>
      controller.settingsReset(env(admin, "admin.settings.reset", { keys: ["writeLocked"] })),
    );
    expect(err.getStatus()).toBe(400);
    expect(message(err)).toMatch(/place import is queued or running/);
    expect(settings.get("writeLocked")).toBe(false);
  });

  it("lets a reset through when the environment leaves the server unlocked", async () => {
    const { controller, admin } = await locked(true);
    expect(
      await statusOf(
        controller.settingsReset(env(admin, "admin.settings.reset", { keys: ["writeLocked"] })),
      ),
    ).toBe(0);
  });
});
