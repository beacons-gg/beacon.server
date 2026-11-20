import { discoveryQuerySchema, geohashCellSchema } from "@beaconsgg/protocol-types";
import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import {
  DescriptorRateLimitGuard,
  PlayerReadRateLimitGuard,
} from "../common/read-rate-limit.guard";
import { RoomsService } from "../rooms/rooms.service";
import { ScoutsService } from "../scouts/scouts.service";
import { ServerIdentity } from "../server-identity";
import {
  MAX_QUERY_CELLS,
  MAX_QUERY_TYPES,
  gamesQueryParam,
  validatedCsvParam,
} from "../common/query";

/** A `types` filter token: the wire's own rule, matched in JS via `includes`, never in SQL. */
const typeTokenSchema = discoveryQuerySchema.shape.types.unwrap().element;

/**
 * Anonymous spatial discovery endpoints: `GET /discovery` (cells + optional `types` →
 * objects/scouts in view, beacon.core `doc/spec/discovery.md` §4.1) and `GET /server/descriptor`
 * (the signed coverage advertisement, beacon.core `doc/spec/discovery.md` §3.2). Read-only +
 * unauthenticated; query params are geohash-charset validated and count-capped before any store
 * query (the geo cost trap).
 *
 * Both are budgeted, on **separate** buckets. Discovery carries the player-state budget; the
 * descriptor has its own, because it signs per request and because it is the door a client must get
 * through to add the server at all, so the hot path must not be able to close it. Neither guard is
 * an admission gate: reads stay anonymous, and bounding the rate is not the same as bounding who
 * may ask.
 */
@Controller()
export class DiscoveryController {
  constructor(
    private readonly rooms: RoomsService,
    private readonly scouts: ScoutsService,
    private readonly identity: ServerIdentity,
  ) {}

  /** Anonymous spatial discovery (beacon.core `doc/spec/discovery.md` §4.1): `?cells=…&types=…`. */
  @Get("discovery")
  @UseGuards(PlayerReadRateLimitGuard)
  async discover(
    @Query("cells") cells?: string | string[],
    @Query("types") types?: string | string[],
    @Query("games") games?: string | string[],
  ) {
    // Validate against the geohash-charset allowlist + a count cap before the cells reach a store
    // query — rejects `%`/`_`/quotes and an unbounded list (see ../common/query.ts).
    const cellList = validatedCsvParam(cells, geohashCellSchema, {
      label: "cells",
      min: 1,
      max: MAX_QUERY_CELLS,
    });
    const typeList =
      types !== undefined
        ? validatedCsvParam(types, typeTokenSchema, { label: "types", max: MAX_QUERY_TYPES })
        : undefined;
    // Rooms the listed games own or may act on, and only their scouts. Absent: every game's.
    const gameList = gamesQueryParam(games);
    const response = await this.rooms.discover(cellList, typeList, gameList);
    const wantScouts = !typeList || typeList.includes("scout");
    return {
      ...response,
      scouts: wantScouts ? this.scouts.scoutsInView(cellList, Date.now(), gameList) : [],
    };
  }

  /** The signed server coverage advertisement (beacon.core `doc/spec/discovery.md` §3.2). */
  @Get("server/descriptor")
  @UseGuards(DescriptorRateLimitGuard)
  descriptor() {
    return this.identity.descriptor(new Date().toISOString());
  }
}
