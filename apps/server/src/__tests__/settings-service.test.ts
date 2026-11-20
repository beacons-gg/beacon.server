import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runtimeSettingsFrom, type RuntimeSettings } from "../settings/registry";
import { SettingsService } from "../settings/settings.service";
import { type SettingsStore } from "../stores/settings-store";
import { testConfig } from "./test-config";
import { MemorySettingsStore } from "./memory-stores";

/**
 * The provenance rules (`doc/spec/runtime-settings.md` §4) are the behaviour most likely to be got
 * subtly wrong, and the one an operator notices when it is: they decide whether editing a compose
 * file and redeploying does anything, and whether a redeploy silently reverts a deliberate admin
 * change.
 *
 * These tests drive the service directly against the memory twin, and always across a **restart**
 * (a second service over the same store), because "what happens on the next boot" is the whole
 * question and a single instance cannot answer it.
 */

const ADMIN = "did:key:zAdmin";

function envConfig(overrides: Record<string, string> = {}): RuntimeSettings {
  return runtimeSettingsFrom(testConfig({ ...overrides } as NodeJS.ProcessEnv));
}

/** Boot a service over an existing store, exactly as a restart would. */
async function boot(
  store: SettingsStore,
  env: RuntimeSettings,
  now?: () => number,
): Promise<SettingsService> {
  const svc = new SettingsService(store, env, now);
  await svc.load();
  return svc;
}

describe("SettingsService — env is defaults, an override is what changes that", () => {
  let store: SettingsStore;

  beforeEach(() => {
    store = new MemorySettingsStore();
  });

  it("writes nothing at boot when no admin has set anything", async () => {
    const svc = await boot(store, envConfig({ BEACON_MAILBOX_TTL: "3600" }));

    expect(svc.get("mailboxTtlSeconds")).toBe(3600);
    expect(svc.state("mailboxTtlSeconds").provenance).toBe("env");
    // The absence of a row IS the provenance, so a clean boot leaves the table empty rather than
    // restating 41 values loadConfig is about to recompute anyway.
    expect(await store.all()).toEqual([]);
  });

  it("lands an env change across a restart when no admin has taken the setting over", async () => {
    await boot(store, envConfig({ BEACON_MAILBOX_TTL: "3600" }));

    // The operator edits the compose file and redeploys.
    const after = await boot(store, envConfig({ BEACON_MAILBOX_TTL: "7200" }));

    expect(after.get("mailboxTtlSeconds")).toBe(7200);
    expect(after.state("mailboxTtlSeconds").provenance).toBe("env");
  });

  it("holds an admin value across a restart, even when the env var changed", async () => {
    const first = await boot(store, envConfig({ BEACON_MAILBOX_TTL: "3600" }));
    await first.set("mailboxTtlSeconds", 60, ADMIN);

    const after = await boot(store, envConfig({ BEACON_MAILBOX_TTL: "7200" }));

    expect(after.get("mailboxTtlSeconds")).toBe(60);
    expect(after.state("mailboxTtlSeconds")).toMatchObject({
      provenance: "admin",
      updatedBy: ADMIN,
      // The console can still show what a reset would restore, which is the point of carrying it.
      envValue: 7200,
    });
  });

  it("reset drops the override, and the setting tracks env again after", async () => {
    const first = await boot(store, envConfig({ BEACON_MAILBOX_TTL: "3600" }));
    await first.set("mailboxTtlSeconds", 60, ADMIN);
    const reset = await first.reset("mailboxTtlSeconds", ADMIN);

    expect(reset.value).toBe(3600);
    expect(reset.provenance).toBe("env");
    expect(await store.all()).toEqual([]); // the row is gone, not rewritten

    // The point of reset: provenance is not a one-way door. A later env change must land again.
    const after = await boot(store, envConfig({ BEACON_MAILBOX_TTL: "7200" }));
    expect(after.get("mailboxTtlSeconds")).toBe(7200);
  });

  it("serves env values before hydration, so a request during boot is not answered from an empty config", () => {
    const svc = new SettingsService(store, envConfig({ BEACON_MAILBOX_TTL: "3600" }));
    // No load yet.
    expect(svc.get("mailboxTtlSeconds")).toBe(3600);
    expect(svc.get("mailboxEnabled")).toBe(false);
  });

  it("writes durably before it updates the cache, so a failed write cannot be served", async () => {
    const svc = await boot(store, envConfig());
    const failing = vi.spyOn(store, "put").mockRejectedValueOnce(new Error("disk on fire"));

    await expect(svc.set("mailboxTtlSeconds", 60, ADMIN)).rejects.toThrow("disk on fire");
    expect(svc.get("mailboxTtlSeconds")).not.toBe(60); // still the env value
    failing.mockRestore();
  });

  it("stamps an override from the injected clock", async () => {
    const at = Date.parse("2026-09-01T12:00:00.000Z");
    const svc = await boot(store, envConfig(), () => at);

    const state = await svc.set("mailboxTtlSeconds", 60, ADMIN);

    expect(state.updatedAt).toBe("2026-09-01T12:00:00.000Z");
    expect((await store.all())[0]?.updatedAt).toBe("2026-09-01T12:00:00.000Z");
  });

  it("reports no actor or timestamp while the environment still drives a setting", async () => {
    const svc = await boot(store, envConfig());
    const state = svc.state("mailboxTtlSeconds");

    expect(state.updatedBy).toBeUndefined();
    expect(state.updatedAt).toBeUndefined();
  });

  it("current() reflects overrides, which is what the PR-2 config seam will read", async () => {
    const svc = await boot(store, envConfig({ BEACON_MAILBOX_TTL: "3600" }));
    expect(svc.current().mailboxTtlSeconds).toBe(3600);

    await svc.set("mailboxTtlSeconds", 60, ADMIN);
    expect(svc.current().mailboxTtlSeconds).toBe(60);
  });
});

