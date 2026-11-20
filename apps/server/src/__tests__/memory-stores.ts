/**
 * The in-memory fakes the server's service suites run on, one import for all of them.
 *
 * No server runs on these: without `BEACON_DATABASE_URL` it refuses to start. They exist so a suite
 * about a service does not need a database, and each is held to its store's parity suite (through
 * {@link memoryTwin} in `./pg-twin`), so a fake that drifts from the Postgres store fails there
 * rather than hiding a bug in the suites that trust it.
 *
 * Two things every fake here does so that holds. Text sorts and keyset comparisons go through
 * `./byte-order`, the order the Postgres columns sort by since `0023_byte_order` (not `<`, and not
 * `localeCompare`, which is ICU). And a fake copies on the way in and on the way out, as a database
 * does, so a service that mutates what it read cannot reach the stored row through the fake either.
 */

import type {
  AccessEntry,
  BackupRun,
  BlockEntry,
  GeocodeResult,
  MailboxMessage,
  ProfileDoc,
} from "@beaconsgg/protocol-types";
import type { AccessStore } from "../stores/access-store";
import type { BackupRunPatch, BackupRunStore } from "../stores/backup-run-store";
import type { BlocklistStore } from "../stores/blocklist-store";
import type { GeocodeCacheStore } from "../stores/geocode-cache-store";
import type { MailboxStore, StoredMessage } from "../stores/mailbox-store";
import {
  MEDIA_SORTS,
  type MediaCursor,
  type MediaRecord,
  type MediaStore,
  toMediaListPage,
} from "../stores/media-store";
import type { NonceKey, NonceStore } from "../stores/nonce-store";
import type { ProfileStore } from "../stores/profile-store";
import {
  decodeValue,
  encodeValue,
  type SettingRow,
  type SettingsStore,
} from "../stores/settings-store";
import { byteCompare as cmp } from "../common/byte-order";

export { MemoryPlaceStore } from "./memory-place-store";

const byAge = (a: BlockEntry, b: BlockEntry): number =>
  cmp(a.addedAt, b.addedAt) || cmp(a.did, b.did);

/** In-memory {@link AccessStore}, by DID in byte order as the interface says. */
export class MemoryAccessStore implements AccessStore {
  private readonly byDid = new Map<string, AccessEntry>();

  put(entries: readonly AccessEntry[]): Promise<void> {
    for (const entry of entries) this.byDid.set(entry.did, { ...entry });
    return Promise.resolve();
  }
  remove(did: string): Promise<boolean> {
    return Promise.resolve(this.byDid.delete(did));
  }
  all(): Promise<AccessEntry[]> {
    return Promise.resolve(
      [...this.byDid.values()].sort((a, b) => cmp(a.did, b.did)).map((e) => ({ ...e })),
    );
  }
}

/** In-memory {@link BlocklistStore}, in the interface's order (a Map's insertion order is not). */
export class MemoryBlocklistStore implements BlocklistStore {
  private readonly byDid = new Map<string, BlockEntry>();

  put(entry: BlockEntry): Promise<void> {
    this.byDid.set(entry.did, { ...entry });
    return Promise.resolve();
  }
  remove(did: string): Promise<boolean> {
    return Promise.resolve(this.byDid.delete(did));
  }
  all(): Promise<BlockEntry[]> {
    // The interface's order, which a Map's insertion order is not. ISO timestamps sort as strings.
    return Promise.resolve([...this.byDid.values()].sort(byAge).map((e) => ({ ...e })));
  }
}

/** In-memory {@link SettingsStore}, in the interface's key order (a Map's insertion order is not). */
export class MemorySettingsStore implements SettingsStore {
  private readonly byKey = new Map<string, SettingRow>();

  put(row: SettingRow): Promise<void> {
    // Round-trip through the shared codec so the memory twin cannot accept a value the Postgres store
    // would mangle. Parity by construction, not by test.
    const decoded = decodeValue(encodeValue(row.value));
    this.byKey.set(row.key, { ...row, value: decoded.ok ? decoded.value : undefined });
    return Promise.resolve();
  }
  remove(key: string): Promise<boolean> {
    return Promise.resolve(this.byKey.delete(key));
  }
  all(): Promise<SettingRow[]> {
    const rows = [...this.byKey.values()].sort((a, b) => cmp(a.key, b.key));
    // `value` can be a string[], so a spread would still share it with the stored row.
    return Promise.resolve(structuredClone(rows));
  }
}

