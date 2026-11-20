import { mediaUploadSchema } from "@beaconsgg/protocol-types";
import {
  Body,
  Controller,
  Get,
  HttpException,
  Param,
  Post,
  Res,
  StreamableFile,
  UseGuards,
  Inject,
} from "@nestjs/common";
import { missing, notFound, parseParams } from "../common/capability-http";
import { ADMINS } from "../common/admin-gate";
import { GameGate } from "../common/game-gate";
import { SignedRequestGate } from "../common/signed-request-gate";
import { NonceService } from "../common/nonce.service";
import { SIGNED_ROUTES } from "../common/signed-routes";
import { WriteRateLimitGuard } from "../common/rate-limit.guard";
import { PlayerReadRateLimitGuard } from "../common/read-rate-limit.guard";
import { MediaService } from "./media.service";

/** The minimal Express response surface the media fetch uses (avoids an `@types/express` dependency). */
interface HttpResponseLike {
  set(field: string, value: string): void;
  redirect(statusCode: number, url: string): void;
}

/**
 * The media capability endpoints (`doc/spec/mailbox-and-media.md` §5.3). Upload is a **signed
 * request** (an `OpEnvelope`, op `media.put`) attesting the content hash; the server re-hashes,
 * detect-and-rejects metadata, and stores the exact bytes. Fetch is **public** and
 * content-addressed (immutable cache). When the capability is disabled, both routes 404.
 */
@Controller()
export class MediaController {
  constructor(
    private readonly media: MediaService,
    private readonly gate: SignedRequestGate,
    private readonly nonce: NonceService,
    private readonly games: GameGate,
    @Inject(ADMINS) private readonly admins: string[],
  ) {}

  /** Upload media: verify signature + hash, reject dirty/oversize/over-quota, store content-addressed. */
  @Post("media")
  @UseGuards(WriteRateLimitGuard)
  async put(@Body() body: unknown): Promise<{ ok: true; id: string }> {
    if (!this.media.enabled) notFound();

    const wrapper = parseParams(mediaUploadSchema, body);

    const route = SIGNED_ROUTES.media;
    const req = this.gate.verifyWrite(wrapper.env, route.op);
    // An upload is storage the operator holds for the game that sent it, so a game write. Except the
    // operator's own (the console's place photos), which names no game: it is nobody's game's, the
    // same reason the admin surface is never game-gated.
    const operatorsOwn = req.env.game === undefined && this.admins.includes(req.actor);
    if (!operatorsOwn) this.games.assertAdmits(req.env.game);

    const params = parseParams(route.params, req.env.params);

    // Replay/idempotency: a re-sent nonce returns the stored address without re-decoding,
    // re-hashing, or re-scanning the bytes (`doc/spec/mailbox-and-media.md` §3.2).
    const { id } = await this.nonce.idempotentResult(req, async () => {
      const result = await this.media.put(req.actor, params, Buffer.from(wrapper.data, "base64"));
      if (!result.ok) {
        throw new HttpException(
          { ok: false, error: result.error, message: result.message },
          result.status,
        );
      }
      return { id: result.id };
    });
    return { ok: true, id };
  }

  /**
   * Public content-addressed fetch. Content is immutable (the address *is* its hash), so it carries a
   * long immutable cache header either way. With an S3+CDN backend this **302-redirects** to the CDN
   * (bytes never proxy through the app); otherwise it **streams** the exact stored bytes so the client
   * can re-verify the hash.
   *
   * The player-state read budget bounds requests to *this* route only. On the CDN-redirect path the
   * bytes are served by a public URL that carries nothing and is shareable once addressed, so a
   * private server either does not use CDN redirect or accepts that its media is public once its
   * hash is known.
   */
  @Get("media/:hash")
  @UseGuards(PlayerReadRateLimitGuard)
  async get(
    @Param("hash") hash: string,
    @Res({ passthrough: true }) res: HttpResponseLike,
  ): Promise<StreamableFile | undefined> {
    if (!this.media.enabled) notFound();
    const found = await this.media.get(hash);
    if (!found) missing("unknownMedia", "no media has that hash");
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    if (found.location.kind === "redirect") {
      res.redirect(302, found.location.url);
      return undefined;
    }
    return new StreamableFile(found.location.stream, { type: found.type });
  }
}
