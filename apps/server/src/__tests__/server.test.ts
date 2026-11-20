import { describe, expect, it } from "vitest";
import { statusForError } from "../rooms/http-status";
import { testConfig } from "./test-config";

describe("statusForError", () => {
  it("maps op rejection codes to HTTP statuses (room-operation.md §11)", () => {
    expect(statusForError("badsig")).toBe(401);
    expect(statusForError("denied")).toBe(403);
    expect(statusForError("gameNotAdmitted")).toBe(403); // same status, distinct code
    expect(statusForError("unknownRoom")).toBe(404);
    expect(statusForError("expired")).toBe(404);
    expect(statusForError("phase")).toBe(409);
    expect(statusForError("full")).toBe(409);
    expect(statusForError("gone")).toBe(409);
    expect(statusForError("empty")).toBe(409);
    expect(statusForError("locked")).toBe(409);
    expect(statusForError("stale")).toBe(409);
    expect(statusForError("rateLimited")).toBe(429);
    expect(statusForError("invalid")).toBe(400);
  });
});

describe("loadConfig", () => {
  it("accepts sane defaults", () => {
    const config = testConfig({});
    expect(config.port).toBe(3001);
    expect(config.host).toBe("localhost:3001");
    expect(config.publicUrl).toBe("http://localhost:3001");
    expect(config.coverage).toEqual([""]); // dev default = covers all cells
    expect(config.name).toBe("Beacon Dev Server");
    expect(config.corsOrigins).toEqual([]); // empty = allow all
    expect(config.trustProxy).toBe(false); // trust none by default (non-spoofable rate-limit key)
  });

  it("is open to every game by default, and says so by advertising no game: marker", () => {
    const config = testConfig({});
    expect(config.games).toEqual([]);
    expect(config.capabilities.filter((c) => c.startsWith("game"))).toEqual([]);
    // The engine's markers are a property of the build, so they ride even a default config: the
    // per-op `games` rule is the first policy addition (`doc/spec/room-operation.md` §8.2).
    expect(config.capabilities).toContain("policy:ops.games");
  });

  it("advertises one game:<slug> marker per admitted slug", () => {
    const config = testConfig({ BEACON_GAMES: "kites, other-game/2" });
    expect(config.games).toEqual(["kites", "other-game/2"]);
    expect(config.capabilities).toEqual(
      expect.arrayContaining(["game:kites", "game:other-game/2"]),
    );
  });

  it("refuses to boot on a malformed BEACON_GAMES", () => {
    // Loud beats quiet: a typo'd slug would otherwise advertise and admit a game nobody
    // meant, and the operator would have no way to see it from the outside.
    expect(() => testConfig({ BEACON_GAMES: "Kites" })).toThrow(/BEACON_GAMES/);
    expect(() => testConfig({ BEACON_GAMES: "a:b" })).toThrow(/BEACON_GAMES/);
  });

  it("parses BEACON_TRUST_PROXY into an Express trust-proxy value", () => {
    expect(testConfig({ BEACON_TRUST_PROXY: "1" }).trustProxy).toBe(1); // N hops behind a proxy
    expect(testConfig({ BEACON_TRUST_PROXY: "true" }).trustProxy).toBe(true); // opt-in trust-all
    expect(testConfig({ BEACON_TRUST_PROXY: "false" }).trustProxy).toBe(false);
    expect(testConfig({ BEACON_TRUST_PROXY: "garbage" }).trustProxy).toBe(false); // safe fallback
  });

  it("reads the P2 hardening + identity env", () => {
    const config = testConfig({
      PORT: "4000",
      BEACON_HOST: "beacon.example:4000",
      BEACON_PUBLIC_URL: "https://beacon.example",
      BEACON_COVERAGE: "c23n, c23p",
      BEACON_NAME: "Prod",
      BEACON_MNEMONIC: "seed phrase",
      BEACON_CORS_ORIGINS: "https://app.example, https://admin.example",
      BEACON_DATABASE_URL: "postgres://localhost/x",
    });
    expect(config.port).toBe(4000);
    expect(config.host).toBe("beacon.example:4000");
    expect(config.publicUrl).toBe("https://beacon.example");
    expect(config.coverage).toEqual(["c23n", "c23p"]);
    expect(config.name).toBe("Prod");
    expect(config.mnemonic).toBe("seed phrase");
    expect(config.corsOrigins).toEqual(["https://app.example", "https://admin.example"]);
    expect(config.databaseUrl).toBe("postgres://localhost/x");
  });

  it("rejects a non-numeric / out-of-range PORT", () => {
    expect(() => testConfig({ PORT: "not-a-port" })).toThrow(/PORT/);
    expect(() => testConfig({ PORT: "70000" })).toThrow(/PORT/);
  });

  it("rejects a host with characters outside the GlobalId host class", () => {
    expect(() => testConfig({ BEACON_HOST: "bad host!" })).toThrow(/BEACON_HOST/);
  });
});
