import { DEFAULT_PRECISION, coverageIntersects, encode, liveCell } from "@beaconsgg/geo";
import type {
  DidKey,
  MapDelta,
  ScoutReport,
  ScoutReportParams,
  ScoutSummary,
} from "@beaconsgg/protocol-types";
import { interpolateScout } from "@beaconsgg/scout-interp";

/** Cap the relay map (FIFO) — a client could `report` ∞. */
const DEFAULT_MAX_SCOUTS = 10_000;
/** The longest a report may ask to live, measured from the server's receipt. */
const DEFAULT_MAX_TTL_MS = 60 * 60_000; // 1 hour

export interface ScoutRelayOptions {
  /**
   * Broadcast a live map delta (`scout` / `scoutGone`) to viewers of the affected cell, and of the
   * scout's game: `games` is that game, or none for a scout reported without one.
   */
  broadcast: (delta: MapDelta, games: readonly string[]) => void;
  /** Cap the relay map (FIFO). Default 10_000. */
  maxScouts?: number;
  /** Refuse a report that asks to live longer than this. Default 1h. */
  maxTtlMs?: number;
}

/**
 * When a report happened, on both clocks: `reportedAt` is the server's receipt time, and `issuedAt`
 * is the client's own clock as it signed the op (the envelope's signed `issuedAt`).
 */
export interface ReportStamp {
  reportedAt: string;
  issuedAt: string;
}

/**
 * The scout **relay** (beacon.core `doc/spec/discovery.md` §5, `doc/spec/room-operation.md` §9.5):
 * owner-authoritative advertisements the server only caches + re-serves, **never custodies**.
 * Single-writer, so no serialization — keep the freshest report per `unique` and age it out at
 * `expiresAt`.
 *
 * Framework-agnostic (no `@beaconsgg/identity` dependency): **the caller owns all identity/signature
 * verification.** Before `report()`, the controller verifies the op signature (→ the `owner` passed in)
 * AND the scout's `mintedBy` provenance; the relay trusts `owner` and stores the report verbatim.
 * Replay/freshness is likewise the caller's (the signed `issuedAt` window + a server-stamped
 * `reportedAt`); here we bound only the map size + per-report TTL horizon, and run expiry on the
 * server's clock (see {@link ScoutRelay.report}). A future second ingest path
 * (e.g. cross-server scout handoff) MUST re-verify provenance itself — this cache assumes verified input.
 * It takes a `broadcast` callback so the transport (socket.io, …) stays in the app shell, and the caller
 * drives expiry via {@link sweepExpired}.
 */
export class ScoutRelay {
  private readonly scouts = new Map<string, ScoutReport>();
  private readonly broadcast: (delta: MapDelta, games: readonly string[]) => void;
  private readonly maxScouts: number;
  private readonly maxTtlMs: number;

  constructor(options: ScoutRelayOptions) {
    this.broadcast = options.broadcast;
    this.maxScouts = options.maxScouts ?? DEFAULT_MAX_SCOUTS;
    this.maxTtlMs = options.maxTtlMs ?? DEFAULT_MAX_TTL_MS;
  }

  /**
   * Publish/refresh a scout report. Only the original owner may refresh a given `unique`. `game` is
   * the report envelope's signed slug, kept and relayed so a reader can tell whose scout this is.
   *
   * The stored `expiresAt` runs on the server's clock: the client's `expiresAt` and its signed
   * `issuedAt` come from the same device clock, so their difference is the lifetime the client
   * asked for whatever that clock's error. The relay applies that length from `reportedAt`. A
   * device clock running slow or fast cannot shorten or lengthen a report, and older clients get
   * this with no wire change. A length that is not positive, or longer than the TTL horizon, is
   * refused.
   */
  report(
    owner: DidKey,
    params: ScoutReportParams,
    stamp: ReportStamp,
    game?: string | undefined,
  ): { ok: boolean; error?: string } {
    const { reportedAt } = stamp;
    const existing = this.scouts.get(params.unique);
    if (existing && existing.owner !== owner) return { ok: false, error: "denied" };
    // Ignore an out-of-order (older) report — keep the freshest.
    if (existing && Date.parse(existing.reportedAt) > Date.parse(reportedAt)) return { ok: true };
    // Bound the lifetime, so a single report can't squat the map until some far-future
    // `expiresAt`, and refuse one that asked for no lifetime at all.
    const lengthMs = Date.parse(params.expiresAt) - Date.parse(stamp.issuedAt);
    // Written as `!(> 0)` so an unparseable timestamp (NaN) is refused too.
    if (!(lengthMs > 0) || lengthMs > this.maxTtlMs) return { ok: false, error: "invalid" };
    // Radical trust (beacon.core `doc/spec/identity.md` §3): the relay is a bulletin board, NOT a
    // cheat referee — it does not validate movement against the scout's config caps (speed /
    // move-distance). The owner's client owns that math (beacon.core `doc/spec/discovery.md` §5,
    // uncontended). The only numeric bound on `speedKmh` is the sanity ceiling in `movementSchema`
    // (MAX_SCOUT_SPEED_KMH, plus `.finite()`), applied upstream at parse. The server bounds only
    // what it custodies (the map size + the TTL horizon above), never a gameplay value.

    const report: ScoutReport = {
      unique: params.unique,
      owner,
      config: params.config,
      mintedBy: params.mintedBy,
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(game !== undefined ? { game } : {}),
      movement: params.movement,
      reportedAt,
      expiresAt: new Date(Date.parse(reportedAt) + lengthMs).toISOString(),
    };
    this.scouts.set(params.unique, report);
    this.evictOldestIfFull(params.unique);
    // Live map: a deployed/refreshed scout appears at its current interpolated cell.
    this.broadcast(
      {
        cell: this.cellOf(report, Date.parse(reportedAt)),
        kind: "scout",
        scout: this.summaryOf(report),
      },
      gamesOf(report),
    );
    return { ok: true };
  }

