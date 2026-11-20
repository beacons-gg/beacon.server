import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { replayConflict } from "./capability-http";
import { type NonceKey, type NonceStore, type SignedBy, nonceKey } from "../stores/nonce-store";

/** How often to age out expired nonces. Retention is minutes, so a minute's granularity is ample. */
const SWEEP_MS = 60_000;

/** The nonce knob the service needs: how long a seen nonce is remembered. */
export interface NonceConfig {
  /** How long a seen nonce is remembered — must be ≥ the request freshness window (`doc/spec/mailbox-and-media.md` §3.2). */
  retentionMs: number;
  /** Whether the server is locked read-only (live): the sweep waits until it lifts. */
  writeLocked: boolean;
}

/**
 * The durable replay/idempotency guard for signed capability requests
 * (`doc/spec/mailbox-and-media.md` §3.2), shared by the mailbox and media controllers. It wraps the
 * {@link NonceStore} with the retention policy and a TTL sweep; the controllers decide per op
 * whether a replay **returns the stored result** (writes — idempotent retry) or is **rejected**
 * (reads — fetch).
 *
 * This is what makes replay protection independent of the message/media record's lifetime: a re-sent
 * `mailbox.send` returns the original id via the log even after the message was acked/swept, so it is
 * never re-inserted (the resurrection bug the message-row `UNIQUE(nonce)` could not prevent).
 */
@Injectable()
export class NonceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("Nonce");
  private readonly now: () => number;
  private sweepHandle: ReturnType<typeof setInterval> | undefined;
  /** When this service started, which bounds how long it reads unscoped records. */
  private readonly startedAt: number;

  constructor(
    private readonly store: NonceStore,
    private readonly cfg: NonceConfig,
    now: () => number = () => Date.now(),
  ) {
    this.now = now;
    this.startedAt = now();
  }

  onModuleInit(): void {
    // Unconditional. This used to be skipped unless a signed surface was enabled at boot, which was
    // safe only while the capability toggles were env-only: `check`/`remember` never consulted the
    // flag, so enabling a capability at runtime meant nonces accumulating with nothing to age them
    // out (`doc/spec/runtime-settings.md` §3.4). An interval over an empty table costs less than
    // tracking it. Catch a rejected sweep so a transient GC failure degrades cleanup, not
    // availability.
    this.sweepHandle = setInterval(() => {
      if (this.cfg.writeLocked) return; // checked per tick, so an unlock needs no restart
      this.store.sweepExpired(this.nowIso()).catch((err: unknown) => {
        this.logger.warn(`nonce sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, SWEEP_MS);
    this.sweepHandle.unref?.();
  }
  onModuleDestroy(): void {
    if (this.sweepHandle) clearInterval(this.sweepHandle);
  }

  /**
   * The stored record for a replayed (still-fresh) key, or undefined if this request is new.
   *
   * A record from before nonces were scoped (`0029_nonce_scope`) has no actor or op, and still
   * answers its nonce for one retention window after this process starts, so a request retried
   * across that upgrade is not applied twice. Past the window no such record is fresh, so the
   * second lookup stops.
   */
  async check(key: NonceKey): Promise<{ result: string } | undefined> {
    const nowIso = this.nowIso();
    const seen = await this.store.get(key, nowIso);
    if (seen !== undefined || this.now() - this.startedAt >= this.cfg.retentionMs) return seen;
    return this.store.get({ actor: "", op: "", nonce: key.nonce }, nowIso);
  }

  /** Record a seen key with its committed `result` (JSON for writes, `""` for reads). */
  remember(key: NonceKey, result: string): Promise<void> {
    const expiresAt = new Date(this.now() + this.cfg.retentionMs).toISOString();
    return this.store.put(key, result, expiresAt);
  }

  /**
   * Write-op convenience: the parsed committed result of a replayed nonce, or undefined if fresh.
   * Owns the JSON decode so call sites don't each re-cast the stored string (pairs with
   * {@link rememberResult}).
   *
   * **A key a signed *read* consumed is a replay, not a memo.** `signedReadParams` records reads as
   * `remember(key, "")`, and `""` is not JSON, so it is answered the way a replayed read is answered
   * rather than decoded. With the key scoped to the op a write can no longer meet a read's row, but
   * a row from before that scoping can (see {@link check}).
   */
  async checkResult<T>(signed: SignedBy): Promise<T | undefined> {
    const seen = await this.check(nonceKey(signed));
    if (!seen) return undefined;
    if (seen.result === "") replayConflict();
    return JSON.parse(seen.result) as T;
  }

  /** Write-op convenience: record a request's committed result as JSON (pairs with {@link checkResult}). */
  rememberResult(signed: SignedBy, value: unknown): Promise<void> {
    return this.remember(nonceKey(signed), JSON.stringify(value));
  }

  /**
   * The one nonce-idempotency bracket (check → run → remember) — the composed form of
   * {@link checkResult}/{@link rememberResult} every idempotent signed write rides. A memo is only
   * recorded for a completed run, so a 4xx inside `run` never poisons the nonce.
   */
  async idempotentResult<M>(signed: SignedBy, run: () => Promise<M>): Promise<M> {
    const prior = await this.checkResult<M>(signed);
    if (prior) return prior;
    const result = await run();
    await this.rememberResult(signed, result);
    return result;
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }
}
