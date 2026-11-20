import {
  ANY_GAME,
  cellsSubscribeSchema,
  conformsTo,
  gameSlugSchema,
  globalIdSchema,
  type LiveEvent,
  type MapDelta,
} from "@beaconsgg/protocol-types";
import { LIVE_CELL_PRECISION } from "@beaconsgg/geo";
import { Logger } from "@nestjs/common";
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import type { Server, Socket } from "socket.io";
import { boolEnv } from "../common/env";

/**
 * The map channel's socket.io rooms, all under `cell:` (beacon.core `doc/spec/discovery.md` §6.1).
 * A socket that named no game joins `cell:<cell>` and hears everything in the cell. A socket that
 * named game `g` joins `cell:g:<cell>` (what is `g`'s, or opened to it by name) and `cell:*:<cell>`
 * (what is opened to every game, and every tombstone). Neither a geohash nor a slug holds a `:`, so
 * the names cannot collide.
 */
const CELL_ROOM = (cell: string): string => `cell:${cell}`;
const GAME_CELL_ROOM = (game: string, cell: string): string => `cell:${game}:${cell}`;

/** The game a socket named in its handshake (`auth.game`), if it named a well-formed one. */
function socketGame(client: Socket): string | undefined {
  const game: unknown = client.handshake?.auth?.["game"];
  return conformsTo(gameSlugSchema, game) ? game : undefined;
}

/** Cap on distinct room subscriptions per socket (the map-cell set is separately bounded at 256). */
const MAX_ROOM_SUBSCRIPTIONS = 256;

/** Render a cell list for a log line — first few, then a "+N more" tail so it stays one line. */
function previewCells(cells: readonly string[], max = 8): string {
  const head = cells.slice(0, max).join(",");
  return cells.length > max ? `${head},+${cells.length - max} more` : head;
}

/** The subject id of a map delta (room/scout upsert or tombstone), for a log line. */
function mapDeltaSubjectId(delta: MapDelta): string {
  switch (delta.kind) {
    case "room":
      return delta.room.id;
    case "scout":
      return delta.scout.id;
    case "roomGone":
    case "scoutGone":
      return delta.id;
  }
}

/** Count a socket's room-subscription joins — excludes its own id room and `cell:*` map joins. */
function roomSubscriptionCount(client: Socket): number {
  let n = 0;
  for (const r of client.rooms) {
    if (r === client.id || r.startsWith("cell:")) continue;
    n += 1;
  }
  return n;
}

/**
 * The live channel (`doc/spec/room-operation.md` §10): a WebSocket carrying **server->client events
 * only**. Clients `subscribe` to a room and receive ordered `delta` events. All ops go over REST,
 * never over this socket. Per-room fan-out uses socket.io rooms.
 *
 * The **map channel** (beacon.core `doc/spec/discovery.md` §6) rides the same socket: a client
 * keeping the map open declares the geohash cells in view via `setCells`, and receives coarse `map`
 * deltas (object / scout lifecycle) for those cells — so it patches markers without re-polling
 * discovery.
 *
 * CORS + WS origin checks are enforced by the socket.io adapter in `main.ts` (built from
 * `BEACON_CORS_ORIGINS`), not this decorator — the adapter has the runtime config. The decorator
 * stays permissive so the adapter is the single origin authority.
 */