describe("SettingsService — validation", () => {
  it("refuses a value the field schema rejects, and says why", async () => {
    const svc = await boot(new MemorySettingsStore(), envConfig());

    await expect(svc.set("mailboxTtlSeconds", -1, ADMIN)).rejects.toThrow();
    await expect(svc.set("mailboxTtlSeconds", "an hour", ADMIN)).rejects.toThrow();
    // The registry reuses loadConfig's own slug schema, so an admin cannot write a game slug that
    // boot validation would have refused.
    await expect(svc.set("games", ["Not A Slug"], ADMIN)).rejects.toThrow();
    await expect(svc.set("accessLevel", "sometimes", ADMIN)).rejects.toThrow();
  });

  it("refuses a URL whose scheme is not http(s)", async () => {
    const svc = await boot(new MemorySettingsStore(), envConfig());
    // mediaCdnUrl is the target media fetches are redirected to, so `z.string().url()` alone (which
    // accepts javascript: and data:) is not enough.
    await expect(svc.set("mediaCdnUrl", "javascript:alert(1)", ADMIN)).rejects.toThrow();
    await expect(svc.set("mediaCdnUrl", "https://cdn.example.com", ADMIN)).resolves.toBeDefined();
  });

  it("refuses a combination loadConfig makes structurally impossible", async () => {
    // loadConfig computes `placesEnabled && BEACON_PLACES_PROPOSALS`, so an operator who sets
    // only the second gets false. A per-field schema cannot see that, so the whole candidate is
    // checked instead.
    const svc = await boot(new MemorySettingsStore(), envConfig());
    expect(svc.get("placesEnabled")).toBe(false);

    await expect(svc.set("placesContributionsEnabled", true, ADMIN)).rejects.toThrow(
      /needs placesEnabled/,
    );
    await expect(svc.set("placesContribExportEnabled", true, ADMIN)).rejects.toThrow(
      /needs placesEnabled/,
    );

    // ...and is fine once places is on.
    await svc.set("placesEnabled", true, ADMIN);
    await expect(svc.set("placesContributionsEnabled", true, ADMIN)).resolves.toBeDefined();
  });

  it("keeps the previous value when a write is refused", async () => {
    const svc = await boot(new MemorySettingsStore(), envConfig({ BEACON_MAILBOX_TTL: "3600" }));

    await expect(svc.set("mailboxTtlSeconds", 0, ADMIN)).rejects.toThrow();

    expect(svc.get("mailboxTtlSeconds")).toBe(3600);
    expect(svc.state("mailboxTtlSeconds").provenance).toBe("env");
  });

  it("ignores a stored override this build no longer accepts, without deleting it", async () => {
    const store = new MemorySettingsStore();
    const row = {
      key: "mailboxTtlSeconds",
      value: -5, // e.g. hand-edited, or written by a build whose schema was looser
      updatedBy: ADMIN,
      updatedAt: new Date().toISOString(),
    };
    await store.put(row);

    const svc = await boot(store, envConfig({ BEACON_MAILBOX_TTL: "3600" }));

    expect(svc.get("mailboxTtlSeconds")).toBe(3600);
    expect(svc.state("mailboxTtlSeconds").provenance).toBe("env");
    // Not deleted. A schema that tightens in release N+1 puts a previously-valid override in exactly
    // this position, and deleting it would mean rolling back to N no longer restores a value N still
    // accepts. Leaving it is also what keeps "boot writes nothing" true rather than nearly true.
    expect(await store.all()).toEqual([row]);
  });

  it("leaves a stored key this build does not know, rather than deleting the operator's value", async () => {
    const store = new MemorySettingsStore();
    await store.put({
      key: "someSettingFromALaterRelease",
      value: 1,
      updatedBy: ADMIN,
      updatedAt: new Date().toISOString(),
    });

    await boot(store, envConfig());

    const rows = await store.all();
    expect(rows.find((r) => r.key === "someSettingFromALaterRelease")?.value).toBe(1);
  });
});

