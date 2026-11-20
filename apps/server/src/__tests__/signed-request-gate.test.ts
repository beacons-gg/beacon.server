import {
  authorizeDevice,
  buildProfile,
  createDevice,
  createWallet,
  signOpWithWallet,
  type Wallet,
} from "@beaconsgg/identity";
import { HttpStatus } from "@nestjs/common";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { SignedRequestGate } from "../common/signed-request-gate";
import { ProfilesService } from "../profiles/profiles.service";
import { rejectedWith, testBlocklist, testMemberList } from "./test-helpers";

/** A signed envelope from `wallet`'s device — which is what the revocation consult keys on. */
const env = (wallet: Wallet, op = "mailbox.send"): unknown =>
  signOpWithWallet(wallet, { op, nonce: ulid(), params: {} });

/**
 * The gate over a REAL profile registry, not a double: `isRevoked` only answers true once a
 * published, root-signed profile says so, and a test that faked that would not have caught the gap
 * this closes. `revoke` publishes v2 of the wallet's own profile listing its device as revoked,
 * which is exactly what the client does when a player revokes a lost phone.
 */
function gateWith(): {
  gate: SignedRequestGate;
  profiles: ProfilesService;
  revoke: (wallet: Wallet, version: number) => Promise<void>;
} {
  const profiles = new ProfilesService(testBlocklist()); // no store -> pure in-memory registry
  const gate = new SignedRequestGate(testBlocklist(), profiles, testMemberList());
  const revoke = async (wallet: Wallet, version: number): Promise<void> => {
    const devices = [{ did: wallet.device.did, auth: wallet.auth }];
    const revoked = version > 1 ? [wallet.device.did] : [];
    await profiles.publish(buildProfile(wallet.account, { version, devices, revoked }));
  };
  return { gate, profiles, revoke };
}

describe("SignedRequestGate — the envelope", () => {
  it("names a top-level key it does not know, on every signed route", async () => {
    const { gate } = gateWith();
    const newer = { ...(env(createWallet()) as Record<string, unknown>), region: "eu" };
    const err = await rejectedWith(() => gate.verify(newer, "mailbox.send"));
    expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(err.getResponse()).toMatchObject({ error: "invalid", fields: ["region"] });
    // The non-throwing form carries them too, for the WS gateway's ack.
    expect(gate.check(newer, "mailbox.send")).toMatchObject({ ok: false, fields: ["region"] });
  });
});

describe("SignedRequestGate — the two universal consults", () => {
  it("admits a verified request from an unblocked actor on a live device", () => {
    const wallet = createWallet();
    const { gate } = gateWith();
    expect(gate.verify(env(wallet), "mailbox.send").actor).toBe(wallet.account.did);
  });

  it("refuses a revoked device with 403 deviceRevoked, its own code", async () => {
    // The gap this closes. A revoked device still presents its owner's account DID and still passes
    // `verifyOp`, because the device authorization is root-signed and stays valid forever. Before
    // this gate, nothing on the mailbox, media, places-proposal or admin paths asked.
    const wallet = createWallet();
    const { gate, revoke } = gateWith();
    await revoke(wallet, 1);
    expect(gate.verify(env(wallet), "mailbox.send").actor).toBe(wallet.account.did);

    await revoke(wallet, 2);
    const err = await rejectedWith(() => gate.verify(env(wallet), "mailbox.send"));
    expect(err.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(err.getResponse()).toEqual({
      ok: false,
      error: "deviceRevoked",
      message: "device revoked",
    });
  });

  it("leaves the owner's OTHER device alone — the same account, still writing", async () => {
    // Revocation is per device, which is the whole promise: "the account and all history survive;
    // only that device is cut off" (beacon.core `doc/spec/identity.md` §10). So the surviving
    // device has to be a second device on the SAME account. A second *wallet* would pass on the
    // strength of `isRevoked` answering false for an account with no profile on file, which is a
    // different guarantee.
    const account = createWallet().account;
    const lost = createDevice();
    const kept = createDevice();
    const lostAuth = authorizeDevice(account, lost.did);
    const keptAuth = authorizeDevice(account, kept.did);
    const devices = [
      { did: lost.did, auth: lostAuth },
      { did: kept.did, auth: keptAuth },
    ];

    const profiles = new ProfilesService(testBlocklist());
    const gate = new SignedRequestGate(testBlocklist(), profiles, testMemberList());
    await profiles.publish(buildProfile(account, { version: 1, devices }));
    await profiles.publish(buildProfile(account, { version: 2, devices, revoked: [lost.did] }));

    const lostPhone: Wallet = { account, device: lost, auth: lostAuth };
    const keptLaptop: Wallet = { account, device: kept, auth: keptAuth };
    const err = await rejectedWith(() => gate.verify(env(lostPhone), "mailbox.send"));
    expect(err.getResponse()).toMatchObject({ message: "device revoked" });
    // Same account DID, same profile, still admitted.
    expect(gate.verify(env(keptLaptop), "mailbox.send").actor).toBe(account.did);
  });

  it("tests the block first, so a blocked actor learns nothing about the device state", async () => {
    // Not for the lookup it saves — that is a Map read against an Ed25519 verify already paid. Both
    // refusals are 403 `denied`, so the MESSAGE is the only difference on the wire, and which one
    // comes back is what tells an operator which of their two lists to go and look at.
    const wallet = createWallet();
    let asked = 0;
    const gate = new SignedRequestGate(
      testBlocklist([wallet.account.did]),
      {
        isRevoked: () => {
          asked += 1;
          return true;
        },
      },
      testMemberList(),
    );

    const err = await rejectedWith(() => gate.verify(env(wallet), "mailbox.send"));
    expect(err.getResponse()).toMatchObject({ message: "sender is blocked" });
    expect(asked).toBe(0);
  });

  it("re-asks every request, so re-authorizing a device restores it without a fresh envelope", async () => {
    // The consult is per request and never memoized under the nonce, matching every other consult
    // on this surface. An owner who recovers a phone they revoked gets it working again on the next
    // attempt rather than after some cache expires.
    const wallet = createWallet();
    const { gate, profiles, revoke } = gateWith();
    await revoke(wallet, 2);
    const captured = env(wallet);
    await rejectedWith(() => gate.verify(captured, "mailbox.send"));

    await profiles.publish(
      buildProfile(wallet.account, {
        version: 3,
        devices: [{ did: wallet.device.did, auth: wallet.auth }],
        revoked: [],
      }),
    );
    expect(gate.verify(captured, "mailbox.send").actor).toBe(wallet.account.did);
  });

  it("still refuses a bad signature and a wrong op name, ahead of either consult", async () => {
    const wallet = createWallet();
    const { gate } = gateWith();
    expect((await rejectedWith(() => gate.verify(env(wallet), "mailbox.ack"))).getStatus()).toBe(
      HttpStatus.BAD_REQUEST,
    );
    const tampered = {
      ...(env(wallet) as Record<string, unknown>),
      actor: createWallet().account.did,
    };
    expect((await rejectedWith(() => gate.verify(tampered, "mailbox.send"))).getStatus()).toBe(
      HttpStatus.UNAUTHORIZED,
    );
  });
});
