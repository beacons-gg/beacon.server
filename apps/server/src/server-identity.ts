import {
  accountFromMnemonic,
  authorizeDevice,
  createDevice,
  signDescriptor,
  type Account,
  type Device,
} from "@beaconsgg/identity";
import type { DeviceAuthorization, ServerDescriptor } from "@beaconsgg/protocol-types";
import { Inject, Injectable, Logger, Optional, type OnModuleInit } from "@nestjs/common";
import type { ServerConfig } from "./config";
import { RESTORED_IDENTITY, SERVER_CONFIG } from "./settings/live-config";
import {
  RestoredKeyProvider,
  resolveKeyProvider,
  type ServerKeyProvider,
} from "./identity/key-provider";
import type { RestoredIdentity } from "./stores/restored-identity";

/**
 * The process start time, captured once at module load via `process.uptime()` (which measures from
 * process start regardless of when it's read). **Process-wide** — every `ServerIdentity` instance and
 * descriptor build in this process advertises the same `startedAt` (reading `process.uptime()` later
 * would drift). Advertised as a timestamp so clients derive live uptime (now − startedAt) rather than a
 * duration frozen into a cached descriptor.
 */
export const PROCESS_STARTED_AT = new Date(
  Date.now() - Math.round(process.uptime() * 1000),
).toISOString();

/**
 * The unsigned descriptor facts — the ONE mapping from config to what this server says about
 * itself. Both the signed {@link ServerIdentity.descriptor} and the admin `status` read render
 * from it, so the two can never drift.
 */
export type DescriptorFacts = Omit<ServerDescriptor, "updated" | "proof"> & {
  /** Always set server-side (config has a default) — optional only on the wire. */
  name: string;
};

/**
 * The server's own identity (beacon.core `doc/spec/identity.md` §11) — a `did:key` it signs its
 * coverage descriptor with, following the **same account-root + device-key model** clients use.
 *
 * **Key sourcing behind a provider seam.** The stable **account root** comes from a {@link
 * ServerKeyProvider} selected by config (env mnemonic for dev, a permission-checked key file for
 * self-hosted prod, a documented KMS seam for managed prod) — not a hard-coded dev mnemonic. The
 * account `did:key` stays **stable across restarts** for the env (with `BEACON_MNEMONIC`) and file
 * providers, so a descriptor a client has pinned keeps verifying. See `identity/key-provider.ts`.
 *
 * **Rotation model (mirrors the client, beacon.core `doc/spec/identity.md` §5 and §10).**
 * - The **account root** is the durable identity. It signs the descriptor (a server descriptor is
 *   self-signed by its advertised `key`, so the advertised identity *is* the root). Rotating the root
 *   changes `did:key` → that's a **migration**, not a rotation (documented; not done here).
 * - A **device/signing key** is authorized by the root ({@link authorizeDevice}) and is what rotates.
 *   {@link rotateSigningKey} mints a fresh device + a fresh root-signed authorization under the *same*
 *   account and re-signs the descriptor — identity is unchanged, the operational key is fresh. This is
 *   the seam a periodic rotation or a suspected-device-compromise response drives; today the device
 *   key backs spawn-pool/profile signing paths as they land (the descriptor stays root-signed by the
 *   package contract).
 */
@Injectable()
export class ServerIdentity implements OnModuleInit {
  private readonly logger = new Logger(ServerIdentity.name);
  readonly config: ServerConfig;
  private readonly provider: ServerKeyProvider;

  /** The stable account root (self-sovereign identity). Loaded once in {@link onModuleInit}. */
  private accountValue: Account | undefined;
  /** The current device/signing key + its root-signed authorization (rotatable). */
  private deviceValue: Device | undefined;
  private authValue: DeviceAuthorization | undefined;

  /**
   * Takes the **live** config (`doc/spec/runtime-settings.md` §5), so the six descriptor fields an
   * operator can edit — name, description, contact, coverage, accessLevel, capabilities — reach the
   * signed descriptor without a redeploy. Nothing else here needs it: `descriptorFacts()` already
   * re-reads `this.config.*` per call and `descriptor()` signs at call time, so there is no minting
   * to redo. The key provider is resolved once, from deploy-time fields only, unless a restore gave
   * this server its backup's key: then that one, with no fallback, since a server that could not
   * open it must refuse to boot rather than come up as somebody else.
   */
  constructor(
    @Inject(SERVER_CONFIG) config: ServerConfig,
    @Optional() @Inject(RESTORED_IDENTITY) restored?: RestoredIdentity | null,
  ) {
    this.config = config;
    this.provider = restored?.keyEnvelope
      ? new RestoredKeyProvider(restored.keyEnvelope, this.config.keyPassphrase ?? "")
      : resolveKeyProvider(this.config);
  }

