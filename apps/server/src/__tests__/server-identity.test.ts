import { accountFromMnemonic, createRecoveryPhrase, verifyDescriptor } from "@beaconsgg/identity";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EnvKeyProvider,
  FileKeyProvider,
  encryptMnemonic,
  resolveKeyProvider,
} from "../identity/key-provider";
import { ServerIdentity } from "../server-identity";
import { testConfig } from "./test-config";

/**
 * The server's key (beacon.core `doc/spec/identity.md` §11): the signing key is sourced behind a
 * provider seam; identity is **stable across restarts** for env + file providers; the file provider
 * **refuses insecure permissions**; a **rotation** produces a valid re-signed descriptor under a
 * stable account.
 */

/** Build a ServerIdentity from an env with a given process env, then run its boot hook. */
async function bootedIdentity(env: NodeJS.ProcessEnv): Promise<ServerIdentity> {
  const prev = process.env;
  process.env = { ...env };
  try {
    // The boot snapshot is the right config here: these cases are about what the *environment*
    // produces (key provider, descriptor facts), not about an admin editing one afterwards.
    const id = new ServerIdentity(testConfig(process.env));
    await id.onModuleInit();
    return id;
  } finally {
    process.env = prev;
  }
}

describe("a key brought by a restore", () => {
  const PASSPHRASE = "a passphrase long enough";

  it("is used in place of the provider the environment names, and backs up as itself", async () => {
    const restored = createRecoveryPhrase();
    const own = createRecoveryPhrase();
    const config = testConfig({
      BEACON_MNEMONIC: own,
      BEACON_KEY_PASSPHRASE: PASSPHRASE,
    } as NodeJS.ProcessEnv);
    const id = new ServerIdentity(config, {
      host: "old.test",
      keyEnvelope: encryptMnemonic(restored, PASSPHRASE),
    });
    await id.onModuleInit();
    expect(id.account.did).toBe(accountFromMnemonic(restored).did);
    expect(await id.recoveryPhrase()).toBe(restored);
  });

  it("refuses to boot on the wrong passphrase rather than falling back", async () => {
    const config = testConfig({
      BEACON_MNEMONIC: createRecoveryPhrase(),
      BEACON_KEY_PASSPHRASE: "another passphrase entirely",
    } as NodeJS.ProcessEnv);
    const id = new ServerIdentity(config, {
      host: "old.test",
      keyEnvelope: encryptMnemonic(createRecoveryPhrase(), PASSPHRASE),
    });
    await expect(id.onModuleInit()).rejects.toThrow(/authentication failed/);
  });

  it("uses the environment's provider when the restore brought no key", async () => {
    const own = createRecoveryPhrase();
    const id = new ServerIdentity(testConfig({ BEACON_MNEMONIC: own } as NodeJS.ProcessEnv), {
      host: "old.test",
      keyEnvelope: null,
    });
    await id.onModuleInit();
    expect(id.account.did).toBe(accountFromMnemonic(own).did);
  });
});

describe("EnvKeyProvider", () => {
  it("recovers the same account did from the same mnemonic (stable across restarts)", async () => {
    const mnemonic = createRecoveryPhrase();
    const a = await new EnvKeyProvider(mnemonic).loadAccount();
    const b = await new EnvKeyProvider(mnemonic).loadAccount();
    expect(a.did).toBe(b.did);
  });

  it("mints an ephemeral (different) account when no mnemonic is set (dev)", async () => {
    const a = await new EnvKeyProvider(undefined).loadAccount();
    const b = await new EnvKeyProvider(undefined).loadAccount();
    expect(a.did).not.toBe(b.did);
  });

  it("throws (fail-closed) on a present-but-invalid mnemonic instead of minting a fresh one", async () => {
    await expect(new EnvKeyProvider("not a valid bip39 phrase").loadAccount()).rejects.toThrow();
  });
});

describe("FileKeyProvider", () => {
  let dir: string;
  let keyPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "beacon-key-"));
    keyPath = join(dir, "server.key");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("recovers the same account did across two loads (stable across restarts)", async () => {
    writeFileSync(keyPath, `${createRecoveryPhrase()}\n`, { mode: 0o600 });
    chmodSync(keyPath, 0o600);
    const a = await new FileKeyProvider(keyPath).loadAccount();
    const b = await new FileKeyProvider(keyPath).loadAccount();
    expect(a.did).toBe(b.did);
  });

  it("refuses a world/group-readable key file (strict-permissions check)", async () => {
    writeFileSync(keyPath, createRecoveryPhrase(), { mode: 0o644 });
    chmodSync(keyPath, 0o644); // rw-r--r-- — group/world can read
    await expect(new FileKeyProvider(keyPath).loadAccount()).rejects.toThrow(/permissions|chmod/i);
  });

  it("accepts an owner-only (0600) key file", async () => {
    writeFileSync(keyPath, createRecoveryPhrase(), { mode: 0o600 });
    chmodSync(keyPath, 0o600);
    await expect(new FileKeyProvider(keyPath).loadAccount()).resolves.toBeDefined();
  });

  it("throws on an empty key file", async () => {
    writeFileSync(keyPath, "   \n", { mode: 0o600 });
    chmodSync(keyPath, 0o600);
    await expect(new FileKeyProvider(keyPath).loadAccount()).rejects.toThrow(/empty/i);
  });
});

