import { accountFromMnemonic, createAccount, type Account } from "@beaconsgg/identity";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";

/**
 * Secure signing-key storage behind a provider seam (beacon.core `doc/spec/identity.md` §11).
 *
 * The server holds its own **account keypair** (the same account-root + device-key model clients
 * use, beacon.core `doc/spec/identity.md` §11). Its `did:key` is the server's stable identity: it
 * signs the coverage descriptor (beacon.core `doc/spec/discovery.md` §3.2) and, in future,
 * spawn-pool provenance / its own profile. Because a server descriptor is *self-signed by its
 * advertised key* (`verifyDescriptor` requires `proof.key === body.key`), the advertised identity
 * IS the account root — so the root must be **stable across restarts** and **securely stored**, not
 * an ephemeral dev mnemonic.
 *
 * A {@link ServerKeyProvider} is the single seam that key sourcing lands behind. `ServerIdentity`
 * asks the provider for the account root once at boot; the provider decides where the material comes
 * from. This lets local/self-hosted deployments back the key with a permission-checked file and lets
 * a managed deployment plug a cloud secret manager / KMS (see {@link ServerKeyProvider} docs) — all
 * without touching identity or descriptor code.
 */
export interface ServerKeyProvider {
  /** A short label for logs/diagnostics (`env` / `file` / `kms:aws` …). */
  readonly kind: string;

  /**
   * Load the server's **account root** — its durable, self-sovereign identity. Called once at boot.
   * The returned account's `did` must be **stable across process restarts** for any non-ephemeral
   * provider (a file/secret-backed root always recovers the same `did:key`).
   *
   * Rejects (fail-closed) rather than silently minting a fresh identity when configured material is
   * present but unusable (bad file permissions, malformed key, unreachable secret store) — a server
   * that quietly changes identity would invalidate every descriptor a client has pinned.
   */
  loadAccount(): Promise<Account>;

  /**
   * The server's BIP39 recovery phrase, or undefined when it has none (an ephemeral identity). A
   * backup writes it as `identity.key`, so a restored server is the same server. Read fresh each
   * call rather than remembered, so the secret only sits in memory for the run that asked.
   */
  recoveryPhrase(): Promise<string | undefined>;
}

// ── env provider (dev default) ─────────────────────────────────────────────

/**
 * Sources the account root from a `BEACON_MNEMONIC` BIP39 phrase — the **dev default**. With no
 * mnemonic it mints an **ephemeral** account (identity changes every restart): fine for local dev
 * and tests, never for a deployment clients discover. Keep the mnemonic out of source control; it is
 * a secret equivalent to the private key.
 */
export class EnvKeyProvider implements ServerKeyProvider {
  readonly kind = "env";
  constructor(private readonly mnemonic: string | undefined) {}

  // `async` so a present-but-invalid phrase surfaces as a rejected promise (fail-closed), not a
  // synchronous throw — a caller `await`s the provider and expects errors on that path.
  async loadAccount(): Promise<Account> {
    return this.mnemonic ? accountFromMnemonic(this.mnemonic) : createAccount();
  }

  recoveryPhrase(): Promise<string | undefined> {
    return Promise.resolve(this.mnemonic?.trim() || undefined);
  }
}

// ── file provider (local / self-hosted prod) ───────────────────────────────

/**
 * The maximal file mode we accept for a key file: owner read/write only (`0600`), or owner
 * read/write + execute (`0700`). ANY group or world bit set is refused — a signing key readable by
 * other local users is a leak. We check the low 9 permission bits (`& 0o777`) and reject if any bit
 * outside the owner triad (`0o077`) is set.
 */
const OWNER_ONLY_MASK = 0o077;

/**
 * Sources the account root from a key file at `BEACON_KEY_FILE` — the **local / self-hosted prod**
 * story. The file holds a BIP39 recovery phrase (its whole trimmed contents), so the same file always
 * recovers the same account `did:key` (stable identity across restarts).
 *
 * **Strict-permissions check (fail-closed):** before reading, we refuse a file with any group/world
 * permission bit set (i.e. anything looser than `0600`/`0700`) — a world- or group-readable signing
 * key is a leak, and silently trusting it would defeat the point of "secure storage". Mount the key
 * `chmod 600` and owned by the server user. (Skipped only on platforms without POSIX mode bits.)
 */
