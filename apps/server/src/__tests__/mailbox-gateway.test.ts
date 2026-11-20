import { buildProfile, createWallet, signOpWithWallet } from "@beaconsgg/identity";
import type { DidKey, MailboxMessage } from "@beaconsgg/protocol-types";
import { ulid } from "ulid";
import { afterEach, describe, expect, it } from "vitest";
import { SignedRequestGate } from "../common/signed-request-gate";
import { MailboxGateway } from "../mailbox/mailbox.gateway";
import { ProfilesService } from "../profiles/profiles.service";
import { type MailboxConfig, MailboxService } from "../mailbox/mailbox.service";
import { memoryMailbox } from "./memory-stores";
import { fakeNamespace, fakeSocket } from "./socket-doubles";
import {
  TEST_GAME,
  signedEnv,
  testBlocklist,
  testBlocklistFromEnv,
  testSignedRequestGate,
  testMemberList,
} from "./test-helpers";

type Wallet = ReturnType<typeof createWallet>;

const subscribeEnv = (w: Wallet) => signedEnv(w, "mailbox.subscribe");
/** The live config a gateway reads, with the mailbox on. */
const ON = { mailboxEnabled: true };

afterEach(() => {
  delete process.env["BEACON_BLOCKLIST"];
});

describe("MailboxGateway.onSubscribe — signed private subscribe", () => {
  it("verifies the envelope and joins the actor's DID-keyed room", () => {
    const gw = new MailboxGateway(testSignedRequestGate(), ON);
    const alice = createWallet();
    const sock = fakeSocket();

    expect(gw.onSubscribe(sock, { env: subscribeEnv(alice) })).toEqual({ ok: true });
    expect(sock.rooms.has(`mbx:${alice.account.did}:${TEST_GAME}`)).toBe(true);
  });

  it("refuses a subscribe that names no game, and leaves the box it held before", () => {
    const gw = new MailboxGateway(testSignedRequestGate(), ON);
    const alice = createWallet();
    const sock = fakeSocket();
    expect(gw.onSubscribe(sock, { env: subscribeEnv(alice) })).toEqual({ ok: true });
    const gameless = signedEnv(alice, "mailbox.subscribe", {}, undefined, null);

    expect(gw.onSubscribe(sock, { env: gameless })).toEqual({
      ok: false,
      error: "gameNotAdmitted",
    });
    expect([...sock.rooms].some((r) => r.startsWith("mbx:"))).toBe(false);
  });

  it("refuses while the mailbox is off, and follows the live setting (beacon.server#81)", () => {
    const config = { mailboxEnabled: false };
    const gw = new MailboxGateway(testSignedRequestGate(), config);
    const alice = createWallet();
    const sock = fakeSocket();
    expect(gw.onSubscribe(sock, { env: subscribeEnv(alice) })).toEqual({
      ok: false,
      error: "unknownRoute",
    });
    expect([...sock.rooms].some((r) => r.startsWith("mbx:"))).toBe(false);

    config.mailboxEnabled = true; // an operator turns the mailbox on at runtime
    expect(gw.onSubscribe(sock, { env: subscribeEnv(alice) })).toEqual({ ok: true });
  });

  it("rejects a missing / malformed envelope", () => {
    const gw = new MailboxGateway(testSignedRequestGate(), ON);
    expect(gw.onSubscribe(fakeSocket(), {}).ok).toBe(false);
    expect(gw.onSubscribe(fakeSocket(), { env: { not: "an envelope" } }).ok).toBe(false);
  });

  it("rejects an envelope naming the wrong op (a fetch/send can't join)", () => {
    const gw = new MailboxGateway(testSignedRequestGate(), ON);
    const alice = createWallet();
    const wrongOp = signOpWithWallet(alice, { op: "mailbox.fetch", nonce: ulid(), params: {} });
    expect(gw.onSubscribe(fakeSocket(), { env: wrongOp }).ok).toBe(false);
  });

  it("rejects a blocked sender (403-equivalent)", () => {
    const alice = createWallet();
    process.env["BEACON_BLOCKLIST"] = alice.account.did;
    const gw = new MailboxGateway(testSignedRequestGate({ blocklist: testBlocklistFromEnv() }), ON);
    const sock = fakeSocket();

    expect(gw.onSubscribe(sock, { env: subscribeEnv(alice) })).toEqual({
      ok: false,
      error: "denied",
    });
    expect(sock.rooms.has(`mbx:${alice.account.did}:${TEST_GAME}`)).toBe(false);
  });

  it("rejects a revoked device, so a lost phone can't keep receiving its owner's mail live", async () => {
    // The live channel is the one signed surface that is not an HTTP route, so neither the
    // `grep isRevoked` survey nor a walk of the `@Post` routes could see it. Closing
    // `POST /mailbox/fetch` alone left the phone subscribed: it stops pulling history and keeps
    // getting the same messages pushed, one at a time.
    //
    // Against a REAL registry, because "revoked" only becomes true once a root-signed profile
    // published by the owner says so — the thing a double would have asserted into existence.
    const w = createWallet();
    const profiles = new ProfilesService(testBlocklist()); // no store -> pure in-memory registry
    const devices = [{ did: w.device.did, auth: w.auth }];
    await profiles.publish(buildProfile(w.account, { version: 1, devices, revoked: [] }));

    const gw = new MailboxGateway(
      new SignedRequestGate(testBlocklist(), profiles, testMemberList()),
      ON,
    );
    const before = fakeSocket();
    expect(gw.onSubscribe(before, { env: subscribeEnv(w) })).toEqual({ ok: true }); // live at v1

    await profiles.publish(
      buildProfile(w.account, { version: 2, devices, revoked: [w.device.did] }),
    );
    // An app that predates `deviceRevoked` is told what it already handles.
    const after = fakeSocket();
    expect(gw.onSubscribe(after, { env: subscribeEnv(w) })).toEqual({ ok: false, error: "denied" });
    expect(after.rooms.has(`mbx:${w.account.did}:${TEST_GAME}`)).toBe(false);
    // One that declared it on connect is told the cause. Global filters never reach a gateway, so
    // this is the gateway's own downgrade, not the HTTP one.
    const declared = fakeSocket("sock2", { understands: "code:deviceRevoked" });
    expect(gw.onSubscribe(declared, { env: subscribeEnv(w) })).toEqual({
      ok: false,
      error: "deviceRevoked",
    });

    // The consult is per subscribe, so the socket that joined *before* the revocation stays joined
    // and keeps receiving pushes until it drops. Asserted rather than hidden: it is the residual
    // window, it closes on the next reconnect, and narrowing it means tracking device→socket to
    // evict live connections on publish.
    expect(before.rooms.has(`mbx:${w.account.did}:${TEST_GAME}`)).toBe(true);
  });

  it("serves one identity per socket — a re-subscribe leaves the prior mailbox room", () => {
    const gw = new MailboxGateway(testSignedRequestGate(), ON);
    const alice = createWallet();
    const bob = createWallet();
    const sock = fakeSocket();

    gw.onSubscribe(sock, { env: subscribeEnv(alice) });
    gw.onSubscribe(sock, { env: subscribeEnv(bob) });

    expect(sock.rooms.has(`mbx:${alice.account.did}:${TEST_GAME}`)).toBe(false);
    expect(sock.rooms.has(`mbx:${bob.account.did}:${TEST_GAME}`)).toBe(true);
  });
});

