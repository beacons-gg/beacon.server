/**
 * `BEACON_ATLAS_STAGING_DIR` is the operator's directory, not the server's.
 * The server stages in a subdirectory it creates, and the boot sweep deletes only that subdirectory,
 * so anything else an operator keeps in the configured directory survives every restart.
 */
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AtlasStaging, STAGING_SUBDIR } from "../places/atlas-staging";
import { CELL, lighthouse, volume, volumeZip } from "./atlas-fixture";

async function stageOne(staging: AtlasStaging): Promise<string> {
  const zip = await volumeZip(volume([{ cell: CELL, revision: 1, places: [lighthouse()] }]));
  return staging.stage(Readable.from([zip]), {
    hash: createHash("sha256").update(zip).digest("base64url"),
    size: zip.length,
  });
}

/** What a restart does to staging: a fresh instance on the same setting, then the boot sweep. */
async function restart(dir: string): Promise<AtlasStaging> {
  const staging = new AtlasStaging(dir);
  await staging.onApplicationBootstrap();
  return staging;
}

describe("Atlas staging in a configured directory", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "beacon-staging-owned-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("stages only inside its own subdirectory", async () => {
    const staging = await restart(dir);
    const id = await stageOne(staging);
    expect(staging.dir(id)).toBe(join(dir, STAGING_SUBDIR, id));
    await expect(access(join(staging.dir(id), "latest.json"))).resolves.toBeUndefined();
  });

  it("keeps a foreign file and directory across a restart, and sweeps only its own staging", async () => {
    await writeFile(join(dir, "notes.txt"), "the operator's");
    await mkdir(join(dir, "backups"));
    await writeFile(join(dir, "backups", "db.sql"), "select 1;");

    const before = await restart(dir);
    const id = await stageOne(before);

    const after = await restart(dir);
    await expect(access(after.dir(id))).rejects.toThrow();
    expect(await readFile(join(dir, "notes.txt"), "utf8")).toBe("the operator's");
    expect(await readFile(join(dir, "backups", "db.sql"), "utf8")).toBe("select 1;");
  });

  it("leaves what an older server staged at the root, and says so", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const legacyId = "01JC0000000000000000000000";
    await mkdir(join(dir, legacyId));
    await writeFile(join(dir, `${legacyId}.zip`), "zip");

    await restart(dir);

    await expect(access(join(dir, legacyId))).resolves.toBeUndefined();
    await expect(access(join(dir, `${legacyId}.zip`))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("2 entries");
  });

  it("says nothing when the directory holds no leftovers", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    await writeFile(join(dir, "notes.txt"), "the operator's");
    await restart(dir);
    expect(warn).not.toHaveBeenCalled();
  });
});