  /**
   * Load the account root from the configured provider (fail-closed) and mint the initial device
   * key. Runs at boot, before any request signs a descriptor. A provider error here (bad file
   * permissions, malformed/absent secret) aborts startup rather than silently minting a throwaway
   * identity.
   */
  async onModuleInit(): Promise<void> {
    const account = await this.provider.loadAccount();
    this.accountValue = account;
    this.mintDevice();
    this.logger.log(
      `server identity ready (provider=${this.provider.kind}, did=${account.did}, ` +
        `device=${this.deviceValue?.did})`,
    );
  }

  /** The stable account `did:key` — the server's advertised, restart-stable identity. */
  get account(): Account {
    if (!this.accountValue)
      throw new Error("ServerIdentity: account not loaded (before onModuleInit)");
    return this.accountValue;
  }

  /** The current device/signing key (rotatable under the stable account). */
  get device(): Device {
    if (!this.deviceValue)
      throw new Error("ServerIdentity: device not loaded (before onModuleInit)");
    return this.deviceValue;
  }

  /** The root-signed authorization for the current {@link device} (offline-verifiable, beacon.core
   * `doc/spec/identity.md` §5.2). */
  get auth(): DeviceAuthorization {
    if (!this.authValue) throw new Error("ServerIdentity: auth not loaded (before onModuleInit)");
    return this.authValue;
  }

  /**
   * Rotate the server's device/signing key **under the same account root** (beacon.core
   * `doc/spec/identity.md` §10.3). Mints a fresh device keypair, has the root re-authorize it, and
   * returns a freshly re-signed descriptor (new `updated` timestamp) — the account `did:key`, and
   * therefore the server's advertised identity, is unchanged. Use this for scheduled rotation or to
   * respond to a suspected device-key compromise.
   *
   * NOTE: rotating the **account root** is a different operation — it changes `did:key`, so every
   * client that pinned the old identity must re-discover. That is a migration (beacon.core
   * `doc/spec/identity.md` §11), out of scope for a rotation, and is done by provisioning a new
   * root in the key provider.
   */
  rotateSigningKey(updated: string = new Date().toISOString()): ServerDescriptor {
    this.mintDevice();
    this.logger.log(
      `rotated server device key (did=${this.account.did}, device=${this.device.did})`,
    );
    return this.descriptor(updated);
  }

  /**
   * The recovery phrase behind this server's identity, or undefined for an ephemeral one.
   *
   * Read from the provider each time, and checked against the running account: a key file replaced
   * on disk since boot would otherwise write a phrase that restores as a different server than the
   * one that took the backup, which is the one mistake a backup must not make silently.
   */
  async recoveryPhrase(): Promise<string | undefined> {
    const phrase = await this.provider.recoveryPhrase();
    if (phrase === undefined) return undefined;
    if (accountFromMnemonic(phrase).did !== this.account.did) {
      throw new Error(
        "the key provider's phrase is not this server's identity (changed since boot); restart first",
      );
    }
    return phrase;
  }

  /** The unsigned {@link DescriptorFacts} — what both the descriptor and `admin.status` render. */
  descriptorFacts(): DescriptorFacts {
    return {
      host: this.config.host,
      key: this.account.did,
      coverage: this.config.coverage,
      name: this.config.name,
      ...(this.config.description !== undefined ? { description: this.config.description } : {}),
      ...(this.config.contact !== undefined ? { contact: this.config.contact } : {}),
      version: this.config.version,
      startedAt: PROCESS_STARTED_AT,
      accessLevel: this.config.accessLevel,
      // Always present now: service capabilities are still operator opt-ins
      // (`doc/spec/mailbox-and-media.md` §3.1), but the list also carries protocol markers stating
      // what this build understands, and those are unconditional. A custody-only server therefore
      // advertises its engine markers (`policy:ops.games` at least) rather than omitting the field.
      capabilities: this.config.capabilities,
    };
  }

  /** Build a signed server descriptor (beacon.core `doc/spec/discovery.md` §3.2); the signing lives in `@beaconsgg/identity`. */
  descriptor(updated: string): ServerDescriptor {
    return signDescriptor(this.account, { ...this.descriptorFacts(), updated });
  }

  /** Mint a fresh device key and its root-signed authorization under the current account. */
  private mintDevice(): void {
    const device = createDevice();
    this.deviceValue = device;
    this.authValue = authorizeDevice(this.account, device.did);
  }
}
