import { DEFAULT_PRECISION, coverageIntersects, encode, liveCell } from "@beaconsgg/geo";
import {
  LEDGER_ONLY_OPS,
  PolicyEngine,
  grantRulesOf,
  nextTransitionAt,
  nowSeconds,
  type AppliedOp,
  type PlacedRoom,
  type Store,
} from "@beaconsgg/policy-engine";
import {
  ANY_GAME,
  formatGlobalId,
  pickMedia,
  type DidKey,
  type DiscoveryResponse,
  type GlobalId,
  type RoomSummary,
  type OpEnvelope,
  type PlaceParams,
  type Room,
} from "@beaconsgg/protocol-types";
import { roomGames, roomOpenToGame } from "@beaconsgg/protocol-types/server";
import { KeyedMutex, LifecycleScheduler, tickDelay } from "@beaconsgg/server-runtime";
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { SenderBlocklist } from "../common/blocklist";
import { MemberList } from "../common/member-list";
import { DidBudgets } from "../common/did-budgets";
import { GameGate } from "../common/game-gate";
import type { ServerConfig } from "../config";
import { ProfilesService } from "../profiles/profiles.service";
import { ServerIdentity } from "../server-identity";
import { SERVER_CONFIG } from "../settings/live-config";
import { STORE } from "../stores/store.module";
import { RoomsGateway } from "./rooms.gateway";

/** Log a warning if processing the due rooms in one wake takes longer than this. */
const LIFECYCLE_BATCH_WARN_MS = 1000;
/** Coarse safety reconcile — re-derives the schedule from the store so no room can be stranded. */
const RECONCILE_MS = 60_000;

/**
 * The heart of the server. Wraps the {@link PolicyEngine} as a **unit of work** under a per-room
 * {@link KeyedMutex} (held across read→commit so the atomic handoff survives the async Store),
 * drives the lifecycle **timer-wheel** ({@link LifecycleScheduler}), and fans room / map deltas out
 * through the gateway.
 *
 * The durable {@link Store} is **injected** from the store factory, and the timer-wheel is seeded
 * and reconciled from `store.lifecycleRoomsDue(nowSec)` rather than a `listRooms()` full-scan,
 * while discovery queries `store.roomsInCells(cells)`. The engine stays a unit of work: reads up
 * front, pure compute, one atomic commit, all under the room's mutex (`doc/spec/room-operation.md`
 * §6.1).
 */
@Injectable()
export class RoomsService implements OnModuleInit, OnModuleDestroy {
  private readonly engine: PolicyEngine;
  private readonly locks = new KeyedMutex();
  /** Room -> geohash cache, so a close/delete knows a room's cell without re-reading it. */
  private readonly geoIndex = new Map<GlobalId, string>();
  private readonly logger = new Logger(RoomsService.name);
  /** Timer-wheel: each lifecycle room scheduled at its next-transition time; wake only when due. */
  private readonly scheduler = new LifecycleScheduler();
  private tickHandle: ReturnType<typeof setTimeout> | undefined;
  private reconcileHandle: ReturnType<typeof setInterval> | undefined;
  private running = false; // a runDue pass is in flight
  private stopped = false;

  constructor(
    private readonly gateway: RoomsGateway,
    private readonly identity: ServerIdentity,
    private readonly profiles: ProfilesService,
    private readonly blocklist: SenderBlocklist,
    private readonly members: MemberList,
    private readonly games: GameGate,
    private readonly budgets: DidBudgets,
    @Inject(STORE) private readonly store: Store,
    @Inject(SERVER_CONFIG) private readonly config: Pick<ServerConfig, "writeLocked">,
  ) {
    // Back the engine's revocation consult with the published-profile registry, so a revoked
    // device's ops are denied end-to-end (beacon.core `doc/spec/identity.md` §5.2).
    this.engine = new PolicyEngine(this.store, {
      // Back the engine's admission consult with the operator's durable blocklist, so a blocked DID
      // is refused on the op path as well as at the two boundaries that verify for themselves
      // (placement above, and the scout relay).
      isDenied: (actor) => this.blocklist.has(actor),
      // The same member list as every boundary's `verifyWrite`.
      isNotMember: (actor) => !this.members.admits(actor),
      // The same shape for the operator's admission list. One GameGate backs this and every
      // boundary that verifies for itself, so the four consults cannot reach different verdicts.
      isAppDenied: (app) => !this.games.admits(app),
      isDeviceRevoked: (account, device) => this.profiles.isRevoked(account, device),
      // Back the engine's budget consult with the player-write class. The charge lands where the
      // actor is already cryptographically established, so the HTTP boundary needs no second
      // signature verify to bill one. `place` is billed against the same class at the boundary,
      // which is the only room write that does not reach the engine as an op.
      isRateLimited: (actor, op) => !this.budgets.allowPlayerWrite(actor, op),
    });
  }

