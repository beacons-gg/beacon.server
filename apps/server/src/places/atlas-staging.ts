/**
 * Staged Atlas archives — the transient home of an uploaded volume between "bytes arrived" and
 * "import finished".
 *
 * Transient is the design, not a limitation: the whole point of the archive path is that nothing
 * has to stay hosted anywhere. The bytes live here exactly long enough to be verified and imported
 * (places land in the store, media is re-hosted content-addressed), then the directory is deleted —
 * by the import's own cleanup on success or failure, and by the boot sweep for anything a crash
 * orphaned (the snapshot reconcile precedent: staging that outlives its process is garbage, never
 * state).
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { extractVolumeArchive } from "@beaconsgg/atlas-volume";
import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { ulid } from "ulid";

/** What the signed envelope attested about the bytes — verified while they stream. */
export interface ExpectedArchive {
  /** sha256, base64url no-pad — the platform's digest spelling. */
  hash: string;
  size: number;
}

/** A staged-upload rejection (hash/size mismatch, bad id) — the controller maps it to 400. */
export class StagingError extends Error {}

/**
 * The directory the server creates inside the configured one and owns outright. Staging lives only
 * here, so the boot sweep can delete it whole without touching anything else an operator keeps in
 * `BEACON_ATLAS_STAGING_DIR`. With the setting unset the parent is the OS temp dir, which gives the
 * same path the server always used there.
 */
export const STAGING_SUBDIR = "beacon-atlas-staging";

/** Staging names are a ULID: the staged tree, and `<id>.zip` while the archive streams in. */
const ULID = "[0-9A-HJKMNP-TV-Z]{26}";
const STAGING_ID = new RegExp(`^${ULID}$`);
const LEGACY_ENTRY = new RegExp(`^${ULID}(\\.zip)?$`);

@Injectable()
export class AtlasStaging implements OnApplicationBootstrap {
  private readonly logger = new Logger(AtlasStaging.name);
  private readonly root: string;

  /**
   * @param configured `BEACON_ATLAS_STAGING_DIR`, when set; the server stages only in its own
   * subdirectory of it, or of the OS temp dir when unset.
   */
  constructor(private readonly configured?: string) {
    this.root = join(configured ?? tmpdir(), STAGING_SUBDIR);
  }

  /**
   * Boot sweep: staging that survived a restart belongs to no live import — garbage, never state.
   * Only the server's own subdirectory goes; the configured directory and its other contents stay.
   */
  async onApplicationBootstrap(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
    await this.reportLegacyLeftovers();
  }

  /**
   * Servers from before the staging subdirectory staged at the configured directory's root (never
   * at the temp dir's, so an unset setting has nothing to look for). Entries named like their
   * staging (`<ulid>` or `<ulid>.zip`) may be leftovers from a crash mid-import, but a name proves
   * nothing about who wrote the file, so they are reported for the operator to delete and never
   * removed.
   */
  private async reportLegacyLeftovers(): Promise<void> {
    if (this.configured === undefined) return;
    let names: string[];
    try {
      names = await readdir(this.configured);
    } catch {
      return; // An absent or unreadable directory holds no leftovers; staging creates what it needs.
    }
    const legacy = names.filter((n) => LEGACY_ENTRY.test(n));
    if (legacy.length === 0) return;
    this.logger.warn(
      `${this.configured} holds ${legacy.length} entr${legacy.length === 1 ? "y" : "ies"} named like ` +
        `Atlas staging from an older server (${legacy.slice(0, 3).join(", ")}` +
        `${legacy.length > 3 ? ", ..." : ""}). The server now stages only in ${this.root} and ` +
        "leaves these alone; delete them by hand once you know they are not yours.",
    );
  }

  /**
   * Stream an uploaded archive to disk, verifying it against what the envelope attested **as the
   * bytes arrive**: the size cap fails the stream mid-flight (never after buffering a lie), and the
   * digest is compared before anything is extracted. The zip is extracted (containment-checked in
   * the package) and deleted; what remains is the volume tree a `dirVolumeReader` reads.
   */
  async stage(body: NodeJS.ReadableStream, expected: ExpectedArchive): Promise<string> {
    const id = ulid();
    await mkdir(this.root, { recursive: true });
    const zipPath = join(this.root, `${id}.zip`);

    const digest = createHash("sha256");
    let received = 0;
    const counted = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        if (received > expected.size) {
          cb(new StagingError(`archive exceeds the attested size (${expected.size} bytes)`));
          return;
        }
        digest.update(chunk);
        cb(null, chunk);
      },
    });

    try {
      await pipeline(body, counted, createWriteStream(zipPath));
      const actual = digest.digest("base64url");
      if (actual !== expected.hash || received !== expected.size) {
        throw new StagingError(
          `archive does not match the signed attestation (hash ${actual}, ${received} bytes)`,
        );
      }
      await extractVolumeArchive(zipPath, this.dir(id));
      return id;
    } catch (err) {
      await this.discard(id);
      throw err;
    } finally {
      await rm(zipPath, { force: true });
    }
  }

  /** The staged tree's path. The id must be one {@link stage} minted — never operator input pathed. */
  dir(id: string): string {
    // Anything but a ULID is not an id we minted and never joins a path.
    if (!STAGING_ID.test(id)) throw new StagingError(`not a staging id: ${id}`);
    return join(this.root, id);
  }

  async discard(id: string): Promise<void> {
    await rm(this.dir(id), { recursive: true, force: true });
  }
}
