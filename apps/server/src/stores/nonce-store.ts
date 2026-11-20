/**
 * What a nonce is remembered under: the verified actor and the op they signed, beside the nonce.
 *
 * Scoped to all three, not the nonce alone, so one request can never be answered with another's
 * memo. Keyed on the nonce alone, a write reusing another write's nonce got that op's stored answer
 * back and was never applied, and an account that saw someone else's nonce could spend it first.
 * Scoping (rather than refusing a nonce reused under another op) is the safer of the two because it
 * needs no comparison to get right: two requests that differ in actor or op can't meet at all, and
 * a captured request still replays to the same key, since the actor and the op are both signed.
 */
export interface NonceKey {
  readonly actor: string;
  readonly op: string;
  readonly nonce: string;
}

/** A verified signed request, as the nonce log reads it: who signed, and the envelope. */
export interface SignedBy {
  readonly actor: string;
  readonly env: { readonly op: string; readonly nonce: string; readonly params?: unknown };
}

/** The {@link NonceKey} of a verified request. */
export function nonceKey({ actor, env }: SignedBy): NonceKey {
  return { actor, op: env.op, nonce: env.nonce };
}

/**
 * Durable replay/idempotency log for signed capability requests (`doc/spec/mailbox-and-media.md`
 * §3.2). Keyed by {@link NonceKey} (the actor, the op and the envelope's ULID `nonce`), it outlives
 * the message or media record it guarded, so a captured request replayed inside the freshness
 * window is caught even after the underlying row was acked or swept (which a message row's own
 * unique key alone could not do).
 *
 * Two record shapes, distinguished by `result`:
 *   - **writes** (send / ack / media.put) store their committed result JSON → a replay returns it
 *     (idempotent retry, the recoverable-lost-reply invariant);
 *   - **reads** (fetch) store `""` → a replay is rejected (409), so a captured read can't be re-served.
 *
 * Same pattern as the other stores: {@link PgNonceStore} implements it, and the service suites run on an in-memory fake
 * (`__tests__/memory-stores.ts`) held to the same parity suite.
 * A TTL sweep prunes expired rows.
 */
export interface NonceStore {
  /** The stored record for a still-fresh key (`expires_at > now`), or undefined if unseen/expired. */
  get(key: NonceKey, nowIso: string): Promise<{ result: string } | undefined>;
  /** Record a seen key with its committed `result` (JSON for writes, `""` for reads). Idempotent. */
  put(key: NonceKey, result: string, expiresAt: string): Promise<void>;
  /** Delete every nonce at/past its retention (`expires_at <= now`); returns the number swept. */
  sweepExpired(nowIso: string): Promise<number>;
}
