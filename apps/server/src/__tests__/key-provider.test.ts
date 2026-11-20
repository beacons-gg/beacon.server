import { accountFromMnemonic, createRecoveryPhrase } from "@beaconsgg/identity";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decryptMnemonic,
  EncryptedFileKeyProvider,
  encryptMnemonic,
  EnvKeyProvider,
  FileKeyProvider,
  resolveKeyProvider,
} from "../identity/key-provider";

/**
 * The `encrypted-file` key provider: a BIP39 phrase encrypted at rest (AES-256-GCM + scrypt),
 * unlocked by `BEACON_KEY_PASSPHRASE`. Wrong passphrase / tamper must fail loudly (GCM auth), the
 * same file always recovers the same account `did:key` (stable identity), and selection is inferred
 * from config.
 */

const PHRASE = createRecoveryPhrase();
const PASS = "correct horse battery staple";

describe("encryptMnemonic / decryptMnemonic", () => {
  it("round-trips a phrase without storing it in plaintext", () => {
    const enc = encryptMnemonic(PHRASE, PASS);
    expect(enc).not.toContain(PHRASE);
    expect(decryptMnemonic(enc, PASS)).toBe(PHRASE);
  });

  it("rejects a wrong passphrase (GCM authentication)", () => {
    const enc = encryptMnemonic(PHRASE, PASS);
    expect(() => decryptMnemonic(enc, "a different passphrase")).toThrow(/authentication failed/i);
  });

  it("rejects a tampered envelope", () => {
    const env = JSON.parse(encryptMnemonic(PHRASE, PASS)) as { ct: string };
    const ct = Buffer.from(env.ct, "base64");
    ct.writeUInt8(ct.readUInt8(0) ^ 0x01, 0); // flip a ciphertext bit
    env.ct = ct.toString("base64");
    expect(() => decryptMnemonic(JSON.stringify(env), PASS)).toThrow(/authentication failed/i);
  });

  it("rejects a too-short passphrase", () => {
    expect(() => encryptMnemonic(PHRASE, "short")).toThrow(/at least/i);
  });

  it("rejects a non-envelope key file", () => {
    expect(() => decryptMnemonic("not json", PASS)).toThrow(/encrypted envelope/i);
  });

  it("opens what the operator helper writes (it keeps its own copy of the v1 parameters)", () => {
    const script = resolve(__dirname, "../../scripts/encrypt-mnemonic.mjs");
    const enc = execFileSync(process.execPath, [script, PHRASE], {
      env: { ...process.env, BEACON_KEY_PASSPHRASE: PASS },
      encoding: "utf8",
    });
    expect(decryptMnemonic(enc, PASS)).toBe(PHRASE);
  });
});

describe("EncryptedFileKeyProvider", () => {
  let dir: string;
  let keyPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "beacon-enc-key-"));
    keyPath = join(dir, "server.key.enc");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("recovers the same account did across two loads (stable across restarts)", async () => {
    writeFileSync(keyPath, encryptMnemonic(PHRASE, PASS));
    const a = await new EncryptedFileKeyProvider(keyPath, PASS).loadAccount();
    const b = await new EncryptedFileKeyProvider(keyPath, PASS).loadAccount();
    expect(a.did).toBe(b.did);
    expect(a.did).toBe((await accountFromMnemonic(PHRASE)).did);
  });

  it("loads a key file anyone may read: the passphrase guards it, not the mode", async () => {
    // Deliberate, and depended on: an orchestrator that writes mounted files with default
    // permissions (a platform's file mounts, for instance) can only deliver the key this way. The
    // plaintext `file` provider is the one that refuses a readable file (server-identity.test.ts).
    writeFileSync(keyPath, encryptMnemonic(PHRASE, PASS));
    chmodSync(keyPath, 0o644);
    const account = await new EncryptedFileKeyProvider(keyPath, PASS).loadAccount();
    expect(account.did).toBe((await accountFromMnemonic(PHRASE)).did);
  });

  it.each([
    ["a cheaper N", { N: 1024 }],
    ["a p that would hang the boot", { p: 16_777_216 }],
    ["another r", { r: 1 }],
  ])("refuses an envelope whose scrypt parameters are not v1's: %s", async (_case, kdf) => {
    const envelope = JSON.parse(encryptMnemonic(PHRASE, PASS)) as { kdf: Record<string, unknown> };
    envelope.kdf = { ...envelope.kdf, ...kdf };
    writeFileSync(keyPath, JSON.stringify(envelope));
    await expect(new EncryptedFileKeyProvider(keyPath, PASS).loadAccount()).rejects.toThrow(
      /must use scrypt N=32768, r=8, p=1/,
    );
  });

  it("fails closed on a wrong passphrase", async () => {
    writeFileSync(keyPath, encryptMnemonic(PHRASE, PASS));
    await expect(
      new EncryptedFileKeyProvider(keyPath, "the wrong passphrase").loadAccount(),
    ).rejects.toThrow();
  });

  it("rejects an empty key file", async () => {
    writeFileSync(keyPath, "   \n");
    await expect(new EncryptedFileKeyProvider(keyPath, PASS).loadAccount()).rejects.toThrow(
      /empty/i,
    );
  });
});

describe("reading the recovery phrase back", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "beacon-phrase-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("gives the env mnemonic, trimmed", async () => {
    await expect(new EnvKeyProvider(`  ${PHRASE} \n`).recoveryPhrase()).resolves.toBe(PHRASE);
  });

  it("has none for an ephemeral env identity", async () => {
    await expect(new EnvKeyProvider(undefined).recoveryPhrase()).resolves.toBeUndefined();
  });

  it("reads a file's phrase with the same permission check as a boot", async () => {
    const keyPath = join(dir, "server.key");
    writeFileSync(keyPath, `${PHRASE}\n`, { mode: 0o600 });
    chmodSync(keyPath, 0o600);
    await expect(new FileKeyProvider(keyPath).recoveryPhrase()).resolves.toBe(PHRASE);
    chmodSync(keyPath, 0o644);
    await expect(new FileKeyProvider(keyPath).recoveryPhrase()).rejects.toThrow(/permissions/);
  });

  it("decrypts an encrypted file back to the phrase", async () => {
    const keyPath = join(dir, "server.key.enc");
    writeFileSync(keyPath, encryptMnemonic(PHRASE, PASS));
    await expect(new EncryptedFileKeyProvider(keyPath, PASS).recoveryPhrase()).resolves.toBe(
      PHRASE,
    );
  });
});

describe("resolveKeyProvider — encrypted-file selection", () => {
  it("infers encrypted-file when a key file AND passphrase are set", () => {
    expect(resolveKeyProvider({ keyFile: "/x", keyPassphrase: PASS }).kind).toBe("encrypted-file");
  });

  it("infers plain file when only a key file is set", () => {
    expect(resolveKeyProvider({ keyFile: "/x" }).kind).toBe("file");
  });

  it("explicit encrypted-file requires both the file and the passphrase", () => {
    expect(() => resolveKeyProvider({ keyProvider: "encrypted-file", keyFile: "/x" })).toThrow(
      /PASSPHRASE/,
    );
    expect(() =>
      resolveKeyProvider({ keyProvider: "encrypted-file", keyPassphrase: PASS }),
    ).toThrow(/KEY_FILE/);
  });
});
