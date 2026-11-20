import type { DidKey, ServerAccessLevel } from "@beaconsgg/protocol-types";
import { HttpStatus } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { MAX_PENDING_REQUESTS, MemberList } from "../common/member-list";
import { MemoryAccessStore } from "./memory-stores";
import { rejectedWith } from "./test-helpers";

const ADMIN = "did:key:zAdmin" as DidKey;
const ANA = "did:key:zAna" as DidKey;
const BO = "did:key:zBo" as DidKey;
const T1 = "2026-11-15T01:00:00.000Z";
const T2 = "2026-11-15T02:00:00.000Z";

function list(level: ServerAccessLevel = "request", store = new MemoryAccessStore()) {
  const config = { accessLevel: level };
  return { members: new MemberList(store, config, [ADMIN]), config, store };
}

describe("MemberList", () => {
  it("admits everyone at open, and only members and admins otherwise", async () => {
    const { members, config } = list("open");
    expect(members.admits(ANA)).toBe(true);
    config.accessLevel = "request";
    expect(members.admits(ANA)).toBe(false);
    expect(members.admits(ADMIN)).toBe(true);
    await members.add(ANA, ADMIN, T1);
    expect(members.admits(ANA)).toBe(true);
    config.accessLevel = "private";
    expect(members.admits(ANA)).toBe(true);
    expect(members.admits(BO)).toBe(false);
  });

  it("refuses a non-member with 403 notMember", async () => {
    const { members } = list();
    const err = await rejectedWith(() => members.assertMember(ANA));
    expect(err.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(err.getResponse()).toMatchObject({ ok: false, error: "notMember" });
  });

  it("records a request, replaces its note, and leaves a member or a declined player alone", async () => {
    const { members } = list();
    expect(members.status(ANA)).toBe("none");
    expect(await members.request(ANA, "it's Ana", T1)).toBe("pending");
    expect(await members.request(ANA, undefined, T2)).toBe("pending");
    expect(members.list("pending")).toEqual([{ did: ANA, status: "pending", requestedAt: T2 }]);

    await members.decline(ANA, ADMIN, T2);
    expect(await members.request(ANA, "please", T2)).toBe("declined");
    expect(members.status(ANA)).toBe("declined");

    await members.add(BO, ADMIN, T1);
    expect(await members.request(BO, "hi", T2)).toBe("member");
    expect(members.list("member")[0]).not.toHaveProperty("note");
  });

  it("an approval keeps the request's note and time, and records who decided when", async () => {
    const { members } = list();
    await members.request(ANA, "it's Ana", T1);
    expect(await members.add(ANA, ADMIN, T2)).toEqual({
      did: ANA,
      status: "member",
      note: "it's Ana",
      requestedAt: T1,
      decidedBy: ADMIN,
      decidedAt: T2,
    });
  });

  it("declines only a pending request", async () => {
    const { members } = list();
    expect(await members.decline(ANA, ADMIN, T1)).toBeUndefined();
    await members.add(BO, ADMIN, T1);
    expect(await members.decline(BO, ADMIN, T1)).toBeUndefined();
    expect(members.status(BO)).toBe("member");
  });

  it("a removed entry lets a declined player ask again, and takes a member's access away", async () => {
    const { members } = list();
    await members.request(ANA, undefined, T1);
    await members.decline(ANA, ADMIN, T1);
    expect(await members.remove(ANA)).toBe(true);
    expect(await members.request(ANA, undefined, T2)).toBe("pending");
    await members.add(BO, ADMIN, T1);
    await members.remove(BO);
    expect(members.admits(BO)).toBe(false);
    expect(await members.remove(BO)).toBe(false);
  });

  it("caps the requests waiting for an answer, but a waiting request may still change its note", async () => {
    const { members } = list();
    for (let i = 0; i < MAX_PENDING_REQUESTS; i += 1) {
      await members.request(`did:key:zP${String(i)}` as DidKey, undefined, T1);
    }
    expect(members.pendingCount()).toBe(MAX_PENDING_REQUESTS);
    expect(await members.request(ANA, undefined, T1)).toBe("full");
    expect(await members.request("did:key:zP0" as DidKey, "new note", T2)).toBe("pending");
  });

  it("admitAll admits only accounts with no entry, leaving requests and declines to the operator", async () => {
    const { members } = list();
    await members.add(ANA, ADMIN, T1);
    await members.request(BO, "hi", T1);
    const dee = "did:key:zDee" as DidKey;
    await members.request(dee, undefined, T1);
    await members.decline(dee, ADMIN, T1);
    const carl = "did:key:zCarl" as DidKey;
    expect(await members.admitAll([ADMIN, ANA, BO, carl, dee], ADMIN, T2)).toBe(1);
    expect(members.list().map((e) => [e.did, e.status])).toEqual([
      [BO, "pending"],
      [ANA, "member"],
      [carl, "member"],
      [dee, "declined"],
    ]);
  });

  it("a request racing a decline cannot undo it", async () => {
    const { members } = list();
    await members.request(ANA, undefined, T1);
    await Promise.all([members.decline(ANA, ADMIN, T2), members.request(ANA, "again", T2)]);
    expect(members.status(ANA)).toBe("declined");
  });

  it("a write the store refuses leaves the cache as it was", async () => {
    const store = new MemoryAccessStore();
    store.put = () => Promise.reject(new Error("lost the connection"));
    const { members } = list("request", store);
    await expect(members.admitAll([ANA, BO], ADMIN, T1)).rejects.toThrow("lost the connection");
    expect(members.admits(ANA)).toBe(false);
    expect(members.list()).toEqual([]);
  });

  it("lists pending oldest first, then members, then declined, and survives a restart", async () => {
    const { members, store } = list();
    await members.request(BO, undefined, T2);
    await members.request(ANA, undefined, T1);
    await members.add("did:key:zM" as DidKey, ADMIN, T1);
    await members.request("did:key:zD" as DidKey, undefined, T1);
    await members.decline("did:key:zD" as DidKey, ADMIN, T2);
    const order = [ANA, BO, "did:key:zM", "did:key:zD"];
    expect(members.list().map((e) => e.did)).toEqual(order);
    expect(members.pendingCount()).toBe(2);

    const { members: rebooted } = list("request", store);
    await rebooted.onModuleInit();
    expect(rebooted.list().map((e) => e.did)).toEqual(order);
    expect(rebooted.admits("did:key:zM")).toBe(true);
  });
});
