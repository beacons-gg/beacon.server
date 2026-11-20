import type { DidKey, MailboxMessage } from "@beaconsgg/protocol-types";

/**
 * A stored mailbox message — the {@link MailboxMessage} DTO plus the `to` recipient (which the
 * fetch response omits, since a fetch is scoped to the verified reader).
 */
export interface StoredMessage extends MailboxMessage {
  /** Recipient account did:key. */
  to: DidKey;
  /**
   * The sending game's slug. A recipient reads only mail from the game they read as: a body is that
   * game's own message format (`doc/spec/mailbox-and-media.md` §4.1).
   */
  game: string;
}

/**
 * Durable per-recipient mailbox (`doc/spec/mailbox-and-media.md` §4.5). Same pattern as the other
 * stores: {@link PgMailboxStore} implements it, and the service suites run on an in-memory fake
 * (`__tests__/memory-stores.ts`) held to the same parity suite. The server stores messages opaquely
 * and never parses `body`.
 */
export interface MailboxStore {
  /**
   * Idempotent send keyed by the sender and `nonce`: the first send with a given nonce inserts the
   * message; a **retried** send from the same sender with the same nonce is a no-op that returns
   * the originally-stored id (`deduped`). Another sender's nonce never dedups this one's send.
   */
  send(msg: StoredMessage, nonce: string): Promise<{ id: string; deduped: boolean }>;
  /** Non-expired messages for recipient `to` from `game` (`expires_at > now`), oldest first. */
  fetch(to: DidKey, game: string, nowIso: string): Promise<MailboxMessage[]>;
  /** Delete the given ids that belong to `to` in `game` (delivered → gone); returns the number deleted. */
  ack(to: DidKey, game: string, ids: string[]): Promise<number>;
  /** Delete every message at/past its TTL (`expires_at <= now`); returns the number swept. */
  sweepExpired(nowIso: string): Promise<number>;
}
