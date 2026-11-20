import type { DidKey, MailboxMessage } from "@beaconsgg/protocol-types";
import { codeFor, parseUnderstands } from "@beaconsgg/protocol-types/server";
import { Inject, Logger } from "@nestjs/common";
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import type { Namespace, Socket } from "socket.io";
import { boolEnv } from "../common/env";
import { SignedRequestGate } from "../common/signed-request-gate";
import type { ServerConfig } from "../config";
import { SERVER_CONFIG } from "../settings/live-config";
import type { MailboxBroadcaster } from "./mailbox.service";

/** The op a `mailbox:subscribe` envelope must name (beacon.core `doc/spec/mailbox-client.md` §3). */
export const MAILBOX_SUBSCRIBE_OP = "mailbox.subscribe";

/** The socket.io room a recipient's live pushes fan out to: the **verified** actor DID, and their game. */
const MBX_ROOM = (did: string, game: string): string => `mbx:${did}:${game}`;

/**
 * The mailbox **live channel** (beacon.core `doc/spec/mailbox-client.md` §3) — a dedicated
 * `/mailbox` namespace, kept separate from the public `RoomsGateway` because this channel is
 * **private**. Unlike the room/map `subscribe` (public, unauthenticated), a `mailbox:subscribe`
 * carries a **signed** envelope: the socket is joined to a room keyed on the
 * *cryptographically-derived* actor DID (`SignedRequestGate`), so no one can join another player's
 * box — a forged/replayed subscribe only ever re-joins the box of whoever holds the signing key,
 * which is why no nonce dedup is needed here.
 *
 * Transport rule (beacon.core `doc/spec/mailbox-client.md` §0.1): `mailbox:subscribe` is a
 * **control message** (join a fan-out room); it mutates no state. All state changes (`send`/`ack`)
 * go over REST. The gateway only ever emits `mail` server→client, fanned out by {@link
 * broadcastMail} after `MailboxService.send` commits.
 */
@WebSocketGateway({ namespace: "/mailbox", cors: { origin: true } })
export class MailboxGateway
  implements MailboxBroadcaster, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() server!: Namespace;
  private readonly logger = new Logger(MailboxGateway.name);
  /** Opt-in verbose live-channel logging (`BEACON_WS_DEBUG=1`), mirroring `RoomsGateway`. */
  private readonly debug = boolEnv("BEACON_WS_DEBUG");

  constructor(
    private readonly gate: SignedRequestGate,
    /** The live view: `BEACON_MAILBOX` is a runtime setting, so it is read per subscribe. */
    @Inject(SERVER_CONFIG) private readonly config: Pick<ServerConfig, "mailboxEnabled">,
  ) {}

  handleConnection(client: Socket): void {
    if (!this.debug) return;
    const transport = client.conn?.transport?.name ?? "?";
    this.logger.log(`mailbox ws connect id=${client.id} transport=${transport}`);
  }

  handleDisconnect(client: Socket): void {
    if (this.debug) this.logger.log(`mailbox ws disconnect id=${client.id}`);
  }

  /**
   * Signed subscribe: ask the shared gate (→ cryptographic actor, not blocked, device not revoked),
   * then join the socket to the actor's private room. A socket serves one identity at a time, so any
   * prior `mbx:*` join is left first (a re-subscribe after a key rotation re-homes cleanly).
   *
   * This is the one signed surface in the server that is not an HTTP route, which is why it asks
   * through `check` rather than `verify` and keeps its own `{ok, error}` ack. Being off the route
   * list is also how it went uncovered: a revoked device that can no longer `POST /mailbox/fetch`
   * would otherwise still sit in this room and receive the same messages, one push at a time.
   */
  @SubscribeMessage("mailbox:subscribe")
  onSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { env?: unknown },
  ): { ok: boolean; error?: string } {
    // The REST routes answer 404 `unknownRoute` while the mailbox is off; the socket refuses with
    // the same code rather than joining a room that no send will ever reach. `denied` would read as
    // a blocked sender or a revoked device.
    if (!this.config.mailboxEnabled) return { ok: false, error: "unknownRoute" };
    const req = this.gate.check(body?.env, MAILBOX_SUBSCRIBE_OP);
    if (!req.ok) {
      if (this.debug)
        this.logger.log(`mailbox:subscribe id=${client.id} -> rejected (${req.message})`);
      // Global filters never reach a gateway, so the one socket refusal that can carry a code newer
      // than its caller downgrades itself, from the declaration the socket made on connect.
      return {
        ok: false,
        error: codeFor(req.error, parseUnderstands(client.handshake?.auth?.["understands"])),
      };
    }
    // Scoped to the subscriber's game, like `mailbox.fetch`: a socket only carries its game's mail.
    // The old box is left first, so a refused re-subscribe does not keep the earlier one live.
    for (const r of client.rooms) if (r.startsWith("mbx:")) void client.leave(r);
    const game = req.env.game;
    if (game === undefined) return { ok: false, error: "gameNotAdmitted" };
    void client.join(MBX_ROOM(req.actor, game));
    if (this.debug) this.logger.log(`mailbox:subscribe id=${client.id} actor=${req.actor} -> ok`);
    return { ok: true };
  }

  /**
   * Push a delivered message to any connected socket for `recipient` (best-effort; a recipient who
   * isn't subscribed simply catches up on their next `POST /mailbox/fetch`). Called by
   * `MailboxService.send` **after** the durable commit, so a dropped push degrades liveness, never
   * consistency.
   */
  broadcastMail(recipient: DidKey, game: string, message: MailboxMessage): void {
    this.server?.to(MBX_ROOM(recipient, game)).emit("mail", message);
    if (this.debug) {
      const watchers = this.server?.adapter?.rooms?.get(MBX_ROOM(recipient, game))?.size ?? 0;
      this.logger.log(`mail -> recipient=${recipient} id=${message.id} watchers=${watchers}`);
    }
  }
}
