import type { BackupRun } from "@beaconsgg/protocol-types";
import { beforeEach, describe, expect, it } from "vitest";
import { PgBackupRunStore } from "../stores/backup-run.pg.store";
import type { BackupRunStore } from "../stores/backup-run-store";
import { MemoryBackupRunStore } from "./memory-stores";
import { memoryTwin, pgTwin, type StoreTwin } from "./pg-twin";

const DID = "did:key:z6MkSmokeTestAccountKeyAbCdEfGhJkLm" as BackupRun["requestedBy"];

function run(id: string, over: Partial<BackupRun> = {}): BackupRun {
  return {
    id,
    kind: "backup",
    status: "queued",
    requestedBy: DID,
    target: { region: "us-east-1", bucket: "b", prefix: "p" },
    createdAt: "2026-11-08T00:00:00.000Z",
    ...over,
  };
}

const TWINS: StoreTwin<BackupRunStore>[] = [
  memoryTwin((): BackupRunStore => new MemoryBackupRunStore()),
  pgTwin((pool): BackupRunStore => new PgBackupRunStore(pool), ["backup_runs"]),
];

describe.each(TWINS)("BackupRunStore parity ($name)", (twin) => {
  let store: BackupRunStore;
  beforeEach(async () => {
    await twin.reset();
    store = await twin.open();
  });

  it("round-trips a run, with its absent fields absent", async () => {
    const queued = run("01A", {
      target: { region: "r", bucket: "b", prefix: "p", endpoint: "http://e" },
    });
    expect(await store.create(queued)).toBe(true);
    expect(await store.get("01A")).toEqual(queued);
    expect(await store.get("missing")).toBeUndefined();
  });

  it("writes only the fields in a patch", async () => {
    await store.create(run("01A"));
    const stats = {
      tablesDone: 1,
      tablesTotal: 2,
      rows: 3,
      mediaDone: 0,
      mediaTotal: 1,
      mediaBytes: 0,
      mediaSkipped: 0,
      mediaMissing: 0,
    };
    await store.update("01A", {
      status: "running",
      startedAt: "2026-11-08T00:00:01.000Z",
      stats,
      warnings: ["careful"],
      locked: true,
    });
    await store.update("01A", {});
    expect(await store.get("01A")).toEqual({
      ...run("01A"),
      status: "running",
      startedAt: "2026-11-08T00:00:01.000Z",
      stats,
      warnings: ["careful"],
      locked: true,
    });
  });

  it("refuses a second live run of either kind until the first ends", async () => {
    expect(await store.create(run("01A"))).toBe(true);
    expect(await store.create(run("01B", { kind: "restore" }))).toBe(false);
    expect(await store.get("01B")).toBeUndefined();

    await store.update("01A", { status: "done", finishedAt: "2026-11-08T00:00:02.000Z" });
    expect(await store.create(run("01B", { kind: "restore" }))).toBe(true);
  });

  it("lists newest first, within the limit", async () => {
    for (const id of ["01A", "01B", "01C"]) {
      await store.create(run(id));
      await store.update(id, { status: "done" });
    }
    expect((await store.recent(2)).map((r) => r.id)).toEqual(["01C", "01B"]);
  });

  it("remembers whether a kind of run has finished done", async () => {
    expect(await store.hasDone("restore")).toBe(false);
    await store.create(run("01A", { kind: "restore" }));
    expect(await store.hasDone("restore")).toBe(false);
    await store.update("01A", { status: "done" });
    expect(await store.hasDone("restore")).toBe(true);
    expect(await store.hasDone("backup")).toBe(false);
  });

  it("closes only the live runs at boot", async () => {
    await store.create(run("01A"));
    await store.update("01A", { status: "done" });
    await store.create(run("01B"));

    expect(await store.failActive("interrupted", "2026-11-08T00:01:00.000Z")).toBe(1);

    expect(await store.get("01A")).toMatchObject({ status: "done" });
    expect(await store.get("01B")).toMatchObject({
      status: "failed",
      error: "interrupted",
      finishedAt: "2026-11-08T00:01:00.000Z",
    });
    expect(await store.failActive("interrupted", "2026-11-08T00:01:00.000Z")).toBe(0);
  });
});
