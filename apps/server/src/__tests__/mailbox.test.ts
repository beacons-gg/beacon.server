import { createWallet, signOpWithWallet } from "@beaconsgg/identity";
import { type DidKey, type MailboxMessage, MAX_MAILBOX_BODY } from "@beaconsgg/protocol-types";
import { HttpException } from "@nestjs/common";
import { ulid } from "ulid";
import { afterEach, describe, expect, it } from "vitest";
import { NonceService } from "../common/nonce.service";
import { MailboxController } from "../mailbox/mailbox.controller";
import { type MailboxConfig, MailboxService } from "../mailbox/mailbox.service";
import { memoryMailbox, memoryNonces } from "./memory-stores";
import {
  TEST_GAME,
  rejectedWith,
  signedEnv,
  testBlocklistFromEnv,
  testGameGate,
  testSignedRequestGate,
} from "./test-helpers";

type Wallet = ReturnType<typeof createWallet>;

const BASE: MailboxConfig = {
  writeLocked: false,
  enabled: true,
  ttlSeconds: 7 * 24 * 60 * 60,
  maxBody: 256,
  sendMax: 60,
  sendWindowMs: 60_000,
};

/** A controllable clock so TTL/rate-window behavior is deterministic (envelope freshness uses real time). */
function makeClock(startIso = "2026-07-12T00:00:00.000Z") {
  let ms = Date.parse(startIso);
  return { now: () => ms, advanceSeconds: (s: number) => (ms += s * 1000) };
}

afterEach(() => {
  delete process.env["BEACON_BLOCKLIST"];
});

function setup(
  overrides: Partial<MailboxConfig> = {},
  clock = makeClock(),
  revokedDevices: string[] = [],
  admitted: string[] = [],
) {
  const store = memoryMailbox();
  const service = new MailboxService(store, { ...BASE, ...overrides }, clock.now);
  const nonce = new NonceService(
    memoryNonces(),
    { retentionMs: 10 * 60_000, writeLocked: false },
    clock.now,
  );
  const controller = new MailboxController(
    service,
    testSignedRequestGate({ blocklist: testBlocklistFromEnv(), revokedDevices }),
    nonce,
    testGameGate(admitted),
  );
  return { store, service, controller, clock };
}

const sendEnv = (from: Wallet, to: DidKey, body: string, nonce?: string) =>
  signedEnv(from, "mailbox.send", { to, body }, nonce);
const fetchEnv = (w: Wallet, game: string | null = TEST_GAME) =>
  signedEnv(w, "mailbox.fetch", {}, undefined, game);
const ackEnv = (w: Wallet, ids: string[]) => signedEnv(w, "mailbox.ack", { ids });

/** The HTTP status a call rejects with (fails if it resolves or throws a non-HttpException). */
async function rejectStatus(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof HttpException) return err.getStatus();
    throw err;
  }
  throw new Error("expected the call to reject");
}

