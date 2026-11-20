import { type DidKey, type OpEnvelope, mailboxBodyBytes } from "@beaconsgg/protocol-types";
import { Body, Controller, HttpException, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { notFound, parseParams, replayConflict } from "../common/capability-http";
import { nonceKey } from "../stores/nonce-store";
import { GameGate } from "../common/game-gate";
import { SignedRequestGate } from "../common/signed-request-gate";
import { NonceService } from "../common/nonce.service";
import { SIGNED_ROUTES } from "../common/signed-routes";
import { WriteRateLimitGuard } from "../common/rate-limit.guard";
import { SignedReadRateLimitGuard } from "../common/read-rate-limit.guard";
import { MailboxService } from "./mailbox.service";

/**
 * The mailbox capability endpoints (`doc/spec/mailbox-and-media.md` §4.4). Every route is a
 * **signed request** (an `OpEnvelope` with a `mailbox.*` op); `verifyOp` establishes the actor
 * cryptographically, so sends are attributed and reads/acks are scoped to the verified reader. All
 * three are POST because they carry a signature (a fetch is a signed read, exactly like the
 * engine's `list` op) — there is deliberately **no** unauthenticated "read inbox by DID" (it would
 * leak the social graph and let anyone drain a box). When the capability is disabled the routes
 * 404.
 */
@Controller()
export class MailboxController {
  constructor(
    private readonly mailbox: MailboxService,
    private readonly gate: SignedRequestGate,
    private readonly nonce: NonceService,
    private readonly games: GameGate,
  ) {}

  /** Send an opaque message to a recipient DID (idempotent by the envelope nonce, replay-safe). */
  @Post("mailbox")
  @UseGuards(WriteRateLimitGuard)
  async send(@Body() body: unknown): Promise<{ ok: true; id: string }> {
    const route = SIGNED_ROUTES.mailbox;
    this.assertEnabled();
    const signed = this.gate.verifyWrite(body, route.op);
    const { actor, env } = signed;
    // A send is a game write: it names its game, and this server must take that game.
    this.games.assertAdmits(env.game);
    const game = env.game;

    // Replay/idempotency: a re-sent nonce returns the original id from the durable log — without
    // re-inserting — so it survives even after the message was acked or swept (no resurrection).
    // A refusal inside the bracket records nothing, so the checks run only for a new request.
    const { id } = await this.nonce.idempotentResult(signed, async () => {
      // Before the schema, so an over-size body is `413 tooLarge` and not `400`. UTF-16 units
      // never outnumber UTF-8 bytes, so the length settles a long body without encoding it.
      const sent = env.params["body"];
      const max = this.mailbox.maxBody;
      if (typeof sent === "string" && (sent.length > max || mailboxBodyBytes(sent) > max)) {
        throw new HttpException(
          { ok: false, error: "tooLarge", message: `body exceeds ${max} bytes` },
          HttpStatus.PAYLOAD_TOO_LARGE,
        );
      }
      const params = parseParams(route.params, env.params);

      // Per-DID send budget (keyed on the verified sender, so it can't be rotated away).
      if (!this.mailbox.withinSendRate(actor)) {
        throw new HttpException(
          { ok: false, error: "rateLimited", message: "too many messages" },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      const stored = await this.mailbox.send(params.to, actor, game, params.body, env.nonce);
      return { id: stored.id };
    });
    return { ok: true, id };
  }

  /** Authenticated read: return only the verified reader's non-expired messages. */
  @Post("mailbox/fetch")
  @UseGuards(SignedReadRateLimitGuard)
  async fetch(@Body() body: unknown): Promise<{ ok: true; messages: unknown[] }> {
    const route = SIGNED_ROUTES["mailbox/fetch"];
    const signed = this.verify(body, route.op);
    // A read, so not admission; but a box is read per game, so it needs one.
    this.games.requireGame(signed.env.game);
    // The params are empty, and parsed strictly like every other signed read's.
    parseParams(route.params, signed.env.params);
    // A read has no idempotent result to replay, so a re-used read nonce is rejected — a captured
    // fetch envelope can't be replayed to re-read the box. Legit retries use a fresh nonce. The
    // nonce is spent only once the read succeeds, so a fault leaves the same request retryable.
    const key = nonceKey(signed);
    if (await this.nonce.check(key)) replayConflict();
    const messages = await this.mailbox.fetch(signed.actor, signed.env.game);
    await this.nonce.remember(key, "");
    return { ok: true, messages };
  }

  /** Delete the reader's delivered messages (they must belong to the verified reader). */
  @Post("mailbox/ack")
  @UseGuards(WriteRateLimitGuard)
  async ack(@Body() body: unknown): Promise<{ ok: true; deleted: number }> {
    const route = SIGNED_ROUTES["mailbox/ack"];
    const signed = this.verify(body, route.op);
    const { actor, env } = signed;
    this.games.requireGame(env.game);
    const game = env.game;
    const params = parseParams(route.params, env.params);
    const { deleted } = await this.nonce.idempotentResult(signed, async () => ({
      deleted: await this.mailbox.ack(actor, game, params.ids),
    }));
    return { ok: true, deleted };
  }

  /**
   * Capability gate: 404 when disabled, else the shared signed-request gate (signature verified →
   * actor is cryptographic → sender not blocked → device not revoked). Returns the actor + envelope.
   */
  private verify(body: unknown, op: string): { actor: DidKey; env: OpEnvelope } {
    this.assertEnabled();
    return this.gate.verify(body, op);
  }

  private assertEnabled(): void {
    if (!this.mailbox.enabled) notFound("mailbox capability not enabled");
  }
}
