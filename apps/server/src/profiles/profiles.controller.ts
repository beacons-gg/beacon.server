import { MAX_PROFILE_BYTES } from "@beaconsgg/protocol-types";
import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { WriteRateLimitGuard } from "../common/rate-limit.guard";
import { PlayerReadRateLimitGuard } from "../common/read-rate-limit.guard";
import { ProfilesService } from "./profiles.service";

/**
 * The profiles capability endpoints (beacon.core `doc/spec/identity.md` §6): publish a self-signed
 * profile into the revocation registry (rate-limited; a non-advancing `version` → 409, a bad
 * signature → 400, a blocked account → 403, over the size cap → 413), and resolve one by `did:key`
 * (an unguarded public read, the doc is self-signed). Unlike mailbox/media this route family has no
 * capability gate — profiles are always on.
 */
@Controller()
export class ProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  /**
   * Publish a self-signed profile (beacon.core `doc/spec/identity.md` §6) so the server can enforce
   * revocation. The body is verified + high-water-checked by the registry; a non-advancing
   * `version` is a 409 (so a replayed pre-revocation profile can't roll revocation back), a bad
   * signature a 400, a blocked account a 403, and a doc over `MAX_PROFILE_BYTES` a 413. The body
   * goes to the registry as received, not through the strict schema (see `publish`).
   */
  @Post("profiles")
  @UseGuards(WriteRateLimitGuard)
  async publish(@Body() body: unknown) {
    const result = await this.profiles.publish(body);
    if (!result.ok) {
      if (result.error === "tooLarge") {
        // The code, name and message shape mailbox and media use.
        throw new HttpException(
          { ok: false, error: "tooLarge", message: `profile exceeds ${MAX_PROFILE_BYTES} bytes` },
          HttpStatus.PAYLOAD_TOO_LARGE,
        );
      }
      const status =
        result.error === "stale"
          ? HttpStatus.CONFLICT
          : result.error === "denied"
            ? HttpStatus.FORBIDDEN // a blocked account, the same 403 the other surfaces return
            : HttpStatus.BAD_REQUEST;
      throw new HttpException({ ok: false, error: result.error }, status);
    }
    return { ok: true, id: result.profile.id, version: result.profile.version };
  }

  /**
   * Resolve an account's public profile by its `did:key` (beacon.core `doc/spec/identity.md` §6) —
   * how another player looks up a scout owner's / contributor's display name + avatar. Unguarded
   * read (like `GET /rooms/:id`); the doc is self-signed, so the client verifies it. Only this
   * server's copy — cross-server aggregation is not built, so a 404 here just means "not published
   * to this server."
   */
  @Get("profiles/:id")
  @UseGuards(PlayerReadRateLimitGuard)
  resolve(@Param("id") id: string) {
    const profile = this.profiles.get(id);
    if (!profile) {
      throw new HttpException({ ok: false, error: "unknownProfile" }, HttpStatus.NOT_FOUND);
    }
    return profile;
  }
}