describe("MailboxController", () => {
  it("delivers a message to the recipient and scopes fetch to the reader", async () => {
    const { controller } = setup();
    const alice = createWallet();
    const bob = createWallet();
    const carol = createWallet();

    await controller.send(sendEnv(alice, bob.account.did, "hello-bob"));
    await controller.send(sendEnv(alice, carol.account.did, "hello-carol"));

    const bobInbox = (await controller.fetch(fetchEnv(bob))).messages as MailboxMessage[];
    expect(bobInbox.map((m) => m.body)).toEqual(["hello-bob"]);
    expect(bobInbox[0]?.from).toBe(alice.account.did);

    const carolInbox = (await controller.fetch(fetchEnv(carol))).messages as MailboxMessage[];
    expect(carolInbox.map((m) => m.body)).toEqual(["hello-carol"]);
  });

  it("returns nothing for a reader with no messages (a stranger can't read another box)", async () => {
    const { controller } = setup();
    const alice = createWallet();
    const bob = createWallet();
    const mallory = createWallet();
    await controller.send(sendEnv(alice, bob.account.did, "for-bob"));

    const malloryInbox = (await controller.fetch(fetchEnv(mallory))).messages;
    expect(malloryInbox).toEqual([]);
  });

  it("rejects an unsigned/tampered request (400/401), never trusting a claimed actor", async () => {
    const { controller } = setup();
    const bob = createWallet();
    // Not an envelope at all → 400.
    expect(await rejectStatus(controller.fetch({ actor: bob.account.did }))).toBe(400);
    // A valid envelope but the wrong op for the route → 400.
    const wrongOp = signOpWithWallet(bob, { op: "mailbox.send", nonce: ulid(), params: {} });
    expect(await rejectStatus(controller.fetch(wrongOp))).toBe(400);
    // A signature that doesn't match the body → 401.
    const forged = { ...sendEnv(bob, bob.account.did, "x"), sig: "AAAA" };
    expect(await rejectStatus(controller.send(forged))).toBe(401);
  });

  it("is idempotent by nonce — a retried send returns the same id and stores one message", async () => {
    const { controller } = setup();
    const alice = createWallet();
    const bob = createWallet();
    const env = sendEnv(alice, bob.account.did, "once");
    const first = await controller.send(env);
    const retry = await controller.send(env); // same nonce
    expect(retry.id).toBe(first.id);
    const inbox = (await controller.fetch(fetchEnv(bob))).messages as MailboxMessage[];
    expect(inbox).toHaveLength(1);
  });

  it("acks (deletes) only the reader's own messages", async () => {
    const { controller } = setup();
    const alice = createWallet();
    const bob = createWallet();
    await controller.send(sendEnv(alice, bob.account.did, "a"));
    await controller.send(sendEnv(alice, bob.account.did, "b"));

    let inbox = (await controller.fetch(fetchEnv(bob))).messages as MailboxMessage[];
    expect(inbox).toHaveLength(2);

    // A different account acking bob's ids deletes nothing (recipient-scoped).
    const mallory = createWallet();
    expect((await controller.ack(ackEnv(mallory, [inbox[0]!.id]))).deleted).toBe(0);

    const acked = await controller.ack(ackEnv(bob, [inbox[0]!.id]));
    expect(acked.deleted).toBe(1);
    inbox = (await controller.fetch(fetchEnv(bob))).messages as MailboxMessage[];
    expect(inbox.map((m) => m.body)).toEqual(["b"]);
  });

  it("expires messages past the server TTL (fetch excludes them; sweep removes them)", async () => {
    const clock = makeClock();
    const { controller, store } = setup({ ttlSeconds: 3600 }, clock);
    const alice = createWallet();
    const bob = createWallet();
    await controller.send(sendEnv(alice, bob.account.did, "ephemeral"));

    clock.advanceSeconds(3600 + 1); // past the TTL
    expect((await controller.fetch(fetchEnv(bob))).messages).toEqual([]);
    expect(await store.sweepExpired(new Date(clock.now()).toISOString())).toBe(1);
  });

  it("enforces the per-DID send budget (429 over the window)", async () => {
    const { controller } = setup({ sendMax: 2 });
    const alice = createWallet();
    const bob = createWallet();
    await controller.send(sendEnv(alice, bob.account.did, "1"));
    await controller.send(sendEnv(alice, bob.account.did, "2"));
    expect(await rejectStatus(controller.send(sendEnv(alice, bob.account.did, "3")))).toBe(429);
  });

  it("rejects an over-size body with 413 (the operator cap, below the wire ceiling)", async () => {
    const { controller } = setup({ maxBody: 8 });
    const alice = createWallet();
    const bob = createWallet();
    expect(
      await rejectStatus(controller.send(sendEnv(alice, bob.account.did, "waytoolongbody"))),
    ).toBe(413);
  });

  it("answers tooLarge for a body over the wire cap in bytes but not in characters", async () => {
    // 2000 three-byte characters: 6000 bytes, under the 0.3 schema's 4096 characters and over the
    // 0.4 schema's 4096 bytes. The server's own limit is checked first, so the refusal is the
    // operator's 413 and not a malformed 400.
    const { controller } = setup({ maxBody: MAX_MAILBOX_BODY });
    const alice = createWallet();
    const bob = createWallet();
    const refused = await rejectedWith(() =>
      controller.send(sendEnv(alice, bob.account.did, "€".repeat(2000))),
    );
    expect(refused.getStatus()).toBe(413);
    expect(refused.getResponse()).toMatchObject({ ok: false, error: "tooLarge" });
    await expect(
      controller.send(sendEnv(alice, bob.account.did, "x".repeat(MAX_MAILBOX_BODY))),
    ).resolves.toMatchObject({ ok: true });
  });

  it("still answers 400 for a body that is not a string", async () => {
    const { controller } = setup();
    const alice = createWallet();
    const bob = createWallet();
    const env = signedEnv(alice, "mailbox.send", { to: bob.account.did, body: 42 });
    expect(await rejectStatus(controller.send(env))).toBe(400);
  });

  it("refuses a send from a game this server does not take, and one that names no game (403)", async () => {
    const { controller } = setup(undefined, undefined, [], ["other-game"]);
    const alice = createWallet();
    const bob = createWallet();
    expect(await rejectStatus(controller.send(sendEnv(alice, bob.account.did, "hi")))).toBe(403);

    const open = setup().controller;
    const gameless = signedEnv(
      alice,
      "mailbox.send",
      { to: bob.account.did, body: "hi" },
      undefined,
      null,
    );
    expect(await rejectStatus(open.send(gameless))).toBe(403);
    expect(await rejectStatus(open.fetch(fetchEnv(bob, null)))).toBe(403);
  });

  it("delivers mail only to reads made as the game that sent it", async () => {
    const { controller } = setup();
    const alice = createWallet();
    const bob = createWallet();
    await controller.send(sendEnv(alice, bob.account.did, "test-game mail"));

    expect((await controller.fetch(fetchEnv(bob, "other-game"))).messages).toEqual([]);
    const inbox = (await controller.fetch(fetchEnv(bob))).messages as MailboxMessage[];
    expect(inbox.map((m) => m.body)).toEqual(["test-game mail"]);
  });

  it("denies a blocked sender (403)", async () => {
    const alice = createWallet();
    process.env["BEACON_BLOCKLIST"] = alice.account.did; // read at SenderBlocklist construction
    const { controller } = setup();
    const bob = createWallet();
    expect(await rejectStatus(controller.send(sendEnv(alice, bob.account.did, "spam")))).toBe(403);
  });

  it("denies a revoked device on send, fetch and ack (403)", async () => {
    // A revoked phone still presents its owner's account DID and still passes `verifyOp`, so before
    // the shared gate it could send its owner's mail and read their inbox indefinitely. All three
    // ops, because a stolen phone reading the messages is as bad as it writing them.
    const alice = createWallet();
    const bob = createWallet();
    const { controller } = setup({}, makeClock(), [alice.device.did]);

    expect(await rejectStatus(controller.send(sendEnv(alice, bob.account.did, "spam")))).toBe(403);
    expect(await rejectStatus(controller.fetch(fetchEnv(alice)))).toBe(403);
    expect(await rejectStatus(controller.ack(ackEnv(alice, ["m1"])))).toBe(403);
  });

  it("does not resurrect an acked message on a replayed send (durable nonce log)", async () => {
    const { controller } = setup();
    const alice = createWallet();
    const bob = createWallet();
    const env = sendEnv(alice, bob.account.did, "ping");

    const { id } = await controller.send(env);
    await controller.ack(ackEnv(bob, [id])); // message row (and its nonce column) deleted
    expect((await controller.fetch(fetchEnv(bob))).messages).toEqual([]);

    // The original send envelope replayed within the window returns the same id and does NOT re-insert.
    const replay = await controller.send(env);
    expect(replay.id).toBe(id);
    expect((await controller.fetch(fetchEnv(bob))).messages).toEqual([]);
  });

  it("rejects a replayed fetch (409) — a captured read can't be re-served", async () => {
    const { controller } = setup();
    const bob = createWallet();
    const env = fetchEnv(bob);
    await controller.fetch(env); // first read records the nonce
    expect(await rejectStatus(controller.fetch(env))).toBe(409);
  });

  it("404s every route when the capability is disabled", async () => {
    const { controller } = setup({ enabled: false });
    const alice = createWallet();
    const bob = createWallet();
    expect(await rejectStatus(controller.send(sendEnv(alice, bob.account.did, "x")))).toBe(404);
    expect(await rejectStatus(controller.fetch(fetchEnv(bob)))).toBe(404);
  });
});