  /** FIFO-evict the oldest report once the map exceeds the cap (never the one just written). */
  private evictOldestIfFull(justAdded: string): void {
    if (this.scouts.size <= this.maxScouts) return;
    for (const key of this.scouts.keys()) {
      if (key !== justAdded) {
        this.scouts.delete(key);
        return;
      }
    }
  }

  /** Tombstone a scout (owner only). */
  cancel(owner: DidKey, unique: string): { ok: boolean; error?: string } {
    const existing = this.scouts.get(unique);
    if (existing && existing.owner !== owner) return { ok: false, error: "denied" };
    if (existing) {
      this.scouts.delete(unique);
      this.broadcast(
        { cell: this.cellOf(existing, Date.now()), kind: "scoutGone", id: unique },
        gamesOf(existing),
      );
    }
    return { ok: true };
  }

  /** Age out reports past their `expiresAt`; the caller invokes this on an interval. */
  sweepExpired(nowMs: number): void {
    for (const [unique, scout] of this.scouts) {
      if (Date.parse(scout.expiresAt) <= nowMs) {
        this.scouts.delete(unique);
        // Live map: aged-out scout disappears from viewers of its last cell.
        this.broadcast(
          { cell: this.cellOf(scout, nowMs), kind: "scoutGone", id: unique },
          gamesOf(scout),
        );
      }
    }
  }

  /**
   * Scouts whose **server-interpolated** position falls in the queried cells (beacon.core
   * `doc/spec/discovery.md` §5), and only those of `games` when a filter is given (a scout belongs
   * to the game that reported it).
   */
  scoutsInView(cells: string[], nowMs: number, games?: readonly string[]): ScoutSummary[] {
    const out: ScoutSummary[] = [];
    for (const scout of this.scouts.values()) {
      if (Date.parse(scout.expiresAt) <= nowMs) continue;
      if (games !== undefined && (scout.game === undefined || !games.includes(scout.game)))
        continue;
      const pos = interpolateScout(scout.movement, nowMs);
      const cell = encode({ lat: pos.lat, lng: pos.lng }, DEFAULT_PRECISION);
      if (!coverageIntersects([cell], cells)) continue;
      out.push(this.summaryOf(scout)); // the original descriptor — the client interpolates exactly
    }
    return out;
  }

  /** The live map cell of a scout at `nowMs` (its interpolated position). */
  private cellOf(scout: ScoutReport, nowMs: number): string {
    const pos = interpolateScout(scout.movement, nowMs);
    return liveCell({ lat: pos.lat, lng: pos.lng });
  }

  private summaryOf(scout: ScoutReport): ScoutSummary {
    return {
      id: scout.unique,
      owner: { id: scout.owner },
      config: scout.config,
      mintedBy: scout.mintedBy,
      ...(scout.name !== undefined ? { name: scout.name } : {}),
      ...(scout.game !== undefined ? { game: scout.game } : {}),
      movement: scout.movement,
      expiresAt: scout.expiresAt,
    };
  }
}

/** Who a scout's map deltas are for: its game, or nobody but unscoped watchers when it named none. */
function gamesOf(scout: ScoutReport): readonly string[] {
  return scout.game === undefined ? [] : [scout.game];
}
