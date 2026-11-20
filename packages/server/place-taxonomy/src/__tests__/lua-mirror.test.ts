import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { OSM_TAG_MAP } from "../taxonomy";

/**
 * Lua can't import this taxonomy, so `apps/atlas/osm-import/beacon-places.lua`'s import filter is a documented
 * manual mirror of it. These assertions keep "add a key / nameless pair to OSM_TAG_MAP" from
 * silently importing nothing — the failure they exist to catch is invisible at snapshot time,
 * because a row that was never imported looks exactly like a place that isn't there.
 *
 * They live here, beside the map, rather than with the connector that reads the imported table:
 * the property is Lua↔taxonomy, and this package is now the source of truth both sides mirror.
 *
 * A test may reach for `node:fs`; the package's *source* may not, and doesn't.
 */
describe("apps/atlas/osm-import/beacon-places.lua", () => {
  // Walk up from cwd (this package under turbo/pnpm, the repo root when run directly).
  let dir = process.cwd();
  while (
    !existsSync(join(dir, "apps/atlas/osm-import/beacon-places.lua")) &&
    dirname(dir) !== dir
  ) {
    dir = dirname(dir);
  }
  const lua = readFileSync(join(dir, "apps/atlas/osm-import/beacon-places.lua"), "utf8");

  it("KEYS mirrors the name-required entries' key set", () => {
    const block = /local KEYS = \{([\s\S]*?)\}/.exec(lua)?.[1] ?? "";
    const luaKeys = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const named = OSM_TAG_MAP.filter((e) => !e.nameless);
    expect(new Set(luaKeys)).toEqual(new Set(named.map((e) => e.key)));
  });

  it("NAMELESS_OK mirrors the nameless entries' exact pairs", () => {
    const block = /local NAMELESS_OK = \{([\s\S]*?)\}/.exec(lua)?.[1] ?? "";
    const pairs = [...block.matchAll(/(\w+)\s*=\s*"([^"]+)"/g)].map((m) => `${m[1]}=${m[2]}`);
    const nameless = OSM_TAG_MAP.filter((e) => e.nameless).map((e) => `${e.key}=${e.value}`);
    expect(pairs.length).toBeGreaterThan(0);
    expect(new Set(pairs)).toEqual(new Set(nameless));
  });
});