/** In-memory {@link ProfileStore}. */
export function memoryProfiles(): ProfileStore {
  const byId = new Map<string, ProfileDoc>();
  return {
    put(profile) {
      byId.set(profile.id, structuredClone(profile));
      return Promise.resolve();
    },
    all() {
      return Promise.resolve(structuredClone([...byId.values()]));
    },
    count() {
      return Promise.resolve(byId.size);
    },
  };
}

/** In-memory {@link MailboxStore}. */
export function memoryMailbox(): MailboxStore {
  const rows: StoredMessage[] = [];
  const byNonce = new Map<string, string>(); // [sender, nonce] -> message id
  const toDto = (m: StoredMessage): MailboxMessage => ({
    id: m.id,
    from: m.from,
    body: m.body,
    receivedAt: m.receivedAt,
    expiresAt: m.expiresAt,
  });
  return {
    send(msg, nonce) {
      const key = JSON.stringify([msg.from, nonce]);
      const existing = byNonce.get(key);
      if (existing !== undefined) return Promise.resolve({ id: existing, deduped: true });
      byNonce.set(key, msg.id);
      rows.push({ ...msg });
      return Promise.resolve({ id: msg.id, deduped: false });
    },
    fetch(to, game, nowIso) {
      return Promise.resolve(
        rows
          .filter((m) => m.to === to && m.game === game && m.expiresAt > nowIso)
          .sort((a, b) => cmp(a.receivedAt, b.receivedAt))
          .map(toDto),
      );
    },
    ack(to, game, ids) {
      const wanted = new Set(ids);
      let n = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i];
        if (r && r.to === to && r.game === game && wanted.has(r.id)) {
          rows.splice(i, 1);
          n += 1;
        }
      }
      return Promise.resolve(n);
    },
    sweepExpired(nowIso) {
      let n = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i];
        if (r && r.expiresAt <= nowIso) {
          rows.splice(i, 1);
          n += 1;
        }
      }
      return Promise.resolve(n);
    },
  };
}

/** In-memory {@link MediaStore}. */
export function memoryMedia(): MediaStore {
  const byHash = new Map<string, MediaRecord>();
  return {
    put(rec) {
      if (byHash.has(rec.hash)) return Promise.resolve({ existed: true });
      byHash.set(rec.hash, { ...rec });
      return Promise.resolve({ existed: false });
    },
    get(hash) {
      const r = byHash.get(hash);
      return Promise.resolve(r && { ...r });
    },
    totalBytesFor(owner) {
      let total = 0;
      for (const r of byHash.values()) if (r.owner === owner) total += r.size;
      return Promise.resolve(total);
    },
    touch(hash, nowIso) {
      const r = byHash.get(hash);
      if (r) r.lastAccessAt = nowIso;
      return Promise.resolve();
    },
    list(query) {
      // Mirror the SQL keyset semantics exactly so the parity suite agrees:
      // filter → sort (<key> DESC, hash DESC) → drop rows at/before the cursor → page. The keyset key
      // comes from the same MEDIA_SORTS map the Postgres store reads, and one comparison serves both
      // the sort and the cursor, as the ORDER BY and the `<` share the columns' collation there.
      const key = MEDIA_SORTS[query.sort].value;
      const keyCmp = (x: string | number, y: string | number): number =>
        typeof x === "number" && typeof y === "number" ? x - y : cmp(String(x), String(y));
      const rowCmp = (x: MediaRecord | MediaCursor, y: MediaRecord | MediaCursor): number =>
        keyCmp(key(x), key(y)) || cmp(x.hash, y.hash);
      let rows = [...byHash.values()];
      if (query.owner !== undefined) rows = rows.filter((r) => r.owner === query.owner);
      if (query.type !== undefined) rows = rows.filter((r) => r.type === query.type);
      if (query.reviewed === "unreviewed") rows = rows.filter((r) => r.reviewedAt === null);
      else if (query.reviewed === "reviewed") rows = rows.filter((r) => r.reviewedAt !== null);
      rows.sort((a, b) => rowCmp(b, a)); // (key, hash) DESC
      const c = query.cursor;
      if (c) rows = rows.filter((r) => rowCmp(r, c) < 0);
      const page = toMediaListPage(rows, query.limit);
      return Promise.resolve({ ...page, items: page.items.map((r) => ({ ...r })) });
    },
    setReviewed(hash, reviewedBy, reviewedAt) {
      const r = byHash.get(hash);
      if (r) {
        r.reviewedAt = reviewedAt;
        r.reviewedBy = reviewedBy;
      }
      return Promise.resolve(r !== undefined);
    },
    delete(hash) {
      return Promise.resolve(byHash.delete(hash));
    },
    stats() {
      let bytes = 0;
      let unreviewed = 0;
      for (const r of byHash.values()) {
        bytes += r.size;
        if (r.reviewedAt === null) unreviewed += 1;
      }
      return Promise.resolve({ objects: byHash.size, bytes, unreviewed });
    },
  };
}

