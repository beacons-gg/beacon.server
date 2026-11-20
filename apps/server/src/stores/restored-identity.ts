import type { PoolClient } from "pg";

/** Who a restored server is, from `0028_restored_identity`. */
export interface RestoredIdentity {
  host: string;
  /** The backup's recovery phrase, sealed with `BEACON_KEY_PASSPHRASE`; null if it was not needed. */
  keyEnvelope: string | null;
}

type Queryable = Pick<PoolClient, "query">;

/** The server's restored identity, or null for a server that has never been restored. */
export async function readRestoredIdentity(db: Queryable): Promise<RestoredIdentity | null> {
  const res = await db.query<{ host: string; key_envelope: string | null }>(
    "SELECT host, key_envelope FROM restored_identity",
  );
  const row = res.rows[0];
  return row ? { host: row.host, keyEnvelope: row.key_envelope } : null;
}

/** Record it through `db`: a restore writes this in the transaction that loads the data. */
export async function writeRestoredIdentity(
  db: Queryable,
  identity: RestoredIdentity,
  restoredAt: string,
): Promise<void> {
  await db.query(
    "INSERT INTO restored_identity (host, key_envelope, restored_at) VALUES ($1, $2, $3) " +
      "ON CONFLICT (singleton) DO UPDATE SET host = excluded.host, " +
      "key_envelope = excluded.key_envelope, restored_at = excluded.restored_at",
    [identity.host, identity.keyEnvelope, restoredAt],
  );
}
