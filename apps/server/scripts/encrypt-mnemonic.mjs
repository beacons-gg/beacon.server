// Operator helper: encrypt a BIP39 recovery phrase into the envelope the server's `encrypted-file`
// key provider reads (BEACON_KEY_PROVIDER=encrypted-file + BEACON_KEY_FILE + BEACON_KEY_PASSPHRASE).
// The format MUST match EncryptedFileKeyProvider in src/identity/key-provider.ts
// (AES-256-GCM, scrypt N=32768/r=8/p=1, base64 JSON envelope).
//
//   BEACON_KEY_PASSPHRASE=... node scripts/encrypt-mnemonic.mjs "twelve word phrase ..." > server.key.enc
//   chmod 600 server.key.enc   # defence in depth; the passphrase is the real protection
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";

const phrase = process.argv[2]?.trim();
const passphrase = process.env.BEACON_KEY_PASSPHRASE;

if (!phrase) {
  console.error(
    "usage: BEACON_KEY_PASSPHRASE=<pass> node scripts/encrypt-mnemonic.mjs <bip39 phrase> > server.key.enc",
  );
  process.exit(1);
}
if (!passphrase || passphrase.length < 8) {
  console.error("BEACON_KEY_PASSPHRASE must be set and at least 8 characters");
  process.exit(1);
}

const N = 32768;
const r = 8;
const p = 1;
const salt = randomBytes(16);
const key = scryptSync(passphrase, salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 });
const iv = randomBytes(12);
const cipher = createCipheriv("aes-256-gcm", key, iv);
const ct = Buffer.concat([cipher.update(phrase, "utf8"), cipher.final()]);

const envelope = {
  v: 1,
  kdf: { name: "scrypt", N, r, p },
  salt: salt.toString("base64"),
  iv: iv.toString("base64"),
  tag: cipher.getAuthTag().toString("base64"),
  ct: ct.toString("base64"),
};

process.stdout.write(`${JSON.stringify(envelope)}\n`);