export class FileKeyProvider implements ServerKeyProvider {
  readonly kind = "file";
  constructor(private readonly path: string) {}

  async loadAccount(): Promise<Account> {
    // `accountFromMnemonic` validates the BIP39 checksum and throws on a malformed phrase.
    return accountFromMnemonic(await this.recoveryPhrase());
  }

  async recoveryPhrase(): Promise<string> {
    assertOwnerOnlyPermissions(this.path);
    const phrase = (await readFile(this.path, "utf8")).trim();
    if (phrase === "") {
      throw new Error(`FileKeyProvider: key file is empty: ${this.path}`);
    }
    return phrase;
  }
}

/**
 * Refuse a key file whose permissions let anyone but the owner read it. Throws with an actionable
 * message pointing at `chmod 600`. On a platform where `mode` carries no POSIX bits (e.g. Windows,
 * `mode & 0o777 === 0`) the check is a no-op — there's nothing meaningful to enforce.
 */
export function assertOwnerOnlyPermissions(path: string): void {
  const mode = statSync(path).mode & 0o777;
  if (mode === 0) return; // no POSIX permission bits on this platform — nothing to enforce
  if ((mode & OWNER_ONLY_MASK) !== 0) {
    const octal = mode.toString(8).padStart(3, "0");
    throw new Error(
      `FileKeyProvider: refusing key file with insecure permissions ${octal} (${path}); ` +
        `a signing key must not be group/world-readable — run \`chmod 600 ${path}\``,
    );
  }
}

// ── encrypted-file provider (self-hosted prod, key encrypted at rest) ───────

/** scrypt KDF parameters (envelope v1). ~33 MB at N=2^15,r=8 — comfortably under `maxmem`. */
const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1 } as const;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
export const MIN_PASSPHRASE_LEN = 8;

/** Self-describing encrypted-key envelope (JSON, base64 fields) — see {@link encryptMnemonic}. */
interface EncryptedEnvelope {
  v: number;
  kdf: { name: string; N: number; r: number; p: number };
  salt: string;
  iv: string;
  tag: string;
  ct: string;
}

function assertPassphrase(passphrase: string): void {
  if (passphrase.length < MIN_PASSPHRASE_LEN) {
    throw new Error(
      `EncryptedFileKeyProvider: BEACON_KEY_PASSPHRASE must be at least ${MIN_PASSPHRASE_LEN} characters`,
    );
  }
}

/**
 * Encrypt a BIP39 phrase into the envelope a `BEACON_KEY_FILE` holds when
 * `BEACON_KEY_PROVIDER=encrypted-file`: AES-256-GCM with an scrypt-derived key. The JSON carries the
 * KDF params + salt + iv + auth tag, so decryption needs only the passphrase. The operator helper
 * `scripts/encrypt-mnemonic.mjs` writes exactly this format.
 */
export function encryptMnemonic(phrase: string, passphrase: string): string {
  assertPassphrase(passphrase);
  const salt = randomBytes(16);
  const key = scryptSync(passphrase, salt, 32, { ...SCRYPT_PARAMS, maxmem: SCRYPT_MAXMEM });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(phrase.trim(), "utf8"), cipher.final()]);
  const envelope: EncryptedEnvelope = {
    v: 1,
    kdf: { name: "scrypt", ...SCRYPT_PARAMS },
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
  };
  return JSON.stringify(envelope);
}

/**
 * Decrypt an {@link encryptMnemonic} envelope back to the BIP39 phrase. GCM authentication means a
 * wrong passphrase or a tampered file **fails loudly** (rejected) — never a silently-wrong key.
 */
