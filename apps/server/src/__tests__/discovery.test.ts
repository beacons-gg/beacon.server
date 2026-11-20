import { discoveryQuerySchema } from "@beaconsgg/protocol-types";
import { HttpException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { MAX_QUERY_CELLS, MAX_QUERY_GAMES, MAX_QUERY_TYPES } from "../common/query";
import { DiscoveryController } from "../discovery/discovery.controller";
import type { RoomsService } from "../rooms/rooms.service";
import type { ScoutsService } from "../scouts/scouts.service";
import type { ServerIdentity } from "../server-identity";

/** A DiscoveryController over stub services — we're exercising the query validation, not discovery. */
function makeController(
  seen: { games?: string[] | undefined }[] = [],
  scoutsInView: ScoutsService["scoutsInView"] = () => [],
): DiscoveryController {
  const rooms = {
    discover: (_cells: string[], _types?: string[], games?: string[]) => {
      seen.push({ games });
      return Promise.resolve({ coveredBy: "h", rooms: [], scouts: [] });
    },
  } as unknown as RoomsService;
  const scouts = { scoutsInView } as unknown as ScoutsService;
  const identity = { descriptor: () => ({}) } as unknown as ServerIdentity;
  return new DiscoveryController(rooms, scouts, identity);
}

describe("DiscoveryController /discovery cell validation", () => {
  it("rejects a LIKE/GLOB wildcard cell with 400", async () => {
    await expect(makeController().discover("%")).rejects.toBeInstanceOf(HttpException);
  });

  it("rejects more than 256 cells with 400 (geo cost trap)", async () => {
    const many = Array.from({ length: 257 }, () => "gcpv").join(",");
    await expect(makeController().discover(many)).rejects.toBeInstanceOf(HttpException);
  });

  it("requires at least one cell", async () => {
    await expect(makeController().discover(undefined)).rejects.toBeInstanceOf(HttpException);
  });

  it("accepts valid geohash cells", async () => {
    await expect(makeController().discover("gcpv,u4pr")).resolves.toMatchObject({ rooms: [] });
  });
});

describe("DiscoveryController /discovery games filter", () => {
  it("hands the listed games to both the rooms query and the scout read", async () => {
    const seen: { games?: string[] | undefined }[] = [];
    const scoutGames: (readonly string[] | undefined)[] = [];
    const controller = makeController(seen, (_cells, _now, games) => {
      scoutGames.push(games);
      return [];
    });
    await controller.discover("gcpv", undefined, "game-a");
    await controller.discover("gcpv", undefined, ["game-a", "game-b"]); // a repeated `games` key
    await controller.discover("gcpv");
    expect(seen.map((s) => s.games)).toEqual([["game-a"], ["game-a", "game-b"], undefined]);
    expect(scoutGames).toEqual([["game-a"], ["game-a", "game-b"], undefined]);
  });

  it("rejects a malformed slug, and an empty filter, with 400", async () => {
    await expect(makeController().discover("gcpv", undefined, "Game A")).rejects.toBeInstanceOf(
      HttpException,
    );
    await expect(makeController().discover("gcpv", undefined, "")).rejects.toBeInstanceOf(
      HttpException,
    );
  });
});

describe("DiscoveryController /discovery bounds", () => {
  type Query = { cells: string[]; types?: string[]; games?: string[] };
  const list = (n: number, of: string) => Array.from({ length: n }, () => of);
  const controllerAccepts = (q: Query) =>
    makeController()
      .discover(q.cells.join(","), q.types?.join(","), q.games?.join(","))
      .then(
        () => true,
        (err: unknown) => {
          expect(err).toBeInstanceOf(HttpException);
          return false;
        },
      );

  // Core 1.0's `discoveryQuerySchema` carries the bounds this controller applies. The server keeps
  // its own checks (common/query.ts says why), so the two must agree: a query one accepts and the
  // other refuses is a client that validates locally and is still refused, or the reverse.
  it("accepts and refuses what discoveryQuerySchema does", async () => {
    const queries: Query[] = [];
    for (const n of [0, 1, MAX_QUERY_CELLS, MAX_QUERY_CELLS + 1]) {
      queries.push({ cells: list(n, "gcpv") });
    }
    for (const n of [0, 1, MAX_QUERY_TYPES, MAX_QUERY_TYPES + 1]) {
      queries.push({ cells: ["gcpv"], types: list(n, "jar") });
    }
    for (const n of [0, 1, MAX_QUERY_GAMES, MAX_QUERY_GAMES + 1]) {
      queries.push({ cells: ["gcpv"], games: list(n, "game-a") });
    }
    // Each token's own rule.
    queries.push(
      { cells: ["gcpv"], types: ["x".repeat(32)] },
      { cells: ["gcpv"], types: ["x".repeat(33)] },
      { cells: ["a"] }, // outside the geohash alphabet
      { cells: ["gcpv"], games: ["Game A"] },
    );
    for (const q of queries) {
      const schema = discoveryQuerySchema.safeParse(q).success;
      expect(await controllerAccepts(q), JSON.stringify(q).slice(0, 80)).toBe(schema);
    }
  });
});