/**
 * A prerequisite (`placesEnabled` under the two contribution flags) is the one rule `loadConfig`
 * enforces by *construction* rather than by checking, so everything downstream was written assuming
 * the forbidden pair is unreachable: `contributionsConfigFrom` fills the contributions gate from
 * `placesContributionsEnabled` alone, and `capabilities` advertises `places-proposals` on its own.
 *
 * An override store makes it reachable again by three routes that have nobody to refuse to. These
 * cover all three, and they assert on the value in force rather than on the row, because the row is
 * the admin's intent and the reconciled view is the guarantee.
 */
describe("SettingsService — a prerequisite holds however the rows got there", () => {
  it("keeps a dependent dormant when its prerequisite is reset out from under it", async () => {
    const store = new MemorySettingsStore();
    const svc = await boot(store, envConfig()); // BEACON_PLACES unset
    await svc.set("placesEnabled", true, ADMIN);
    await svc.set("placesContributionsEnabled", true, ADMIN);
    expect(svc.get("placesContributionsEnabled")).toBe(true);

    await svc.reset("placesEnabled", ADMIN);

    expect(svc.get("placesEnabled")).toBe(false);
    expect(svc.get("placesContributionsEnabled")).toBe(false);
    // The admin's choice is kept, not destroyed: it applies again the moment places comes back.
    expect(svc.state("placesContributionsEnabled").storedValue).toBe(true);
    await svc.set("placesEnabled", true, ADMIN);
    expect(svc.get("placesContributionsEnabled")).toBe(true);
    expect(svc.state("placesContributionsEnabled").storedValue).toBeUndefined();
  });

  it("keeps a dependent dormant when the environment loses the prerequisite across a restart", async () => {
    const store = new MemorySettingsStore();
    const first = await boot(
      store,
      envConfig({ BEACON_PLACES: "true", BEACON_PLACES_PROPOSALS: "true" }),
    );
    await first.set("placesContributionsEnabled", true, ADMIN);

    // The operator edits the compose file and redeploys, with the override still in the table.
    const svc = await boot(store, envConfig());

    expect(svc.get("placesEnabled")).toBe(false);
    expect(svc.get("placesContributionsEnabled")).toBe(false);
    expect(svc.state("placesContributionsEnabled").storedValue).toBe(true);
  });

  it("cannot serve the pair even when two writes interleave past the refusal", async () => {
    const store = new MemorySettingsStore();
    const svc = await boot(store, envConfig({ BEACON_PLACES: "true" }));

    // Concurrently, which is the only way past the refusal: `set` validates synchronously and only
    // then awaits the durable write, so both see a `current()` in which their own candidate is fine.
    // Sequentially the second call is refused, which is why this has to be a real interleave.
    await Promise.all([
      svc.set("placesEnabled", false, ADMIN),
      svc.set("placesContributionsEnabled", true, ADMIN),
    ]);

    // Both rows landed, and the pair still cannot be served. That is the point of reconciling rather
    // than relying on the check: no mutex is needed for the combination to stay unreachable.
    expect((await store.all()).map((r) => r.key).sort()).toEqual([
      "placesContributionsEnabled",
      "placesEnabled",
    ]);
    expect(svc.get("placesContributionsEnabled")).toBe(false);
    expect(svc.state("placesContributionsEnabled").storedValue).toBe(true);
  });

  it("reconciles before hydration too, so a request during boot never sees the pair", () => {
    // The window `load` has not closed yet: env alone drives, and env cannot produce it.
    const svc = new SettingsService(new MemorySettingsStore(), {
      ...envConfig(),
      placesEnabled: false,
      placesContributionsEnabled: true,
    });

    expect(svc.get("placesContributionsEnabled")).toBe(false);
  });
});