describe("MailboxController refusals and nonces", () => {
  it("names an unknown params key in `fields` on send, fetch and ack alike", async () => {
    const { controller } = setup();
    const alice = createWallet();
    const bob = createWallet();
    const extra = { newerField: true };
    for (const call of [
      () =>
        controller.send(
          signedEnv(alice, "mailbox.send", { to: bob.account.did, body: "x", ...extra }),
        ),
      () => controller.fetch(signedEnv(alice, "mailbox.fetch", extra)),
      () => controller.ack(signedEnv(alice, "mailbox.ack", { ids: [], ...extra })),
    ]) {
      const err = await rejectedWith(call);
      expect(err.getStatus()).toBe(400);
      expect(err.getResponse()).toMatchObject({
        ok: false,
        error: "invalid",
        fields: ["newerField"],
      });
    }
  });

  it("keeps each op's nonce its own: an ack reusing a send's nonce is applied, not answered with the send's id", async () => {
    const { controller } = setup();
    const alice = createWallet();
    const bob = createWallet();
    const nonce = ulid();
    await controller.send(sendEnv(alice, bob.account.did, "hello", nonce));
    const [message] = (await controller.fetch(fetchEnv(bob))).messages as MailboxMessage[];

    const acked = await controller.ack(
      signedEnv(bob, "mailbox.ack", { ids: [message!.id] }, nonce),
    );
    expect(acked).toEqual({ ok: true, deleted: 1 });
    // Retried, the same ack replays its own answer.
    expect(
      await controller.ack(signedEnv(bob, "mailbox.ack", { ids: [message!.id] }, nonce)),
    ).toEqual({ ok: true, deleted: 1 });
  });

  it("keeps each actor's nonce their own: a second sender reusing a nonce sends", async () => {
    const { controller } = setup();
    const alice = createWallet();
    const mallory = createWallet();
    const bob = createWallet();
    const nonce = ulid();
    const first = await controller.send(sendEnv(alice, bob.account.did, "from alice", nonce));
    const second = await controller.send(sendEnv(mallory, bob.account.did, "from mallory", nonce));

    expect(second.id).not.toBe(first.id);
    const inbox = (await controller.fetch(fetchEnv(bob))).messages as MailboxMessage[];
    expect(inbox.map((m) => m.body).sort()).toEqual(["from alice", "from mallory"]);
  });
});
