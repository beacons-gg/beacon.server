import type { DidKey, MailboxMessage } from "@beaconsgg/protocol-types";
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { ulid } from "ulid";
import type { ServerConfig } from "../config";
import { liveView } from "../settings/live-config";
import { DidRateLimiter } from "../common/did-rate-limit";
import type { MailboxStore } from "../stores/mailbox-store";

/** How often to age out expired messages. Mailbox TTLs are long (days), so a minute is ample. */
const SWEEP_MS = 60_000;

/** The mailbox knobs the service needs, lifted out of {@link ServerConfig} so it's easy to test. */
export interface MailboxConfig {
  enabled: boolean;
  ttlSeconds: number;
  maxBody: number;
  sendMax: number;
  sendWindowMs: number;
  /** Whether the server is locked read-only (live): the sweep waits until it lifts. */
  writeLocked: boolean;
}

/** The mailbox slice, as accessors over the live config — see settings/live-config.ts. */
export function mailboxConfigFrom(c: ServerConfig): MailboxConfig {
  return liveView(c, {
    enabled: "mailboxEnabled",
    ttlSeconds: "mailboxTtlSeconds",
    maxBody: "mailboxMaxBody",
    sendMax: "mailboxSendMax",
    sendWindowMs: "mailboxSendWindowMs",
    writeLocked: "writeLocked",
  });
}

/**
 * The live-channel push seam (beacon.core `doc/spec/mailbox-client.md` §3), satisfied by
 * `MailboxGateway`. Kept as a narrow interface (not a gateway import) so the service stays
 * unit-testable without socket.io, and so the dependency points service → interface ← gateway (no
 * cycle).
 */
export interface MailboxBroadcaster {
  broadcastMail(recipient: DidKey, game: string, message: MailboxMessage): void;
}

/**
 * The mailbox capability (`doc/spec/mailbox-and-media.md` §4): store an opaque, size-bounded,
 * signed message for a recipient DID with a **server-decided** TTL, deliver it on an authenticated
 * pull, and delete it on ack or expiry. The service owns the TTL stamping, the per-DID send budget,
 * and the sweep; the controller owns request verification. All game meaning of `body` stays
 * client-side.
 */
@Injectable()
export class MailboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("Mailbox");
  private readonly limiter: DidRateLimiter;
  private readonly now: () => number;
  private sweepHandle: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly store: MailboxStore,
    private readonly cfg: MailboxConfig,
    now: () => number = () => Date.now(),
    private readonly broadcaster?: MailboxBroadcaster,
  ) {
    this.now = now;
    // A view, not a copy: pinning the two numbers here would fix the budget at boot, which is the
    // staleness this round removes. `DidRateLimiter` reads them per check.
    this.limiter = new DidRateLimiter(liveView(cfg, { windowMs: "sendWindowMs", max: "sendMax" }));
  }

  onModuleInit(): void {
    // The interval starts unconditionally and the capability is checked **per tick**. Gating the
    // interval at boot was safe while `BEACON_MAILBOX` was env-only; now that it is a runtime
    // setting, an operator enabling the mailbox got the routes and no sweep for the life of the
    // process, so every delivered message stayed on disk until the next restart — which is the
    // window this round exists to remove (`doc/spec/runtime-settings.md` §5). Nothing was ever
    // served wrongly: reads already filter on `expires_at`. The tick costs a boolean while the
    // capability is off. Catch a rejected sweep (pool exhausted, connection drop, disk error) so a
    // transient GC failure degrades cleanup rather than surfacing as an unhandled rejection that
    // can down the process.
    this.sweepHandle = setInterval(() => {
      if (!this.cfg.enabled || this.cfg.writeLocked) return;
      this.store.sweepExpired(this.nowIso()).catch((err: unknown) => {
        this.logger.warn(
          `mailbox sweep failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, SWEEP_MS);
    this.sweepHandle.unref?.();
  }
  onModuleDestroy(): void {
    if (this.sweepHandle) clearInterval(this.sweepHandle);
  }

  /** Whether the capability is enabled (routes 404 when off). */
  get enabled(): boolean {
    return this.cfg.enabled;
  }
  /** The configured max body size (bytes) — the controller returns 413 above it. */
  get maxBody(): number {
    return this.cfg.maxBody;
  }

  /** Record one send against the per-DID budget; false ⇒ over the window (429). */
  withinSendRate(did: DidKey): boolean {
    return this.limiter.check(did, this.now());
  }

  /**
   * Store a message for `to` from the verified `from`. The server stamps `receivedAt` and the
   * TTL-derived `expiresAt` (senders can't set it). Idempotent by `nonce`: a retried send returns the
   * original id. `game` is the sending game's: only that game's reads deliver it.
   */
  async send(
    to: DidKey,
    from: DidKey,
    game: string,
    body: string,
    nonce: string,
  ): Promise<{ id: string }> {
    const nowMs = this.now();
    const receivedAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + this.cfg.ttlSeconds * 1000).toISOString();
    const { id, deduped } = await this.store.send(
      { id: ulid(), to, from, game, body, receivedAt, expiresAt },
      nonce,
    );
    // Broadcast-after-commit, only on a genuine insert: a retried (deduped) send was already
    // delivered and pushed on its first pass, so re-pushing would double-deliver (beacon.core
    // `doc/spec/mailbox-client.md` §3 and §8).
    if (!deduped)
      this.broadcaster?.broadcastMail(to, game, { id, from, body, receivedAt, expiresAt });
    return { id };
  }

  /** The verified reader's non-expired messages from `game`, oldest first. */
  fetch(to: DidKey, game: string): Promise<MailboxMessage[]> {
    return this.store.fetch(to, game, this.nowIso());
  }

  /** Delete the reader's delivered messages from `game` by id; returns the number removed. */
  ack(to: DidKey, game: string, ids: string[]): Promise<number> {
    return this.store.ack(to, game, ids);
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }
}
