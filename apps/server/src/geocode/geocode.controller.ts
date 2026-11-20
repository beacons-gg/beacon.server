import { geohashCellSchema } from "@beaconsgg/protocol-types";
import { Controller, Get, HttpException, Query, UseGuards } from "@nestjs/common";
import { badRequest, notFound } from "../common/capability-http";
import { ReadRateLimitGuard } from "../common/read-rate-limit.guard";
import { GeocodeService } from "./geocode.service";

/**
 * The geocode capability endpoint (`doc/spec/location-lookups.md` §4): `GET /geocode?geohash=`.
 * Read-only + public (no signature) — abuse is bounded by the {@link ReadRateLimitGuard} + the
 * coarse-cell cache. Returns a reverse-geocoded place label. When the capability is disabled, the
 * route 404s; a malformed geohash is `400`; an upstream provider failure is a soft `503`.
 */
@Controller()
export class GeocodeController {
  constructor(private readonly geocode: GeocodeService) {}

  @Get("geocode")
  @UseGuards(ReadRateLimitGuard)
  async lookup(@Query("geohash") geohash?: string) {
    if (!this.geocode.enabled) notFound();

    const parsed = geohashCellSchema.safeParse(geohash);
    if (!parsed.success) badRequest("`geohash` must be a valid geohash cell");

    const out = await this.geocode.lookup(parsed.data);
    if (!out.ok) {
      throw new HttpException({ ok: false, error: out.error, message: out.message }, out.status);
    }
    return out.result;
  }
}
