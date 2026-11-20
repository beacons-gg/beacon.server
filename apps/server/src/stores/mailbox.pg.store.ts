import type { DidKey, MailboxMessage } from "@beaconsgg/protocol-types";
import type { Pool } from "pg";
import type { MailboxStore, StoredMessage } from "./mailbox-store";

/** A DB row → the reader-scoped {@link MailboxMessage} DTO. */
interface MailboxRow {
  id: string;
  sender: string;
  body: string;
  received_at: string;
  expires_at: string;
}

function rowToMessage(r: MailboxRow): MailboxMessage {
  return {
    id: r.id,
    from: r.sender as DidKey,
    body: r.body,
    receivedAt: r.received_at,
    expiresAt: r.expires_at,
  };
}

/**
 * Postgres {@link MailboxStore} — the production twin (`doc/spec/mailbox-and-media.md` §4.5), over
 * the `mailbox` table (`0002_mailbox`).
 */
export class PgMailboxStore implements MailboxStore {
  constructor(private readonly pool: Pool) {}

  async send(msg: StoredMessage, nonce: string): Promise<{ id: string; deduped: boolean }> {
    // ON CONFLICT (sender, nonce) DO NOTHING + RETURNING: a row comes back only on a fresh insert.
    // Per sender, so another account's nonce never dedups this one's send (`0029_nonce_scope`).
    const inserted = await this.pool.query<{ id: string }>(
      "INSERT INTO mailbox (id, recipient, sender, body, received_at, expires_at, nonce, game) " +
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (sender, nonce) DO NOTHING RETURNING id",
      [msg.id, msg.to, msg.from, msg.body, msg.receivedAt, msg.expiresAt, nonce, msg.game],
    );
    if (inserted.rowCount && inserted.rowCount > 0) return { id: msg.id, deduped: false };
    const existing = await this.pool.query<{ id: string }>(
      "SELECT id FROM mailbox WHERE sender = $1 AND nonce = $2",
      [msg.from, nonce],
    );
    return { id: existing.rows[0]?.id ?? msg.id, deduped: true };
  }

  async fetch(to: DidKey, game: string, nowIso: string): Promise<MailboxMessage[]> {
    const res = await this.pool.query<MailboxRow>(
      "SELECT id, sender, body, received_at, expires_at FROM mailbox " +
        "WHERE recipient = $1 AND game = $2 AND expires_at > $3 ORDER BY received_at ASC",
      [to, game, nowIso],
    );
    return res.rows.map(rowToMessage);
  }

  async ack(to: DidKey, game: string, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const res = await this.pool.query(
      "DELETE FROM mailbox WHERE recipient = $1 AND game = $2 AND id = ANY($3::text[])",
      [to, game, ids],
    );
    return res.rowCount ?? 0;
  }

  /** Messages from before game slugs, which no game's read delivers (0025). Counted for the boot log. */
  async countWithoutGame(): Promise<number> {
    const res = await this.pool.query<{ n: string }>(
      "SELECT COUNT(*) AS n FROM mailbox WHERE game IS NULL",
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  async sweepExpired(nowIso: string): Promise<number> {
    const res = await this.pool.query("DELETE FROM mailbox WHERE expires_at <= $1", [nowIso]);
    return res.rowCount ?? 0;
  }
}