@WebSocketGateway({ cors: { origin: true } })
export class RoomsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(RoomsGateway.name);
  /**
   * Opt-in verbose live-channel logging (`BEACON_WS_DEBUG=1`). Off by default; when on, logs the
   * map-watch lifecycle — connect (with transport, so you can confirm it's a real WebSocket, not
   * polling), `subscribe`, `setCells`, and each `map` broadcast with a live watcher count — so a
   * device/server playtest can verify the socket + `setCells` are actually flowing. Mirrors the
   * `BEACON_WRITE_RATE_LIMIT_DEBUG` pattern; read straight from env (not the config schema).
   */
  private readonly debug = boolEnv("BEACON_WS_DEBUG");

  /** Log a new live-channel connection (transport confirms WebSocket vs polling). */
  handleConnection(client: Socket): void {
    if (!this.debug) return;
    const transport = client.conn?.transport?.name ?? "?";
    const origin = client.handshake?.headers?.origin ?? "-";
    this.logger.log(`ws connect id=${client.id} transport=${transport} origin=${origin}`);
  }

  handleDisconnect(client: Socket): void {
    if (this.debug) this.logger.log(`ws disconnect id=${client.id}`);
  }

  @SubscribeMessage("subscribe")
  onSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { room?: string },
  ): { ok: boolean; room?: string; error?: string } {
    const room = globalIdSchema.safeParse(body?.room);
    if (!room.success) {
      if (this.debug) this.logger.log(`subscribe id=${client.id} -> rejected (invalid room)`);
      return { ok: false };
    }
    // Cap distinct room subscriptions per socket so one connection can't join unbounded rooms and
    // inflate socket.io's membership maps. Re-subscribing to an already-joined room is idempotent and
    // doesn't count toward the cap.
    if (!client.rooms.has(room.data) && roomSubscriptionCount(client) >= MAX_ROOM_SUBSCRIPTIONS) {
      if (this.debug)
        this.logger.log(`subscribe id=${client.id} room=${room.data} -> rejected (cap)`);
      return { ok: false, error: "tooManySubscriptions" };
    }
    void client.join(room.data);
    if (this.debug) this.logger.log(`subscribe id=${client.id} room=${room.data} -> ok`);
    return { ok: true, room: room.data };
  }

  @SubscribeMessage("unsubscribe")
  onUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { room?: string },
  ): { ok: boolean } {
    const room = globalIdSchema.safeParse(body?.room);
    if (room.success) {
      void client.leave(room.data);
      if (this.debug) this.logger.log(`unsubscribe id=${client.id} room=${room.data}`);
    }
    return { ok: true };
  }

  /**
   * Declare the live map cells this socket is watching (replace, not add): leave any cell rooms the
   * view no longer covers, join the new set (≤256, validated by `cellsSubscribeSchema`). The client
   * re-sends its full cell set on each pan/zoom, so the gateway just reconciles.
   *
   * Every cell must be `LIVE_CELL_PRECISION` characters long, because `map` events are keyed on cells
   * of exactly that length. A coarser or finer cell would join a room that never hears an event, so
   * the set is refused whole and the socket keeps the cells it had.
   */
  @SubscribeMessage("setCells")
  onSetCells(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): { ok: boolean; cells?: number } {
    const parsed = cellsSubscribeSchema.safeParse(body);
    if (!parsed.success || parsed.data.cells.some((c) => c.length !== LIVE_CELL_PRECISION)) {
      if (this.debug) this.logger.log(`setCells id=${client.id} -> rejected (invalid)`);
      return { ok: false };
    }
    for (const room of client.rooms) {
      if (room.startsWith("cell:")) void client.leave(room);
    }
    const game = socketGame(client);
    for (const cell of parsed.data.cells) {
      if (game === undefined) void client.join(CELL_ROOM(cell));
      else void client.join([GAME_CELL_ROOM(game, cell), GAME_CELL_ROOM(ANY_GAME, cell)]);
    }
    if (this.debug) {
      const n = parsed.data.cells.length;
      this.logger.log(
        `setCells id=${client.id} count=${n} cells=[${previewCells(parsed.data.cells)}]`,
      );
    }
    return { ok: true, cells: parsed.data.cells.length };
  }

  /** Broadcast an ordered delta to every subscriber of a room. */
  broadcast(event: LiveEvent): void {
    this.server?.to(event.room).emit("delta", event);
    if (this.debug) {
      const watchers = this.server?.sockets.adapter.rooms.get(event.room)?.size ?? 0;
      this.logger.log(`delta -> room=${event.room} v=${event.version} watchers=${watchers}`);
    }
  }

  /**
   * Broadcast a coarse map delta to the sockets watching its cell that it is for: every socket that
   * named no game, and the sockets of `games` (`roomGames` for a room, so `ANY_GAME` reaches every
   * game's socket). A socket in several of the target rooms hears it once (socket.io dedupes a
   * multi-room emit).
   */
  broadcastMap(delta: MapDelta, games: readonly string[]): void {
    const rooms = [CELL_ROOM(delta.cell), ...games.map((g) => GAME_CELL_ROOM(g, delta.cell))];
    this.server?.to(rooms).emit("map", delta);
    if (this.debug) {
      // An upper bound: a game socket sits in two of the target rooms and hears the delta once.
      const adapterRooms = this.server?.sockets.adapter.rooms;
      const watchers = rooms.reduce((n, r) => n + (adapterRooms?.get(r)?.size ?? 0), 0);
      const id = mapDeltaSubjectId(delta);
      this.logger.log(`map -> cell=${delta.cell} kind=${delta.kind} id=${id} watchers=${watchers}`);
    }
  }
}
