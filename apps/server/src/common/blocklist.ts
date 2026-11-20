import type { BlockEntry } from "@beaconsgg/protocol-types";
import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { BlocklistStore } from "../stores/blocklist-store";
import { csvEnv } from "./env";

/**
 * A network-wide **sender** blocklist for the signed capability + admin endpoints
 * (`doc/spec/mailbox-and-media.md` §3.4; `doc/spec/admin-api.md` §3). Consulted on
 * send/upload/admin-op and keyed on the **verified** actor DID (from `verifyOp`), so it can't be
 * spoofed by rotating IPs/headers.
 *
 * **Store-backed with a synchronous write-through cache**: the per-request {@link has} consult
 * stays an in-memory `Set` lookup, while adds/removes land durably in the {@link BlocklistStore}
 * (`blacklist` table, `0009_admin`) and update the cache. `BEACON_BLOCKLIST` (csv of `did:key`)
 * still works — its entries deny from construction and are **seeded** into the store at boot
 * (hydrate-first, put-only-absent, so an admin-refreshed row is never clobbered; one server process
 * per database makes that race-free).
 *
 * **Protected DIDs** (`BEACON_ADMINS`) can never be blocked: the gate checks blocklist
 * *before* allowlist, so a blocked admin would be locked out of the very ops that could unblock
 * them. The invariant lives here, where every blocklist write converges: {@link add} refuses, and
 * an env seed for a protected DID is skipped with a warning.
 */
@Injectable()
export class SenderBlocklist implements OnModuleInit {
  private readonly logger = new Logger(SenderBlocklist.name);
  private readonly denied: Set<string>;
  private readonly seeds: string[];
  private readonly skippedSeeds: string[];
  private readonly protectedDids: ReadonlySet<string>;

  constructor(
    private readonly store: BlocklistStore,
    seeds: string[] = csvEnv("BEACON_BLOCKLIST"),
    protectedDids: string[] = [],
  ) {
    this.protectedDids = new Set(protectedDids);
    this.skippedSeeds = seeds.filter((did) => this.protectedDids.has(did));
    this.seeds = seeds.filter((did) => !this.protectedDids.has(did));
    this.denied = new Set(this.seeds); // env entries deny from the first request, before hydration
  }

  /** Hydrate the cache from the store, then persist any env seeds not already present. */
  async onModuleInit(): Promise<void> {
    for (const did of this.skippedSeeds) {
      this.logger.warn(`BEACON_BLOCKLIST lists an admin DID; skipped (cannot block ${did})`);
    }
    const entries = await this.store.all();
    const existing = new Set(entries.map((e) => e.did));
    for (const e of entries) this.denied.add(e.did);

    const addedAt = new Date().toISOString();
    for (const did of this.seeds) {
      if (existing.has(did)) continue;
      await this.store.put({
        did: did as BlockEntry["did"],
        reason: "seeded from BEACON_BLOCKLIST",
        addedBy: "env",
        addedAt,
      });
    }
  }

  /** True if `did` is blocked (its signed requests should be denied). Synchronous: hot path. */
  has(did: string): boolean {
    return this.denied.has(did);
  }

  /** True if `did` must never be blocked (it's on `BEACON_ADMINS`). */
  isProtected(did: string): boolean {
    return this.protectedDids.has(did);
  }

  /** Durably add (or refresh) an entry and deny it immediately. Refuses a protected DID. */
  async add(entry: BlockEntry): Promise<void> {
    if (this.protectedDids.has(entry.did)) {
      throw new Error(`cannot block a protected (admin) DID: ${entry.did}`);
    }
    await this.store.put(entry);
    this.denied.add(entry.did);
  }

  /** Durably lift an entry; true if a row was actually removed. */
  async remove(did: string): Promise<boolean> {
    const removed = await this.store.remove(did);
    this.denied.delete(did);
    return removed;
  }

  /** Every durable entry (the admin fetch). */
  list(): Promise<BlockEntry[]> {
    return this.store.all();
  }
}

/**
 * What a blocked sender is told, wherever it is said. Exported because `SignedRequestGate.check`
 * builds the refusal as a **value** rather than throwing it, so the message travels rather than
 * being written at the throw site.
 *
 * There is no `assertNotBlocked` any more. It existed for the surfaces that verified their own
 * envelopes and had to repeat the consult; routing `place` and the scout relay through the gate
 * left it with no callers but its own test, so it went with them. Two surfaces still consult this
 * blocklist without going through the gate, and neither ever could, because neither has an HTTP
 * response to throw:
 *
 * - the **room op path**, through the engine's injected `isDenied` predicate, which rejects as
 *   `denied` in the engine's own words and maps to the same 403;
 * - **`ProfilesService.publish`**, which returns `denied` as a verdict so its `{ok, error}`
 *   contract stays the whole story, and its controller maps it.
 *
 * So `denied` is the invariant, and now exactly one place throws it.
 *
 * **Never consult on an unverified actor.** A DID lifted out of a request body before its signature
 * is checked is a claim anyone can wear, and gating on one is worse than not gating at all, because
 * it looks like a control. Going through the gate is what makes that structural rather than a rule
 * each caller has to remember.
 */
export const BLOCKED_MESSAGE = "sender is blocked";