describe("resolveKeyProvider (selection)", () => {
  it("defaults to the env provider (dev)", () => {
    expect(resolveKeyProvider({}).kind).toBe("env");
  });
  it("infers the file provider when a key file is set", () => {
    expect(resolveKeyProvider({ keyFile: "/x" }).kind).toBe("file");
  });
  it("honors an explicit BEACON_KEY_PROVIDER=env even with a key file present", () => {
    expect(resolveKeyProvider({ keyProvider: "env", keyFile: "/x" }).kind).toBe("env");
  });
  it("fails closed when file is selected with no key file", () => {
    expect(() => resolveKeyProvider({ keyProvider: "file" })).toThrow(/BEACON_KEY_FILE/);
  });
  it("throws for the not-yet-implemented kms seam", () => {
    expect(() => resolveKeyProvider({ keyProvider: "kms" })).toThrow(/seam|implemented/i);
  });
  it("throws for an unknown provider", () => {
    expect(() => resolveKeyProvider({ keyProvider: "wat" })).toThrow(/unknown/i);
  });
});

describe("ServerIdentity", () => {
  it("is stable across two constructions from the same mnemonic", async () => {
    const mnemonic = createRecoveryPhrase();
    const a = await bootedIdentity({ BEACON_MNEMONIC: mnemonic, BEACON_HOST: "beacon.test" });
    const b = await bootedIdentity({ BEACON_MNEMONIC: mnemonic, BEACON_HOST: "beacon.test" });
    expect(a.account.did).toBe(b.account.did);
    // Two boots produce the same advertised descriptor identity (proof.key === account did).
    const da = a.descriptor("2026-06-30T00:00:00Z");
    const db = b.descriptor("2026-06-30T00:00:00Z");
    expect(da.proof.key).toBe(db.proof.key);
    expect(da.proof.sig).toBe(db.proof.sig); // canonical body + same root => identical signature
    expect(verifyDescriptor(da)).toBe(true);
  });

  it("is stable across two constructions from the same key file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beacon-key-"));
    const keyPath = join(dir, "server.key");
    try {
      writeFileSync(keyPath, createRecoveryPhrase(), { mode: 0o600 });
      chmodSync(keyPath, 0o600);
      const a = await bootedIdentity({ BEACON_KEY_FILE: keyPath, BEACON_HOST: "beacon.test" });
      const b = await bootedIdentity({ BEACON_KEY_FILE: keyPath, BEACON_HOST: "beacon.test" });
      expect(a.account.did).toBe(b.account.did);
      expect(verifyDescriptor(a.descriptor("2026-06-30T00:00:00Z"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads its recovery phrase back, undefined when ephemeral", async () => {
    const mnemonic = createRecoveryPhrase();
    const stable = await bootedIdentity({ BEACON_MNEMONIC: mnemonic });
    await expect(stable.recoveryPhrase()).resolves.toBe(mnemonic);
    const ephemeral = await bootedIdentity({});
    await expect(ephemeral.recoveryPhrase()).resolves.toBeUndefined();
  });

  it("refuses a phrase that is no longer the running identity's", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beacon-key-"));
    const keyPath = join(dir, "server.key");
    try {
      writeFileSync(keyPath, createRecoveryPhrase(), { mode: 0o600 });
      chmodSync(keyPath, 0o600);
      const id = await bootedIdentity({ BEACON_KEY_FILE: keyPath });
      writeFileSync(keyPath, createRecoveryPhrase(), { mode: 0o600 });
      await expect(id.recoveryPhrase()).rejects.toThrow(/changed since boot/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("signs a descriptor the package verifier accepts", async () => {
    const id = await bootedIdentity({ BEACON_MNEMONIC: createRecoveryPhrase() });
    expect(verifyDescriptor(id.descriptor("2026-06-30T00:00:00Z"))).toBe(true);
  });

  it("rotation keeps the account did stable, rotates the device key, and re-signs a valid descriptor", async () => {
    const id = await bootedIdentity({
      BEACON_MNEMONIC: createRecoveryPhrase(),
      BEACON_HOST: "beacon.test",
    });
    const accountBefore = id.account.did;
    const deviceBefore = id.device.did;

    const rotated = id.rotateSigningKey("2026-07-01T00:00:00Z");

    // Account (advertised) identity is unchanged — a rotation, not a migration.
    expect(id.account.did).toBe(accountBefore);
    expect(rotated.proof.key).toBe(accountBefore);
    // The device/signing key actually changed, and its new authorization is under the same account.
    expect(id.device.did).not.toBe(deviceBefore);
    expect(id.auth.authorizes).toBe(id.device.did);
    expect(id.auth.account).toBe(accountBefore);
    // The re-signed descriptor verifies.
    expect(verifyDescriptor(rotated)).toBe(true);
  });
});
