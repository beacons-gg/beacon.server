import type { Pool } from "pg";
import type { NonceKey, NonceStore } from "./nonce-store";

/**
 * Postgres {@link NonceStore} — the production twin (`doc/spec/mailbox-and-media.md` §3.2), over
 * the `capability_nonces` table (`0004_nonces`, keyed per actor and op since `0029_nonce_scope`).
 */
export class PgNonceStore implements NonceStore {
  constructor(private readonly pool: Pool) {}

  async get(key: NonceKey, nowIso: string): Promise<{ result: string } | undefined> {
    const res = await this.pool.query<{ result: string }>(
      "SELECT result FROM capability_nonces " +
        "WHERE actor = $1 AND op = $2 AND nonce = $3 AND expires_at > $4",
      [key.actor, key.op, key.nonce, nowIso],
    );
    const row = res.rows[0];
    return row ? { result: row.result } : undefined;
  }

  async put(key: NonceKey, result: string, expiresAt: string): Promise<void> {
    await this.pool.query(
      "INSERT INTO capability_nonces (actor, op, nonce, result, expires_at) " +
        "VALUES ($1, $2, $3, $4, $5) ON CONFLICT (actor, op, nonce) DO NOTHING",
      [key.actor, key.op, key.nonce, result, expiresAt],
    );
  }

  async sweepExpired(nowIso: string): Promise<number> {
    const res = await this.pool.query("DELETE FROM capability_nonces WHERE expires_at <= $1", [
      nowIso,
    ]);
    return res.rowCount ?? 0;
  }
}
