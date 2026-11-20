import type { DidKey, Role, Room } from "@beaconsgg/protocol-types";

/** Recorded contributor dids; empty for a room nobody has contributed to. */
export function contributors(room: Room): string[] {
  const c = room.state["contributors"];
  if (Array.isArray(c)) return c.filter((x): x is string => typeof x === "string");
  // The contributors ledger is a did -> uniques map (what `contribute` writes); its keys are the dids.
  if (typeof c === "object" && c !== null) return Object.keys(c);
  return [];
}

/**
 * Resolve whether `actor` (the account) satisfies a policy role (`doc/spec/room-operation.md`
 * §8.2). Identity-based, so it rides the verified axis — not anti-cheat.
 */
export function roleAllows(role: Role, actor: DidKey, room: Room): boolean {
  if (role === "public") return true;
  if (role === "owner") return actor === room.placedBy;
  if (role === "contributor") return contributors(room).includes(actor);
  // explicit key list
  return Array.isArray(role) && role.includes(actor);
}

/** The room's current lifecycle phase, if it has one (a room with no lifecycle has none). */
export function currentPhase(room: Room): string | undefined {
  const p = room.state["phase"];
  return typeof p === "string" ? p : undefined;
}
