import type { ProfileDoc } from "@beaconsgg/protocol-types";
import type { Pool } from "pg";
import type { ProfileStore } from "./profile-store";

/**
 * Postgres {@link ProfileStore} — the production twin. Its own table (`profiles`, JSONB doc, from
 * `0001_init`). `ProfilesService` stays a write-through cache over it so a revoked device stays
 * revoked across a restart.
 */
export class PgProfileStore implements ProfileStore {
  constructor(private readonly pool: Pool) {}

  async put(profile: ProfileDoc): Promise<void> {
    await this.pool.query(
      "INSERT INTO profiles (id, doc) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET doc = excluded.doc",
      [profile.id, JSON.stringify(profile)],
    );
  }

  async all(): Promise<ProfileDoc[]> {
    const res = await this.pool.query<{ doc: ProfileDoc }>("SELECT doc FROM profiles");
    return res.rows.map((r) => r.doc);
  }

  async count(): Promise<number> {
    const res = await this.pool.query<{ n: string }>("SELECT COUNT(*) AS n FROM profiles");
    return Number(res.rows[0]?.n ?? 0);
  }
}
