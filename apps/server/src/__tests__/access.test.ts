import { buildProfile, createWallet } from "@beaconsgg/identity";
import type { DidKey, ServerAccessLevel } from "@beaconsgg/protocol-types";
import { HttpStatus } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { AccessAdminController } from "../access/access-admin.controller";
import { AccessController } from "../access/access.controller";
import { AdminGate } from "../common/admin-gate";
import { DidBudgets } from "../common/did-budgets";
import { NonceService } from "../common/nonce.service";
import { ProfilesService } from "../profiles/profiles.service";
import { memoryNonces } from "./memory-stores";
import {
  rejectedWith,
  signedEnv,
  testBlocklist,
  testMemberList,
  testSignedRequestGate,
} from "./test-helpers";

/**
 * The member list end to end (`doc/spec/admin-api.md` §6): a player asks, an admin answers, and the
 * write bracket admits only members once the server is off `open`.
 */
function harness(level: ServerAccessLevel = "request") {
  const admin = createWallet();
  const config = { accessLevel: level };
  const members = testMemberList(config, [admin.account.did]);
  const gate = testSignedRequestGate({ members });
  const nonce = new NonceService(memoryNonces(), { retentionMs: 10 * 60_000, writeLocked: false });
  const profiles = new ProfilesService(testBlocklist());
  const player = new AccessController(members, gate, nonce, new DidBudgets());
  const operator = new AccessAdminController(
    new AdminGate(gate, nonce, [admin.account.did]),
    members,
    nonce,
    profiles,
  );
  return { admin, config, members, gate, player, operator, profiles };
}

const as = (wallet: ReturnType<typeof createWallet>, op: string, params = {}) =>
  signedEnv(wallet, op, params, undefined, null);

describe("access.request and access.status", () => {
  it("a request waits for an answer, and the player can read where they stand", async () => {
    const { player } = harness();
    const ana = createWallet();
    expect(await player.status(as(ana, "access.status"))).toEqual({
      ok: true,
      accessLevel: "request",
      status: "none",
    });
    expect(await player.request(as(ana, "access.request", { note: "it's Ana" }))).toEqual({
      ok: true,
      accessLevel: "request",
      status: "pending",
    });
    expect((await player.status(as(ana, "access.status"))).status).toBe("pending");
  });

  it("an open server answers member and records nothing", async () => {
    const { player, members } = harness("open");
    const reply = await player.request(as(createWallet(), "access.request"));
    expect(reply).toEqual({ ok: true, accessLevel: "open", status: "member" });
    expect(members.list()).toEqual([]);
  });

  it("a private server takes no requests", async () => {
    const { player } = harness("private");
    const err = await rejectedWith(() => player.request(as(createWallet(), "access.request")));
    expect(err.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(err.getResponse()).toMatchObject({ error: "denied" });
  });

  it("a retried request answers what the first one left", async () => {
    const { player } = harness();
    const env = as(createWallet(), "access.request");
    await player.request(env);
    expect((await player.request(env)).status).toBe("pending");
  });
});

describe("the write bracket", () => {
  it("refuses a non-member's write with notMember, and lets their reads through", async () => {
    const { gate, config } = harness();
    const ana = createWallet();
    const err = await rejectedWith(() => gate.verifyWrite(as(ana, "mailbox.send"), "mailbox.send"));
    expect(err.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(err.getResponse()).toMatchObject({ error: "notMember" });
    expect(gate.verify(as(ana, "mailbox.fetch"), "mailbox.fetch").actor).toBe(ana.account.did);
    config.accessLevel = "open";
    expect(gate.verifyWrite(as(ana, "mailbox.send"), "mailbox.send").actor).toBe(ana.account.did);
  });

  it("admits a member and an admin", async () => {
    const { gate, members, admin } = harness("private");
    const ana = createWallet();
    await members.add(ana.account.did, admin.account.did, new Date().toISOString());
    expect(gate.verifyWrite(as(ana, "mailbox.send"), "mailbox.send").actor).toBe(ana.account.did);
    expect(gate.verifyWrite(as(admin, "media.put"), "media.put").actor).toBe(admin.account.did);
  });
});

describe("admin.access.*", () => {
  it("an admin approves a request, and the player may then write", async () => {
    const { player, operator, gate, admin } = harness();
    const ana = createWallet();
    await player.request(as(ana, "access.request", { note: "it's Ana" }));
    const pending = await operator.fetch(as(admin, "admin.access.fetch", { status: "pending" }));
    expect(pending.entries.map((e) => [e.did, e.note])).toEqual([[ana.account.did, "it's Ana"]]);

    const { entry } = await operator.add(as(admin, "admin.access.add", { did: ana.account.did }));
    expect(entry).toMatchObject({ status: "member", decidedBy: admin.account.did });
    expect(gate.verifyWrite(as(ana, "mailbox.send"), "mailbox.send").actor).toBe(ana.account.did);
  });

  it("a declined player cannot ask again until the entry is removed", async () => {
    const { player, operator, admin } = harness();
    const ana = createWallet();
    await player.request(as(ana, "access.request"));
    await operator.decline(as(admin, "admin.access.decline", { did: ana.account.did }));
    expect((await player.request(as(ana, "access.request"))).status).toBe("declined");

    const removed = await operator.remove(
      as(admin, "admin.access.remove", { did: ana.account.did }),
    );
    expect(removed).toEqual({ ok: true, removed: true });
    expect((await player.request(as(ana, "access.request"))).status).toBe("pending");
  });

  it("declining an account with no pending request is a 400", async () => {
    const { operator, admin } = harness();
    const did = createWallet().account.did;
    const err = await rejectedWith(() =>
      operator.decline(as(admin, "admin.access.decline", { did })),
    );
    expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
  });

  it("admitAll makes a member of every account with a profile here", async () => {
    const { operator, profiles, members, admin } = harness("private");
    const players = [createWallet(), createWallet()];
    for (const w of players) {
      await profiles.publish(
        buildProfile(w.account, { version: 1, devices: [{ did: w.device.did, auth: w.auth }] }),
      );
    }
    expect(await operator.admitAll(as(admin, "admin.access.admitAll"))).toEqual({
      ok: true,
      added: 2,
    });
    for (const w of players) expect(members.admits(w.account.did as DidKey)).toBe(true);
  });

  it("refuses a signer who is not an admin", async () => {
    const { operator } = harness();
    const err = await rejectedWith(() => operator.fetch(as(createWallet(), "admin.access.fetch")));
    expect(err.getStatus()).toBe(HttpStatus.FORBIDDEN);
  });
});