describe("MailboxGateway.broadcastMail — recipient-scoped fan-out", () => {
  it("emits `mail` only to the recipient's room", () => {
    const gw = new MailboxGateway(testSignedRequestGate(), ON);
    const { ns, emits } = fakeNamespace();
    gw.server = ns;

    const recipient = createWallet().account.did;
    const message: MailboxMessage = {
      id: ulid(),
      from: createWallet().account.did,
      body: "hello",
      receivedAt: "2026-07-13T00:00:00.000Z",
      expiresAt: "2026-07-20T00:00:00.000Z",
    };
    gw.broadcastMail(recipient, TEST_GAME, message);

    expect(emits).toEqual([
      { rooms: `mbx:${recipient}:${TEST_GAME}`, event: "mail", payload: message },
    ]);
  });
});

describe("MailboxService → broadcaster (a send delivers a live push exactly once)", () => {
  const CFG: MailboxConfig = {
    writeLocked: false,
    enabled: true,
    ttlSeconds: 7 * 24 * 60 * 60,
    maxBody: 256,
    sendMax: 60,
    sendWindowMs: 60_000,
  };

  it("broadcasts on a genuine send but not on a deduped (same-nonce) retry", async () => {
    const pushed: Array<{ recipient: DidKey; game: string; message: MailboxMessage }> = [];
    const broadcaster = {
      broadcastMail: (recipient: DidKey, game: string, message: MailboxMessage) =>
        pushed.push({ recipient, game, message }),
    };
    const svc = new MailboxService(
      memoryMailbox(),
      CFG,
      () => Date.parse("2026-07-13T00:00:00.000Z"),
      broadcaster,
    );
    const from = createWallet().account.did;
    const to = createWallet().account.did;
    const nonce = ulid();

    const first = await svc.send(to, from, TEST_GAME, "hi", nonce);
    const retry = await svc.send(to, from, TEST_GAME, "hi", nonce); // same nonce → store dedups, no second push

    expect(retry.id).toBe(first.id);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.recipient).toBe(to);
    expect(pushed[0]?.game).toBe(TEST_GAME);
    expect(pushed[0]?.message).toMatchObject({ id: first.id, from, body: "hi" });
  });
});
