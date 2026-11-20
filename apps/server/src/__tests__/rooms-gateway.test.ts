import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { ANY_GAME, type MapDelta } from "@beaconsgg/protocol-types";
import type { Server } from "socket.io";
import { RoomsGateway } from "../rooms/rooms.gateway";
import { fakeNamespace, fakeSocket } from "./socket-doubles";

const gid = (): string => `${ulid()}@h.example`;

describe("RoomsGateway.onSubscribe — per-socket subscription cap", () => {
  it("accepts a valid subscribe and joins the room", () => {
    const gw = new RoomsGateway();
    const sock = fakeSocket();
    const id = gid();
    expect(gw.onSubscribe(sock, { room: id })).toEqual({ ok: true, room: id });
    expect(sock.rooms.has(id)).toBe(true);
  });

  it("rejects a malformed room id", () => {
    expect(new RoomsGateway().onSubscribe(fakeSocket(), { room: "not a global id" })).toEqual({
      ok: false,
    });
  });

  it("rejects a new subscribe once the socket holds 256 room subscriptions", () => {
    const gw = new RoomsGateway();
    const sock = fakeSocket("s");
    for (let i = 0; i < 256; i++) sock.rooms.add(`${i}room@h.example`);
    expect(gw.onSubscribe(sock, { room: gid() })).toEqual({
      ok: false,
      error: "tooManySubscriptions",
    });
  });

  it("does not count cell:* joins or idempotent re-subscribes toward the cap", () => {
    const gw = new RoomsGateway();
    const sock = fakeSocket("s");
    for (let i = 0; i < 300; i++) sock.rooms.add(`cell:${i}`); // map-cell joins are separately bounded
    const id = gid();
    expect(gw.onSubscribe(sock, { room: id }).ok).toBe(true); // under cap despite 300 cell joins
    expect(gw.onSubscribe(sock, { room: id }).ok).toBe(true); // re-subscribe is idempotent, still ok
  });
});

describe("RoomsGateway — the map channel, scoped by the game a socket names", () => {
  const cell = "c23nb";

  it("puts a socket that named no game in the whole cell", () => {
    const sock = fakeSocket("s");
    expect(new RoomsGateway().onSetCells(sock, { cells: [cell] })).toEqual({ ok: true, cells: 1 });
    expect([...sock.rooms].filter((r) => r.startsWith("cell:"))).toEqual([`cell:${cell}`]);
  });

  it("puts a socket that named a game in its game's rooms and the every-game one", () => {
    const sock = fakeSocket("s", { game: "game-a" });
    new RoomsGateway().onSetCells(sock, { cells: [cell] });
    expect([...sock.rooms].filter((r) => r.startsWith("cell:")).sort()).toEqual(
      [`cell:${ANY_GAME}:${cell}`, `cell:game-a:${cell}`].sort(),
    );
  });

  it("reads a malformed handshake game as no game, like a malformed `understands`", () => {
    const sock = fakeSocket("s", { game: "Not A Slug" });
    new RoomsGateway().onSetCells(sock, { cells: [cell] });
    expect([...sock.rooms].filter((r) => r.startsWith("cell:"))).toEqual([`cell:${cell}`]);
  });

  it("re-joins from scratch on every setCells, so a moved view leaves its old cells", () => {
    const sock = fakeSocket("s", { game: "game-a" });
    const gw = new RoomsGateway();
    gw.onSetCells(sock, { cells: [cell] });
    gw.onSetCells(sock, { cells: ["c23nc"] });
    expect([...sock.rooms].some((r) => r.endsWith(cell))).toBe(false);
  });

  it("refuses cells that are not live-map length, and keeps the cells it had (beacon.server#81)", () => {
    const sock = fakeSocket("s");
    const gw = new RoomsGateway();
    gw.onSetCells(sock, { cells: [cell] });
    for (const wrong of ["c23n", "c23nbx", ""]) {
      expect(gw.onSetCells(sock, { cells: [cell, wrong] })).toEqual({ ok: false });
    }
    expect([...sock.rooms].filter((r) => r.startsWith("cell:"))).toEqual([`cell:${cell}`]);
    expect(gw.onSetCells(sock, { cells: [] })).toEqual({ ok: true, cells: 0 });
  });

  it("emits a delta to the whole cell and to the rooms of the games it is for", () => {
    const { ns, emits } = fakeNamespace();
    const gw = new RoomsGateway();
    gw.server = ns as unknown as Server;
    const delta: MapDelta = { cell, kind: "roomGone", id: "x@h" };

    gw.broadcastMap(delta, ["game-a", "game-b"]);
    gw.broadcastMap(delta, [ANY_GAME]);
    expect(emits.map((e) => e.rooms)).toEqual([
      [`cell:${cell}`, `cell:game-a:${cell}`, `cell:game-b:${cell}`],
      [`cell:${cell}`, `cell:${ANY_GAME}:${cell}`],
    ]);
  });
});