export function decryptMnemonic(content: string, passphrase: string): string {
  assertPassphrase(passphrase);
  let env: EncryptedEnvelope;
  try {
    env = JSON.parse(content) as EncryptedEnvelope;
  } catch {
    throw new Error("decryptMnemonic: key file is not a valid encrypted envelope (expected JSON)");
  }
  if (env?.v !== 1 || env.kdf?.name !== "scrypt") {
    throw new Error("decryptMnemonic: unsupported key envelope (expected v1 scrypt / aes-256-gcm)");
  }
  // v1 has one set of scrypt parameters, and the file's own are held to it: taken on trust, a file
  // with a huge `p` hangs the boot, and one with a tiny `N` makes the passphrase cheap to guess,
  // which matters most for a file others can read.
  const { N, r, p } = env.kdf;
  if (N !== SCRYPT_PARAMS.N || r !== SCRYPT_PARAMS.r || p !== SCRYPT_PARAMS.p) {
    throw new Error(
      `decryptMnemonic: key envelope v1 must use scrypt N=${SCRYPT_PARAMS.N}, r=${SCRYPT_PARAMS.r}, p=${SCRYPT_PARAMS.p}; ` +
        `this one says N=${N}, r=${r}, p=${p}. Re-create it with scripts/encrypt-mnemonic.mjs.`,
    );
  }
  const key = scryptSync(passphrase, Buffer.from(env.salt, "base64"), 32, {
    ...SCRYPT_PARAMS,
    maxmem: SCRYPT_MAXMEM,
  });
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(env.iv, "base64"));
  decipher.setAuthTag(Buffer.from(env.tag, "base64"));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(env.ct, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error(
      "decryptMnemonic: authentication failed — wrong BEACON_KEY_PASSPHRASE or corrupted key file",
    );
  }
}

/**
 * Sources the account root from an **encrypted** key file (`BEACON_KEY_FILE`) unlocked with
 * `BEACON_KEY_PASSPHRASE`. Unlike {@link FileKeyProvider} (plaintext phrase → demands `chmod 600`),
 * the material here is encrypted at rest (AES-256-GCM), so security rests on the **passphrase**, not
 * the file's permissions — the passphrase should come from the orchestrator's secret env, never
 * source control. Its mode is deliberately not checked (pinned in key-provider.test.ts). Create the
 * file with `scripts/encrypt-mnemonic.mjs`. Same phrase → same account `did:key` across restarts
 * (stable identity).
 */
export class EncryptedFileKeyProvider implements ServerKeyProvider {
  readonly kind = "encrypted-file";
  constructor(
    private readonly path: string,
    private readonly passphrase: string,
  ) {}

  async loadAccount(): Promise<Account> {
    return accountFromMnemonic(await this.recoveryPhrase());
  }

  async recoveryPhrase(): Promise<string> {
    const content = (await readFile(this.path, "utf8")).trim();
    if (content === "") {
      throw new Error(`EncryptedFileKeyProvider: key file is empty: ${this.path}`);
    }
    return decryptMnemonic(content, this.passphrase);
  }
}

/**
 * Sources the account root from the key a restore brought (`0028_restored_identity`): the backup's
 * phrase, in the same envelope as {@link EncryptedFileKeyProvider}, kept in the database because a
 * hosted server's key file is a read-only mount its restore cannot replace.
 */
export class RestoredKeyProvider implements ServerKeyProvider {
  readonly kind = "restored";
  constructor(
    private readonly envelope: string,
    private readonly passphrase: string,
  ) {}

  loadAccount(): Promise<Account> {
    return this.recoveryPhrase().then(accountFromMnemonic);
  }

  recoveryPhrase(): Promise<string> {
    return Promise.resolve().then(() => decryptMnemonic(this.envelope, this.passphrase));
  }
}

// ── cloud secret manager / KMS seam (NOT implemented — the production plug point) ──

