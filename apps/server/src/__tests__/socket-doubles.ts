import type { Namespace, Socket } from "socket.io";

/**
 * A minimal socket.io `Socket` double for gateway unit tests: a `rooms` Set with `join`/`leave` and an
 * `id` (socket.io auto-joins the id room). Shared by the room + mailbox gateway tests so the double
 * can't drift between them.
 */
export function fakeSocket(id = "sock1", auth: Record<string, unknown> = {}): Socket {
  const rooms = new Set<string>([id]);
  return {
    id,
    rooms,
    handshake: { auth }, // what the client sent on connect, e.g. its `understands` declaration
    // socket.io's `join` takes one room or several.
    join: (r: string | string[]) => {
      for (const room of Array.isArray(r) ? r : [r]) rooms.add(room);
    },
    leave: (r: string) => rooms.delete(r),
  } as unknown as Socket;
}

/**
 * A namespace (or server) double that records every `to(rooms).emit(event, payload)` fan-out, one
 * entry per call with the rooms as given: socket.io's `to` takes one room or several.
 */
export function fakeNamespace(): {
  ns: Namespace;
  emits: Array<{ rooms: string | string[]; event: string; payload: unknown }>;
} {
  const emits: Array<{ rooms: string | string[]; event: string; payload: unknown }> = [];
  const ns = {
    to(rooms: string | string[]) {
      return { emit: (event: string, payload: unknown) => emits.push({ rooms, event, payload }) };
    },
  };
  return { ns: ns as unknown as Namespace, emits };
}
