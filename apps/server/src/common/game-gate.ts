import { Inject, Injectable } from "@nestjs/common";
import type { ServerConfig } from "../config";
import { liveView } from "../settings/live-config";
import { denied } from "./capability-http";

/** DI token for the admission policy (`BEACON_GAMES`). */
export const GAMES_POLICY = "BEACON_GAMES_POLICY";

/** What the gate needs, resolved from config once at boot rather than read per request. */
export interface GamesPolicy {
  /** Admitted game slugs (`BEACON_GAMES`). Empty means every game is admitted. */
  readonly admitted: readonly string[];
}

/**
 * The game-admission slice, as an accessor over the live config — see settings/live-config.ts.
 *
 * A runtime setting, so opening or closing this server to a game is a signed admin write rather
 * than a redeploy. `loadConfig` still validates slugs at boot and the registry's `gameSlugSchema`
 * validates every admin write, so neither path can install a malformed slug.
 */
export function gamesPolicyFrom(c: ServerConfig): GamesPolicy {
  return liveView(c, { admitted: "games" });
}

/**
 * The one game gate (`doc/spec/room-operation.md` §5). One injectable, so every gated path shares a
 * verdict and a message rather than keeping its own copy of a `.includes()` to drift.
 *
 * **Every game write names its game, and this server decides which games it takes.** The writes:
 *
 * - `POST /rooms` and `POST /rooms/:id/ops` — content placed into the operator's world (the op
 *   path consults through the engine's `isAppDenied`).
 * - `POST /scouts` — a game's presence relayed on the operator's server.
 * - `POST /places/propose` — a durable row in the operator's curated dataset.
 * - `POST /mailbox` and `POST /media` — a game's own message format, and storage the operator
 *   pays for on behalf of the game that uploaded it. An operator's own upload naming no game (the
 *   console's place photos) is the operator's, and the media route admits it.
 *
 * **Not gated:** the admin surface, which must stay out (a misconfigured list must never lock an
 * operator out of the console they would fix it from), and `POST /profiles`, which is the player
 * across every game and carries no envelope. The signed mailbox reads need a slug to filter by
 * ({@link requireGame}) but are not admission: reading your own mail is not writing to the server.
 *
 * **The slug is self-attested.** It rides inside the signed envelope, so it is tamper-evident, but
 * the signer is the player's device key and a modified build holds one of those too. This is
 * segmentation between cooperative games, not anti-cheat, which is why the policy is an allowlist
 * and never a denylist: a denied slug is evaded by renaming, while the only way to evade an
 * allowlist is to claim to be the admitted game, which is exactly what the admitted game claims.
 *
 * The verdict in one line: no slug is refused; a slug is admitted when the list is empty or names it.
 */
@Injectable()
export class GameGate {
  constructor(@Inject(GAMES_POLICY) private readonly policy: GamesPolicy) {}

  /** The verdict: may a write produced by this game be applied here? */
  admits(game: string | undefined): boolean {
    if (game === undefined) return false;
    return this.policy.admitted.length === 0 || this.policy.admitted.includes(game);
  }

  /**
   * The HTTP form, for the boundaries that verify their own envelopes. `403` with a code of its own
   * inside the shared status, so a client can tell "you are blocked here" from "your game is not
   * welcome here": the first means retry nothing, the second means stop offering this server for
   * writes and tell the player why.
   */
  assertAdmits(game: string | undefined): asserts game is string {
    this.requireGame(game);
    if (!this.admits(game)) denied("game not admitted", "gameNotAdmitted");
  }

  /** Refuse a signed request that names no game: every game write and game-scoped read needs one. */
  requireGame(game: string | undefined): asserts game is string {
    if (game === undefined) denied("game slug required", "gameNotAdmitted");
  }
}