/**
 * TODO: a cloud secret manager / KMS-backed provider.
 *
 * This is the **seam, not an implementation** — the interface a managed deployment plugs into so the
 * account root never lives on the container filesystem. Two shapes fit under {@link ServerKeyProvider}
 * without any change to identity/descriptor code:
 *
 *  1. **Secret manager holds the recovery phrase / seed.** Fetch the BIP39 phrase (or raw seed) from
 *     AWS Secrets Manager / GCP Secret Manager / HashiCorp Vault at boot, then `accountFromMnemonic`
 *     (or `keyPairFromSeed`) exactly like {@link FileKeyProvider}. Simplest; the private key still
 *     transits process memory. Select via e.g. `BEACON_KEY_PROVIDER=kms` + a `BEACON_KEY_SECRET_ID`.
 *
 *  2. **KMS holds the private key and signs (never exports it).** The stronger story: the key stays
 *     in the HSM/KMS and the server calls a `sign(bytes)` API. This does NOT fit `loadAccount()` as-is
 *     — Ed25519 signing would move behind a `signUtf8`-shaped async seam, and `@beaconsgg/identity`'s
 *     `signDescriptor` (which takes a raw private key) would need a signer-injection variant. That is
 *     a deliberate follow-up: this seam gets the config/selection plumbing in place first.
 *
 * To implement (1): add a class here (e.g. `KmsKeyProvider`) that reads the secret via the cloud
 * SDK and returns `accountFromMnemonic(phrase)`, wire it into {@link resolveKeyProvider}, add its
 * env to config and `doc/deploy.md`, and add the SDK as a server dependency. No real cloud client
 * ships yet; `doc/deploy.md` ("Signing-key management") covers the providers that do.
 */

// ── selection ──────────────────────────────────────────────────────────────

/** The config slice {@link resolveKeyProvider} reads (a subset of `ServerConfig`). */
export interface KeyProviderConfig {
  /**
   * Explicit selector: `"env"` | `"file"` | `"encrypted-file"`. Absent → inferred: `encrypted-file`
   * if a key file **and** passphrase are set, else `file` if a key file is set, else `env`.
   */
  keyProvider?: string | undefined;
  /** `BEACON_MNEMONIC` — the env provider's phrase. */
  mnemonic?: string | undefined;
  /** `BEACON_KEY_FILE` — the (plaintext or encrypted) key-file path. */
  keyFile?: string | undefined;
  /** `BEACON_KEY_PASSPHRASE` — unlocks an encrypted key file (`encrypted-file` provider). */
  keyPassphrase?: string | undefined;
}

/**
 * Pick the {@link ServerKeyProvider} from config. Selection:
 *
 * - `encrypted-file` (or unset with a key file **and** passphrase) → {@link EncryptedFileKeyProvider}.
 * - `file` (or unset with a key file, no passphrase) → {@link FileKeyProvider}.
 * - `env` (or unset with no key file) → {@link EnvKeyProvider} (dev default).
 * - `kms` → not implemented yet; throws pointing at the seam above.
 *
 * Fail-closed: an explicit `file` / `encrypted-file` selection missing its `BEACON_KEY_FILE` (or, for
 * encrypted, `BEACON_KEY_PASSPHRASE`) throws rather than falling back to an ephemeral identity.
 */
export function resolveKeyProvider(config: KeyProviderConfig): ServerKeyProvider {
  const explicit = config.keyProvider?.trim().toLowerCase();
  const selected =
    explicit && explicit !== ""
      ? explicit
      : config.keyFile
        ? config.keyPassphrase
          ? "encrypted-file"
          : "file"
        : "env";

  switch (selected) {
    case "env":
      return new EnvKeyProvider(config.mnemonic);
    case "file":
      if (!config.keyFile) {
        throw new Error(
          "resolveKeyProvider: BEACON_KEY_PROVIDER=file requires BEACON_KEY_FILE (path to the key file)",
        );
      }
      return new FileKeyProvider(config.keyFile);
    case "encrypted-file":
      if (!config.keyFile) {
        throw new Error(
          "resolveKeyProvider: BEACON_KEY_PROVIDER=encrypted-file requires BEACON_KEY_FILE",
        );
      }
      if (!config.keyPassphrase) {
        throw new Error(
          "resolveKeyProvider: BEACON_KEY_PROVIDER=encrypted-file requires BEACON_KEY_PASSPHRASE",
        );
      }
      return new EncryptedFileKeyProvider(config.keyFile, config.keyPassphrase);
    case "kms":
      throw new Error(
        "resolveKeyProvider: the KMS/secret-manager provider is a documented seam, not implemented " +
          "yet; see apps/server/src/identity/key-provider.ts and doc/deploy.md",
      );
    default:
      throw new Error(
        `resolveKeyProvider: unknown BEACON_KEY_PROVIDER=${JSON.stringify(selected)} (expected env|file|encrypted-file)`,
      );
  }
}