describe("SettingsService — optional settings round-trip", () => {
  it("carries an absent optional setting as absent, not as null", async () => {
    const store = new MemorySettingsStore();
    // BEACON_DESCRIPTION unset, so loadConfig omits the field entirely.
    const svc = await boot(store, envConfig());
    expect(svc.get("description")).toBeUndefined();

    const after = await boot(store, envConfig());
    expect(after.get("description")).toBeUndefined();
  });

  it("round-trips an admin-set optional setting", async () => {
    const store = new MemorySettingsStore();
    const first = await boot(store, envConfig());
    await first.set("description", "A server for the north", ADMIN);

    const after = await boot(store, envConfig());
    expect(after.get("description")).toBe("A server for the north");
  });
});

/**
 * Several keys in one write (`doc/spec/runtime-settings.md` §5.2). The multi-key op exists because
 * these settings constrain each other, so the interesting cases are all about what the *whole
 * patch* does rather than what one key does.
 */
describe("SettingsService: saving the lock as it stands", () => {
  it("does not rewrite writeLocked's row, so its timestamp stays when the lock took hold", async () => {
    let now = Date.parse("2026-11-08T00:00:00.000Z");
    const store = new MemorySettingsStore();
    const svc = new SettingsService(store, runtimeSettingsFrom(testConfig()), () => now);
    await svc.load();

    await svc.set("writeLocked", true, ADMIN);
    const first = svc.state("writeLocked").updatedAt;
    now += 60_000;
    await svc.set("writeLocked", true, "did:key:zSomeoneElse");

    expect(svc.state("writeLocked").updatedAt).toBe(first);
    expect((await store.all()).find((r) => r.key === "writeLocked")).toMatchObject({
      updatedAt: first,
      updatedBy: ADMIN,
    });

    // A real change still lands, and so does a re-save of any other key.
    now += 60_000;
    await svc.set("writeLocked", false, ADMIN);
    expect(svc.state("writeLocked").value).toBe(false);
    expect(svc.state("writeLocked").updatedAt).not.toBe(first);
    await svc.set("name", "A", ADMIN);
    const named = svc.state("name").updatedAt;
    now += 60_000;
    await svc.set("name", "A", ADMIN);
    expect(svc.state("name").updatedAt).not.toBe(named);
  });

  it("still writes the row when the environment holds the lock, so a restart cannot lift it", async () => {
    const store = new MemorySettingsStore();
    const svc = new SettingsService(
      store,
      runtimeSettingsFrom(testConfig({ BEACON_WRITE_LOCK: "1" })),
    );
    await svc.load();

    await svc.set("writeLocked", true, ADMIN);

    expect(svc.state("writeLocked").provenance).toBe("admin");
    expect(await store.all()).toHaveLength(1);
  });
});