/** In-memory {@link NonceStore}. */
export function memoryNonces(): NonceStore {
  const byNonce = new Map<string, { result: string; expiresAt: string }>();
  const id = (key: NonceKey): string => JSON.stringify([key.actor, key.op, key.nonce]);
  return {
    get(key, nowIso) {
      const row = byNonce.get(id(key));
      return Promise.resolve(row && row.expiresAt > nowIso ? { result: row.result } : undefined);
    },
    put(key, result, expiresAt) {
      if (!byNonce.has(id(key))) byNonce.set(id(key), { result, expiresAt }); // ON CONFLICT DO NOTHING
      return Promise.resolve();
    },
    sweepExpired(nowIso) {
      let n = 0;
      for (const [k, v] of byNonce) {
        if (v.expiresAt <= nowIso) {
          byNonce.delete(k);
          n += 1;
        }
      }
      return Promise.resolve(n);
    },
  };
}

/** In-memory {@link GeocodeCacheStore}. */
export function memoryGeocodeCache(): GeocodeCacheStore {
  const byKey = new Map<string, { result: GeocodeResult; expiresAt: string }>();
  return {
    get(cellKey, nowIso) {
      const row = byKey.get(cellKey);
      return Promise.resolve(
        row && row.expiresAt > nowIso ? structuredClone(row.result) : undefined,
      );
    },
    put(cellKey, result, expiresAt) {
      byKey.set(cellKey, { result: structuredClone(result), expiresAt });
      return Promise.resolve();
    },
    sweepExpired(nowIso) {
      let n = 0;
      for (const [k, v] of byKey) {
        if (v.expiresAt <= nowIso) {
          byKey.delete(k);
          n += 1;
        }
      }
      return Promise.resolve(n);
    },
  };
}

/** In-memory {@link BackupRunStore}, refusing a second live run as the partial index does. */
export class MemoryBackupRunStore implements BackupRunStore {
  private readonly runs = new Map<string, BackupRun>();

  create(run: BackupRun): Promise<boolean> {
    const live = [...this.runs.values()].some(
      (r) => r.status === "queued" || r.status === "running",
    );
    if (live) return Promise.resolve(false);
    this.runs.set(run.id, structuredClone(run));
    return Promise.resolve(true);
  }

  update(id: string, patch: BackupRunPatch): Promise<void> {
    const run = this.runs.get(id);
    if (run) this.runs.set(id, { ...run, ...structuredClone(patch) });
    return Promise.resolve();
  }

  get(id: string): Promise<BackupRun | undefined> {
    const run = this.runs.get(id);
    return Promise.resolve(run && structuredClone(run));
  }

  recent(limit: number): Promise<BackupRun[]> {
    const newest = [...this.runs.values()].sort((a, b) => cmp(b.id, a.id));
    return Promise.resolve(structuredClone(newest.slice(0, limit)));
  }

  hasDone(kind: BackupRun["kind"]): Promise<boolean> {
    return Promise.resolve(
      [...this.runs.values()].some((r) => r.kind === kind && r.status === "done"),
    );
  }

  failActive(error: string, finishedAt: string): Promise<number> {
    let closed = 0;
    for (const [id, run] of this.runs) {
      if (run.status !== "queued" && run.status !== "running") continue;
      this.runs.set(id, { ...run, status: "failed", error, finishedAt });
      closed += 1;
    }
    return Promise.resolve(closed);
  }
}
