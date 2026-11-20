import type {
  AccessEntry,
  AccessStatus,
  DidKey,
  ServerAccessLevel,
} from "@beaconsgg/protocol-types";
import { KeyedMutex } from "@beaconsgg/server-runtime";
import { Injectable, type OnModuleInit } from "@nestjs/common";
import type { AccessStore } from "../stores/access-store";
import { byteCompare } from "./byte-order";
import { denied } from "./capability-http";

/** What a non-member is told when a write is refused. */
export const NOT_MEMBER_MESSAGE = "this server takes writes from members only";

/**
 * The most requests that may wait for an answer at once. A did:key costs nothing to make, so
 * without a ceiling anyone could fill the operator's queue. Past it a request is refused
 * `rateLimited` until an admin answers some.
 */
export const MAX_PENDING_REQUESTS = 1000;

/** The entry statuses, the order `list` puts them in. */
const LIST_ORDER: Record<AccessEntry["status"], number> = { pending: 0, member: 1, declined: 2 };

/** The one key every change queues on: the list is small and changes rarely. */
const WRITES = "access";

/**
 * The member list (`doc/spec/admin-api.md` §6): who may write to a server whose `accessLevel` is
 * `request` or `private`. At `open` everyone may, and an admin (`BEACON_ADMINS`) always may.
 *
 * **Writes, never reads.** `SignedRequestGate.verifyWrite` asks {@link assertMember} at every game
 * write the boundary verifies, and the engine asks {@link admits} for a room op other than `list`:
 * a placement, a room op, a scout report or cancel, a mailbox send, a media upload and a place
 * proposal. Reads stay open at every level, and so do the signed reads (a player still
 * reads their mail), `POST /profiles` (the operator needs the requester's profile to decide) and the
 * admin surface. A mailbox ack is the reader tidying their own inbox, not a write to the server, so
 * it is not gated either, the same line the game gate draws.
 *
 * **Store-backed with a synchronous write-through cache**, like the blocklist: the per-write consult
 * is a `Map` lookup, and every change lands in the {@link AccessStore} first. Changes run one at a
 * time and read the cache inside their turn, so a player's request racing an admin's answer cannot
 * undo it, and the pending cap holds under a burst. One server process per database keeps the cache
 * and the store in step.
 *
 * The level is read live on every consult, so changing it (a runtime setting) takes effect on the
 * next write. Moving off `open` does not admit anyone; `admin.access.admitAll` is the operator's
 * explicit way to keep the players a server already has.
 */
@Injectable()
export class MemberList implements OnModuleInit {
  private readonly entries = new Map<string, AccessEntry>();
  private readonly admins: ReadonlySet<string>;
  private readonly writes = new KeyedMutex();

  constructor(
    private readonly store: AccessStore,
    private readonly config: { readonly accessLevel: ServerAccessLevel },
    admins: readonly string[],
  ) {
    this.admins = new Set(admins);
  }

  /** Hydrate the cache from the store. */
  async onModuleInit(): Promise<void> {
    for (const entry of await this.store.all()) this.entries.set(entry.did, entry);
  }

  /** The server's access level, as it is now. */
  get level(): ServerAccessLevel {
    return this.config.accessLevel;
  }

  /** True if `actor` may write here. Synchronous: it runs on every write. */
  admits(actor: string): boolean {
    return (
      this.level === "open" ||
      this.admins.has(actor) ||
      this.entries.get(actor)?.status === "member"
    );
  }

  /** The HTTP form of {@link admits}: `403 notMember` for anyone else. */
  assertMember(actor: string): void {
    if (!this.admits(actor)) denied(NOT_MEMBER_MESSAGE, "notMember");
  }

  /** Where `actor` stands: `member` whenever {@link admits} says so, else their entry, else `none`. */
  status(actor: string): AccessStatus {
    if (this.admits(actor)) return "member";
    return this.entries.get(actor)?.status ?? "none";
  }

  /**
   * Record a request from `actor`, at the `request` level only (the caller refuses the others).
   * A member or a declined player is left as they are. A pending request takes the new note, or
   * loses its note when this one has none, and the new time.
   *
   * @returns The player's status afterwards, or `"full"` when {@link MAX_PENDING_REQUESTS} new
   * requests are already waiting.
   */
  request(actor: DidKey, note: string | undefined, now: string): Promise<AccessStatus | "full"> {
    return this.writes.run(WRITES, async () => {
      const current = this.status(actor);
      if (current === "member" || current === "declined") return current;
      if (current === "none" && this.pendingCount() >= MAX_PENDING_REQUESTS) return "full";
      await this.put([
        { did: actor, status: "pending", ...(note ? { note } : {}), requestedAt: now },
      ]);
      return "pending";
    });
  }

  /** Make `did` a member, approving its request if it has one. The request's note and time stay. */
  add(did: DidKey, by: DidKey, now: string): Promise<AccessEntry> {
    return this.writes.run(WRITES, async () => {
      const entry = this.memberEntry(did, by, now);
      await this.put([entry]);
      return entry;
    });
  }

  /** Decline `did`'s pending request, or return `undefined` when it has none. */
  decline(did: DidKey, by: DidKey, now: string): Promise<AccessEntry | undefined> {
    return this.writes.run(WRITES, async () => {
      const current = this.entries.get(did);
      if (current?.status !== "pending") return undefined;
      const entry: AccessEntry = { ...current, status: "declined", decidedBy: by, decidedAt: now };
      await this.put([entry]);
      return entry;
    });
  }

  /** Delete `did`'s entry; true if there was one. */
  remove(did: string): Promise<boolean> {
    return this.writes.run(WRITES, async () => {
      const removed = await this.store.remove(did);
      this.entries.delete(did);
      return removed;
    });
  }

  /**
   * Make a member of each of `dids` that has no entry and is not an admin. A pending request and a
   * decline are the operator's to answer one by one, so they are left as they are.
   *
   * @returns How many became members.
   */
  admitAll(dids: Iterable<DidKey>, by: DidKey, now: string): Promise<number> {
    return this.writes.run(WRITES, async () => {
      const added: AccessEntry[] = [];
      for (const did of dids) {
        if (this.admins.has(did) || this.entries.has(did)) continue;
        added.push(this.memberEntry(did, by, now));
      }
      await this.put(added);
      return added.length;
    });
  }

  /**
   * The entries, optionally of one status: pending requests oldest first, then members, then
   * declined players, each of those by DID in byte order.
   */
  list(status?: AccessEntry["status"]): AccessEntry[] {
    return [...this.entries.values()]
      .filter((e) => status === undefined || e.status === status)
      .sort(
        (a, b) =>
          LIST_ORDER[a.status] - LIST_ORDER[b.status] ||
          (a.status === "pending" ? byteCompare(a.requestedAt ?? "", b.requestedAt ?? "") : 0) ||
          byteCompare(a.did, b.did),
      );
  }

  /** How many requests wait for an answer: the console's to-do count. */
  pendingCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.status === "pending") n += 1;
    return n;
  }

  /** `did` as a member, keeping the note and time of any request it made. */
  private memberEntry(did: DidKey, by: DidKey, now: string): AccessEntry {
    const { note, requestedAt } = this.entries.get(did) ?? {};
    return {
      did,
      status: "member",
      ...(note !== undefined ? { note } : {}),
      ...(requestedAt !== undefined ? { requestedAt } : {}),
      decidedBy: by,
      decidedAt: now,
    };
  }

  /** Store the entries, all or none, then cache them. */
  private async put(entries: readonly AccessEntry[]): Promise<void> {
    await this.store.put(entries);
    for (const entry of entries) this.entries.set(entry.did, entry);
  }
}