describe("SettingsService — setMany and resetMany", () => {
  it("takes a combination no sequence of single writes could reach", async () => {
    const store = new MemorySettingsStore();
    const svc = await boot(
      store,
      envConfig({ BEACON_PLACES: "true", BEACON_PLACES_PROPOSALS: "true" }),
    );

    // Either order fails on its own: contributions cannot be on without places, and places cannot go
    // off while contributions is on.
    await expect(svc.set("placesEnabled", false, ADMIN)).rejects.toThrow();

    await svc.setMany({ placesEnabled: false, placesContributionsEnabled: false }, ADMIN);
    expect(svc.get("placesEnabled")).toBe(false);
    expect(svc.get("placesContributionsEnabled")).toBe(false);
  });

  it("stamps every row in one patch with the same instant, because one op wrote them", async () => {
    const store = new MemorySettingsStore();
    const clock = vi.fn(() => 1_700_000_000_000);
    const svc = await boot(store, envConfig(), clock);

    await svc.setMany({ mailboxTtlSeconds: 60, mediaRateMax: 5 }, ADMIN);

    const stamps = new Set((await store.all()).map((r) => r.updatedAt));
    expect(stamps.size).toBe(1);
  });

  it("reports every refused value at once, each issue under its own key", async () => {
    const svc = await boot(new MemorySettingsStore(), envConfig());

    const refused = await svc
      .setMany({ mailboxTtlSeconds: -1, name: "", mediaRateMax: 5 }, ADMIN)
      .catch((err: unknown) => err);

    // One form, one round trip. Reporting the first bad field and stopping is what a bad form does.
    expect(refused).toBeInstanceOf(z.ZodError);
    expect((refused as z.ZodError).issues.map((i) => i.path[0]).sort()).toEqual([
      "mailboxTtlSeconds",
      "name",
    ]);
  });

  it("stores none of a patch it refuses, not even the keys that were fine", async () => {
    const store = new MemorySettingsStore();
    const svc = await boot(store, envConfig());

    await expect(svc.setMany({ mediaRateMax: 5, mailboxTtlSeconds: -1 }, ADMIN)).rejects.toThrow();

    expect(await store.all()).toEqual([]);
    expect(svc.get("mediaRateMax")).toBe(svc.state("mediaRateMax").envValue);
  });

  it("cannot serve the forbidden pair even when a patch fails half way through", async () => {
    // The `finally` recompute, and why it is there. A store that dies between two puts leaves the
    // prerequisite off and its dependant's override unwritten, which is precisely the state a
    // write-time check cannot cover: there is nobody left to refuse to.
    const store = new MemorySettingsStore();
    const put = store.put.bind(store);
    let writes = 0;
    store.put = (row) => (++writes > 1 ? Promise.reject(new Error("store died")) : put(row));

    const svc = await boot(
      store,
      envConfig({ BEACON_PLACES: "true", BEACON_PLACES_PROPOSALS: "true" }),
    );
    await expect(
      svc.setMany({ placesEnabled: false, placesContributionsEnabled: false }, ADMIN),
    ).rejects.toThrow("store died");

    expect(svc.get("placesEnabled")).toBe(false); // the write that landed
    expect((await store.all()).map((r) => r.key)).toEqual(["placesEnabled"]);
    // Coerced rather than checked: the environment still says contributions are on and no override
    // says otherwise, so only the reconciliation stands between the server and a pair `loadConfig`
    // could never produce.
    expect(svc.get("placesContributionsEnabled")).toBe(false);
  });

  it("resets several keys in one op, and reports what each of them fell back to", async () => {
    const store = new MemorySettingsStore();
    const svc = await boot(store, envConfig({ BEACON_MAILBOX_TTL: "3600" }));
    await svc.setMany({ mailboxTtlSeconds: 60, mediaRateMax: 5 }, ADMIN);

    await svc.resetMany(["mailboxTtlSeconds", "mediaRateMax"], ADMIN);

    expect(
      [svc.state("mailboxTtlSeconds"), svc.state("mediaRateMax")].map((s) => s.provenance),
    ).toEqual(["env", "env"]);
    expect(svc.get("mailboxTtlSeconds")).toBe(3600);
    expect(await store.all()).toEqual([]);
  });

  it("clears a row this build refused to honour, which is the only way to be rid of one", async () => {
    // Boot leaves an unusable row alone because nobody asked; a reset *is* an admin asking. Without
    // this, a row a tightened schema rejected would be unremovable except by hand-editing the table.
    const store = new MemorySettingsStore();
    await store.put({
      key: "mailboxTtlSeconds",
      value: -5,
      updatedBy: ADMIN,
      updatedAt: new Date().toISOString(),
    });
    const svc = await boot(store, envConfig({ BEACON_MAILBOX_TTL: "3600" }));
    expect(svc.state("mailboxTtlSeconds").provenance).toBe("env"); // ignored, but still on disk

    await svc.resetMany(["mailboxTtlSeconds"], ADMIN);

    expect(await store.all()).toEqual([]);
  });
});