  /**
   * Seed the timer-wheel from the rooms whose next transition is already due or imminent
   * (`lifecycleRoomsDue`, not a full `listRooms()` scan), arm the wake, and start the coarse
   * periodic reconcile as the safety net (`doc/spec/room-operation.md` §8.4). The in-memory geohash
   * cache fills lazily on place / op / discovery; it is a hint only (discovery reads
   * `roomsInCells`).
   */
  async onModuleInit(): Promise<void> {
    for (const room of await this.store.lifecycleRoomsDue(nowSeconds(Date.now()))) {
      this.geoIndex.set(room.id, encode(room.location, DEFAULT_PRECISION));
      this.scheduleRoom(room);
    }
    this.armTick();
    this.reconcileHandle = setInterval(() => void this.reconcile(), RECONCILE_MS);
    this.reconcileHandle.unref?.();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.tickHandle) clearTimeout(this.tickHandle);
    if (this.reconcileHandle) clearInterval(this.reconcileHandle);
    // The Store's own lifecycle (close/drain) is owned by StoreModule's shutdown hook, not here —
    // the store is a shared injected singleton.
  }

  /** Compute a lifecycle room's next-transition time and (re)schedule it (drop it when terminal). */
  private scheduleRoom(room: Room): void {
    if (!room.policy.lifecycle) return;
    const next = nextTransitionAt(room, nowSeconds(Date.now()));
    if (next === undefined) this.scheduler.delete(room.id);
    else this.scheduler.set(room.id, next * 1000); // epoch seconds -> ms
  }

  /** (Re)arm the single wake timer to fire when the earliest scheduled room is due. */
  private armTick(): void {
    if (this.stopped) return;
    if (this.tickHandle) clearTimeout(this.tickHandle);
    const next = this.scheduler.nextDueAt();
    if (next === undefined) {
      this.tickHandle = undefined;
      return;
    }
    // `tickDelay` (not a raw subtraction): a boundary more than ~24.9 days out overflows Node's
    // 32-bit timer and would fire instantly, forever. Long waits are slept in bounded hops.
    this.tickHandle = setTimeout(() => void this.runDue(), tickDelay(next, Date.now()));
    this.tickHandle.unref?.(); // don't keep the process alive solely for the tick
  }

  /**
   * Process every room that's **due** now, then re-arm — the timer-wheel replacement for an
   * O(rooms) per-second scan (`doc/spec/room-operation.md` §8.4). Only due rooms are touched
   * (O(due)), so the cost is independent of total room count. The `running` guard plus the re-arm
   * in `finally` mean overlapping wakes can't pile up and nothing is missed: a wake during a pass
   * is a no-op, and the in-flight pass re-arms to catch up.
   */
  private async runDue(): Promise<void> {
    if (this.running) return;
    // Locked: checked before `dueBefore`, which drains the wheel, so every due room stays scheduled.
    // Nothing re-arms here, or an overdue room would spin this wake at zero delay for the whole
    // lock. The first reconcile after an unlock re-arms this within RECONCILE_MS, which is when
    // rooms that came due during the lock finally fire.
    if (this.config.writeLocked) return;
    this.running = true;
    const start = Date.now();
    try {
      const now = Date.now();
      const dueIds = this.scheduler.dueBefore(now);
      await Promise.all(dueIds.map((roomId) => this.processDue(roomId, now)));
    } finally {
      const elapsed = Date.now() - start;
      if (elapsed > LIFECYCLE_BATCH_WARN_MS) this.logger.warn(`lifecycle batch took ${elapsed}ms`);
      this.running = false;
      this.armTick();
    }
  }

  /**
   * Advance one due room **under its per-room lock** (so the tick can't interleave with a concurrent
   * op — the invariant survives the async Store), broadcast the transition/close, and reschedule it
   * at its next boundary (or leave it dropped on close). Per-room error isolation: a bad room can't
   * abort the batch.
   */
  private async processDue(roomId: GlobalId, now: number): Promise<void> {
    try {
      await this.locks.run(roomId, async () => {
        const pre = await this.engine.resolveRoom(roomId); // location, for the map cell on close
        const advanced = await this.engine.advancePhase(roomId, now);
        for (const b of advanced.broadcasts) {
          this.gateway.broadcast({ room: roomId, version: b.version, change: b.change });
        }
        // Live map: a phase change restyles the marker; a close removes it (shared close effects).
        const location = advanced.room?.location ?? pre?.location;
        if (advanced.closed) {
          this.closedRoom(roomId, location);
        } else {
          if (advanced.broadcasts.length > 0 && location && advanced.room) {
            this.gateway.broadcastMap(
              { cell: liveCell(location), kind: "room", room: this.toSummary(advanced.room) },
              roomGames(advanced.room),
            );
          }
          if (advanced.room) this.scheduleRoom(advanced.room); // reschedule at the next boundary
        }
      });
    } catch {
      /* per-room isolation: a bad room (or a socket emit error) must not abort the batch */
    }
  }

  /**
   * Safety net: re-derive the schedule for the currently-due rooms from the store so a missed
   * reschedule can't strand a room. Coarse (every `RECONCILE_MS`) and read-only, backed by the
   * `lifecycle_due_at` index (`lifecycleRoomsDue`, not a full scan) — the event hooks (place /
   * applyOp / runDue) are the precise fast path; this just guarantees liveness.
   */
  private async reconcile(): Promise<void> {
    // The wheel already holds every room that comes due during a lock, so this would only re-read
    // a growing set of overdue rooms, under the backup the lock is for.
    if (this.config.writeLocked) return;
    try {
      for (const room of await this.store.lifecycleRoomsDue(nowSeconds(Date.now()))) {
        this.scheduleRoom(room);
      }
      this.armTick();
    } catch {
      /* best-effort */
    }
  }

  /**
   * Place (create) a room — mints `unique@host` and takes custody (`doc/spec/room-operation.md`
   * §9.1). The room's `unique` is the container's client-minted id (stable across retries), so
   * idempotency + serialization key on the **room id**, not the per-call nonce: a re-place by the
   * same placer returns the existing room (idempotent), and the per-`id` lock stops two concurrent
   * same-`unique` placements from both passing the existence check and clobbering. A different
   * actor at that id is a `PlaceConflictError`.
   */
  async place(
    actor: DidKey,
    params: PlaceParams,
    nonce: string,
    game: string,
  ): Promise<PlacedRoom> {
    // The room's `unique` is the container's client-minted id, so its grant-time `mintedBy` (signed over
    // {unique, kind, policy}) re-verifies here + from any discovered room. Lock on the id (the collision domain).
    const id = formatGlobalId({ unique: params.unique, host: this.identity.config.host });
    const placed = await this.locks.run(`place:${id}`, () =>
      this.engine.place(
        {
          id,
          type: params.type,
          location: params.location,
          policy: params.policy,
          placedBy: actor,
          game,
          mintedBy: params.mintedBy,
          ...(params.name !== undefined ? { name: params.name } : {}),
          ...(params.media !== undefined ? { media: params.media } : {}),
          state: {
            contents: params.initialContents ?? [],
            // Seed reward pools under the keys the policy's grant rules draw from, so the engine's
            // provenance gate (keyed off each rule's `from`) and the runtime grants read the same
            // pools (`doc/spec/room-operation.md` §9.6). `initialRewards` keeps its legacy meaning
            // — the FIRST rule's pool (single-rule policies are exactly as before); `initialPools`
            // seeds a multi-rule policy's named pools (keys boundary-checked in the controller).
            ...this.poolSeeds(params),
          },
          live: this.identity.config.publicUrl,
        },
        nonce,
      ),
    );
    if (!placed.replayed && placed.room) {
      this.geoIndex.set(placed.id, encode(placed.room.location, DEFAULT_PRECISION));
      // Live map: a new room appeared; push it to viewers of its cell (no re-poll needed).
      this.gateway.broadcastMap(
        {
          cell: liveCell(placed.room.location),
          kind: "room",
          room: this.toSummary(placed.room),
        },
        roomGames(placed.room),
      );
      // Timer-wheel: a new lifecycle room (Capsule) — schedule its first transition.
      if (placed.room.policy.lifecycle) {
        this.scheduleRoom(placed.room);
        this.armTick();
      }
    }
    return placed;
  }

  /**
   * The reward-pool state entries a placement seeds — see the comment at the `place` call site.
   * The controller already rejected any `initialPools` key no grant rule draws from, and a rule
   * may not name a reserved state key (a policy invariant `assertValidPolicyRules` enforces), so
   * the pools spread straight in — one owner per check, no re-filtering here.
   */
  private poolSeeds(params: PlaceParams): Record<string, unknown> {
    const first = grantRulesOf(params.policy)[0];
    return {
      ...(params.initialRewards && first ? { [first.from]: params.initialRewards } : {}),
      ...(params.initialPools ?? {}),
    };
  }

  /** A room by id, or `undefined` when it is gone or none of `games` owns it or may act on it. */
  async resolve(id: GlobalId, games?: readonly string[]): Promise<Room | undefined> {
    const room = await this.engine.resolveRoom(id);
    return room && openToAnyOf(room, games) ? room : undefined;
  }

  /** Apply a signed op under the per-room lock, then broadcast its deltas (events only). */
  applyOp(env: OpEnvelope): Promise<AppliedOp> {
    const roomId = env.room;
    if (!roomId) return this.engine.applyOp(env); // engine rejects "invalid"

    return this.locks.run(roomId, async () => {
      const pre = await this.engine.resolveRoom(roomId); // location, for the map cell on close
      const applied = await this.engine.applyOp(env);
      if (!applied.replayed && applied.result.ok && applied.changes.length > 0) {
        const version = applied.result.version;
        for (const change of applied.changes) {
          this.gateway.broadcast({ room: roomId, version, change });
        }
        // Live map: a mutating op changed this room; upsert its marker, or remove it on close.
        const location = applied.room?.location ?? pre?.location;
        if (location) {
          const cell = liveCell(location);
          if (applied.closed)
            this.gateway.broadcastMap({ cell, kind: "roomGone", id: roomId }, [ANY_GAME]);
          // A ledger-only op changes nothing a summary shows, so re-broadcasting one would push a
          // byte-identical marker to every watcher of the cell on every tap. The close branch above
          // still runs: that is a removal, not a summary.
          else if (applied.room && !LEDGER_ONLY_OPS.has(env.op))
            this.gateway.broadcastMap(
              { cell, kind: "room", room: this.toSummary(applied.room) },
              roomGames(applied.room),
            );
        }
      }
      // Timer-wheel: keep this room's schedule in sync with the op — a contribute moves
      // lockAt/unlockAt, a claim may close. Re-arm only when a lifecycle room was involved.
      const wasLifecycle = pre?.policy.lifecycle !== undefined;
      if (applied.closed) {
        this.geoIndex.delete(roomId);
        this.scheduler.delete(roomId);
      } else if (applied.room?.policy.lifecycle) {
        this.scheduleRoom(applied.room);
      }
      if (wasLifecycle) this.armTick();
      return applied;
    });
  }

  /**
   * Admin moderation (`doc/spec/admin-api.md` §3): force-remove a room through the engine's normal
   * close path: watchers get the standard `closed` room event + `roomGone` map delta, and a racing
   * op sees `expired` (the engine tombstones the id). Runs under the per-room lock like every other
   * mutation; authorization lives at the admin gate, this is custody mechanics only. Returns false
   * when the room doesn't exist (idempotent retry-friendly).
   */
  async adminRemove(id: GlobalId): Promise<boolean> {
    return this.locks.run(id, async () => {
      const pre = await this.engine.resolveRoom(id); // location, for the map cell of the gone event
      const removed = await this.engine.removeRoom(id);
      if (!removed.closed) return false;
      for (const b of removed.broadcasts) {
        this.gateway.broadcast({ room: id, version: b.version, change: b.change });
      }
      this.closedRoom(id, pre?.location);
      this.armTick();
      return true;
    });
  }

  /** Close-side effects shared by the tick close and admin removal: gone marker + index/timer cleanup. */
  private closedRoom(id: GlobalId, location: Room["location"] | undefined): void {
    // A tombstone goes to every game in the cell: an id a socket never held is ignored, and the
    // room is gone, so there is nothing left to read who it was for.
    if (location)
      this.gateway.broadcastMap({ cell: liveCell(location), kind: "roomGone", id }, [ANY_GAME]);
    this.geoIndex.delete(id);
    this.scheduler.delete(id);
  }

  /**
   * Spatial discovery (beacon.core `doc/spec/discovery.md` §4): rooms whose geohash intersects the
   * query cells — served from the store's `roomsInCells` index, so it never full-scans against a
   * networked DB.
   */
  async discover(cells: string[], types?: string[], games?: string[]): Promise<DiscoveryResponse> {
    const rooms: RoomSummary[] = [];
    for (const room of await this.store.roomsInCells(cells)) {
      const geohash = this.geoIndex.get(room.id) ?? encode(room.location, DEFAULT_PRECISION);
      // roomsInCells is a coarse prefix match; confirm the finer intersect for the exact query.
      if (!coverageIntersects([geohash], cells)) continue;
      if (types && types.length > 0 && !types.includes(room.type)) continue;
      if (!openToAnyOf(room, games)) continue;
      rooms.push(this.toSummary(room));
    }
    return { coveredBy: this.identity.config.host, rooms, scouts: [] };
  }

  private toSummary(room: Room): RoomSummary {
    const contents = room.state["contents"];
    const count = Array.isArray(contents) ? contents.length : 0;
    const capacity = room.policy.accept?.capacity;
    const summary: Record<string, unknown> =
      capacity === undefined ? { count } : { count, capacity };
    // Surface the (last-ticked) lifecycle phase so a capsule marker can restyle on the map.
    if (room.policy.lifecycle && typeof room.state["phase"] === "string") {
      summary["phase"] = room.state["phase"];
    }
    // The reward's **thumb only**: enough for a client to draw the room's own picture on the map
    // instead of a generic pin, which is the difference between a map of markers and a map of things
    // worth walking to. Deliberately not the whole `media[]`: a discovery response carries every
    // room in the queried cells, and the full array (thumb + full + credit lines, per room) is
    // the kind of payload that turns a dense city block into a slow read. The full set stays on the
    // room resolve, where a detail screen is asking about exactly one thing.
    const thumb = pickMedia(room.media, "thumb");
    if (thumb) summary["media"] = thumb;

    const obj: RoomSummary = {
      id: room.id,
      type: room.type,
      location: room.location,
      summary,
    };
    // Carry the room's minter to discovering clients for DISPLAY (minter handle/badge on the
    // marker, beacon.core `doc/spec/identity.md` §9). Verification needs the full signed birth set
    // { unique, kind, policy }, and the policy isn't in the summary — so a client verifies
    // `mintedBy` after resolving the full room (optimistic display, verify on interact). (No client
    // consumes it yet; the field is here so that seam exists.)
    if (room.game !== undefined) obj.game = room.game;
    if (room.mintedBy !== undefined) obj.mintedBy = room.mintedBy;
    if (room.live !== undefined) obj.live = room.live;
    return obj;
  }
}

/**
 * Whether a game-filtered read shows this room: some game in `games` owns it or may act on it
 * (`roomOpenToGame`). No filter shows every room. The one rule discovery and room fetch share.
 */
function openToAnyOf(
  room: Pick<Room, "game" | "policy">,
  games: readonly string[] | undefined,
): boolean {
  return games === undefined || games.some((g) => roomOpenToGame(room, g));
}
