import { beforeEach, describe, expect, it } from "vitest";
import type { SettingRow, SettingsStore } from "../stores/settings-store";
import { PgSettingsStore } from "../stores/settings.pg.store";
import { MemorySettingsStore } from "./memory-stores";
import { memoryTwin, pgTwin, type StoreTwin } from "./pg-twin";

/**
 * The settings twins (`0022_settings`, `doc/spec/runtime-settings.md`), run against **every**
 * backend so the JSON round-trip and the upsert semantics can never drift between them. The value
 * column carries four different shapes (string, number, boolean, string[]) plus an absent optional,
 * and those are exactly where a hand-rolled encode/decode goes wrong: a settings table that
 * returned `"3600"` from Postgres and `3600` from the fake would be a miserable thing to debug from
 * a production console.
 */

const ADMIN = "did:key:zAdmin";
const OTHER = "did:key:zOther";
const T1 = "2026-09-01T00:00:00.000Z";
const T2 = "2026-09-02T00:00:00.000Z";

function row(key: string, value: unknown, over: Partial<SettingRow> = {}): SettingRow {
  return { key, value, updatedBy: ADMIN, updatedAt: T1, ...over };
}

const pg = pgTwin((pool) => new PgSettingsStore(pool), ["settings"]);
const backends: StoreTwin<SettingsStore>[] = [
  memoryTwin((): SettingsStore => new MemorySettingsStore()),
  pg,
];

describe.each(backends)("SettingsStore ($name)", (backend) => {
  beforeEach(() => backend.reset());
  const make = backend.open;
  it("round-trips every value shape a setting can hold", async () => {
    const store = await make();
    await store.put(row("name", "North Server"));
    await store.put(row("mailboxTtlSeconds", 3600));
    await store.put(row("mailboxEnabled", true));
    await store.put(row("games", ["kites", "other"]));
    await store.put(row("description", undefined)); // an absent optional

    const byKey = new Map((await store.all()).map((r) => [r.key, r.value]));
    expect(byKey.get("name")).toBe("North Server");
    expect(byKey.get("mailboxTtlSeconds")).toBe(3600);
    expect(byKey.get("mailboxEnabled")).toBe(true);
    expect(byKey.get("games")).toEqual(["kites", "other"]);
    expect(byKey.get("description")).toBeUndefined();
  });

  it("upserts: a re-put replaces the value, actor and timestamp", async () => {
    const store = await make();
    await store.put(row("mailboxTtlSeconds", 3600));
    await store.put(row("mailboxTtlSeconds", 60, { updatedBy: OTHER, updatedAt: T2 }));

    const all = await store.all();
    expect(all).toHaveLength(1); // replaced, not appended
    expect(all[0]).toEqual({
      key: "mailboxTtlSeconds",
      value: 60,
      updatedBy: OTHER,
      updatedAt: T2,
    });
  });

  it("remove reports whether an override was actually there — this is how a reset is spelled", async () => {
    const store = await make();
    await store.put(row("name", "North Server"));

    expect(await store.remove("name")).toBe(true);
    expect(await store.remove("name")).toBe(false);
    expect(await store.all()).toEqual([]);
  });

  it("lists overrides by key in byte order", async () => {
    const store = await make();
    // `zb`/`zC` split byte order from a linguistic one (0023_byte_order); `zb` goes in first, so
    // insertion order fails too.
    await store.put(row("zb", 1));
    await store.put(row("zC", 2));
    await store.put(row("name", "North Server"));
    expect((await store.all()).map((r) => r.key)).toEqual(["name", "zC", "zb"]);
  });

  it("copies in and out: changing a row after put or all does not reach the store", async () => {
    const store = await make();
    const put = row("games", ["kites"]);
    await store.put(put);
    put.updatedBy = OTHER;
    const [read] = await store.all();
    (read!.value as string[]).push("other");
    read!.updatedBy = OTHER;
    expect(await store.all()).toEqual([row("games", ["kites"])]);
  });

  it("round-trips an absent optional as absent, not as null", async () => {
    const store = await make();
    await store.put(row("description", undefined));

    // JSON has no `undefined`, so it is stored as null. The store's codec undoes that on the way
    // back out, so no caller has to know: a value round-trips as written.
    expect((await store.all())[0]?.value).toBeUndefined();
  });
});

// Only Postgres can hold a row the codec refuses: the fake round-trips every put through it.
describe("PgSettingsStore: a malformed row is dropped, not guessed at", () => {
  beforeEach(() => pg.reset());

  it("drops a row whose value is not parseable JSON, and reads the rest", async () => {
    const store = await pg.open();
    await store.put(row("mailboxTtlSeconds", 3600, { updatedAt: T2 }));
    await pg.query(
      "INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, $4)",
      ["name", "{not json", ADMIN, T1],
    );
    expect(await store.all()).toEqual([row("mailboxTtlSeconds", 3600, { updatedAt: T2 })]);
  });
});
