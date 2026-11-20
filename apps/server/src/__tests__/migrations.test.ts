import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type MigrationExecutor, loadMigrations, runMigrations } from "../migrations/runner";

/**
 * The migration runner: it loads the checked-in `.sql` files under `migrations/postgres/` in
 * version order and applies only the not-yet-applied ones through an executor. Tested here with a
 * fake executor; every Pg store suite runs the real one.
 */

/** A fake {@link MigrationExecutor} recording what got applied, in order. */
function fakeExecutor(preapplied: number[] = []): MigrationExecutor & { applied: number[] } {
  const applied = new Set(preapplied);
  const order: number[] = [];
  return {
    applied: order,
    ensureVersionTable(): Promise<void> {
      return Promise.resolve();
    },
    appliedVersions(): Promise<Set<number>> {
      return Promise.resolve(new Set(applied));
    },
    withLock: <T>(fn: () => Promise<T>): Promise<T> => fn(),
    applyMigration(version: number): Promise<void> {
      applied.add(version);
      order.push(version);
      return Promise.resolve();
    },
  };
}

describe("migration runner: stopping at a version", () => {
  it("applies nothing past it, and the rest on the next run", async () => {
    const all = loadMigrations().map((m) => m.version);
    const stopAt = all[2] as number;
    const exec = fakeExecutor();
    expect(await runMigrations(exec, undefined, { stopAt })).toEqual(all.slice(0, 3));
    expect(await runMigrations(exec)).toEqual(all.slice(3));
  });
});

describe("migration runner", () => {
  it("loads the checked-in migrations in version order", () => {
    const migs = loadMigrations();
    expect(migs.length).toBeGreaterThanOrEqual(1);
    expect(migs[0]?.version).toBe(1);
    expect(migs[0]?.name).toBe("init");
    // Ascending, unique versions.
    const versions = migs.map((m) => m.version);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
    expect(new Set(versions).size).toBe(versions.length);
    // The SQL creates the three custody tables.
    expect(migs[0]?.sql).toMatch(/CREATE TABLE.*rooms/s);
    expect(migs[0]?.sql).toMatch(/CREATE TABLE.*nonces/s);
    expect(migs[0]?.sql).toMatch(/CREATE TABLE.*profiles/s);
  });

  it("the init migration declares geohash + lifecycle_due indexes and JSONB", () => {
    const sql = loadMigrations()[0]?.sql ?? "";
    expect(sql).toMatch(/JSONB/);
    expect(sql).toMatch(/rooms_geohash_idx/);
    expect(sql).toMatch(/rooms_lifecycle_due_idx/);
    expect(sql).toMatch(/lifecycle_due_at IS NOT NULL/); // partial index
  });

  it("applies all pending migrations once, in version order", async () => {
    const all = loadMigrations().map((m) => m.version);
    const exec = fakeExecutor();
    const done = await runMigrations(exec);
    expect(done).toEqual(all); // every checked-in migration, ascending
    expect(exec.applied).toEqual(all);
  });

  it("runs every step inside the executor's lock", async () => {
    // The lock is the only thing stopping two migration runs on one database racing on
    // `CREATE ... IF NOT EXISTS` (every server boot runs one, and the test suites share a DB).
    let held = false;
    const outside: string[] = [];
    const step = (name: string): void => {
      if (!held) outside.push(name);
    };
    const exec: MigrationExecutor = {
      async withLock<T>(fn: () => Promise<T>): Promise<T> {
        held = true;
        try {
          return await fn();
        } finally {
          held = false;
        }
      },
      ensureVersionTable(): Promise<void> {
        step("ensureVersionTable");
        return Promise.resolve();
      },
      appliedVersions(): Promise<Set<number>> {
        step("appliedVersions");
        return Promise.resolve(new Set());
      },
      applyMigration(version: number): Promise<void> {
        step(`apply ${version}`);
        return Promise.resolve();
      },
    };
    const done = await runMigrations(exec);
    expect(done.length).toBeGreaterThan(0);
    expect(outside).toEqual([]);
  });

  it("skips already-applied versions (idempotent re-run)", async () => {
    const all = loadMigrations().map((m) => m.version);
    const exec = fakeExecutor(all); // everything already applied
    const done = await runMigrations(exec);
    expect(done).toEqual([]);
    expect(exec.applied).toEqual([]);
  });

  it("includes the mailbox migration (0002)", () => {
    const mailbox = loadMigrations().find((m) => m.name === "mailbox");
    expect(mailbox?.version).toBe(2);
    expect(mailbox?.sql).toMatch(/CREATE TABLE.*mailbox/s);
  });

  it("throws on a duplicate migration version, at load time", () => {
    const base = mkdtempSync(join(tmpdir(), "beacon-migs-"));
    try {
      const dir = join(base, "postgres");
      mkdirSync(dir);
      writeFileSync(join(dir, "0001_a.sql"), "SELECT 1;");
      writeFileSync(join(dir, "0001_b.sql"), "SELECT 2;"); // same version 1 — an authoring error
      expect(() => loadMigrations(base)).toThrow(/duplicate migration version 1/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("throws on a missing or empty migration set, rather than migrating nothing", async () => {
    // A build that did not copy the SQL: an empty set would boot a server onto a schema-less database.
    const base = mkdtempSync(join(tmpdir(), "beacon-migs-"));
    try {
      expect(() => loadMigrations(base)).toThrow(/ENOENT/);
      mkdirSync(join(base, "postgres"));
      writeFileSync(join(base, "postgres", "README.txt"), "not a migration");
      expect(() => loadMigrations(base)).toThrow(/no migrations in/);
      await expect(runMigrations(fakeExecutor(), base)).rejects.toThrow(/no migrations in/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
