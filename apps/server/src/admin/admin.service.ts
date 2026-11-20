import type { AdminStatus } from "@beaconsgg/protocol-types";
import type { Store } from "@beaconsgg/policy-engine";
import type { DescriptorFacts } from "../server-identity";
import type { MediaStore } from "../stores/media-store";
import type { PlaceStore } from "../stores/place-store";
import type { ProfileStore } from "../stores/profile-store";

/**
 * Assembles the `admin.status` overview (`doc/spec/admin-api.md` §3): the server's descriptor facts
 * (rendered from `ServerIdentity.descriptorFacts()` — the one source, so the status can never drift
 * from the signed descriptor) plus cheap operational counts from every durable store. Counts are
 * aggregate reads by store contract, so the console can poll this without weight. All tables exist
 * regardless of which capabilities are enabled (migrations are unconditional), so a disabled
 * capability simply reports 0.
 */
export class AdminService {
  constructor(
    private readonly store: Store,
    private readonly profiles: ProfileStore,
    private readonly media: MediaStore,
    private readonly places: PlaceStore,
    private readonly facts: () => DescriptorFacts,
    /** A thunk, because the lock is a live setting and this object outlives any one read of it. */
    private readonly writeLocked: () => boolean,
    /** Requests to join waiting for an answer: a thunk, since the list changes under this object. */
    private readonly accessPending: () => number,
    /** `ServerConfig.mediaLimitBytes`. */
    private readonly mediaLimitBytes?: number,
  ) {}

  async status(): Promise<AdminStatus> {
    const [rooms, profiles, mediaStats, placeStats] = await Promise.all([
      this.store.countRooms(),
      this.profiles.count(),
      this.media.stats(),
      this.places.stats(),
    ]);
    const facts = this.facts();
    return {
      host: facts.host,
      name: facts.name,
      version: facts.version,
      accessLevel: facts.accessLevel,
      coverage: facts.coverage,
      capabilities: facts.capabilities ?? [], // the descriptor omits an empty list; status is explicit
      startedAt: facts.startedAt,
      writeLocked: this.writeLocked(),
      counts: {
        rooms,
        profiles,
        places: placeStats.places,
        placesRetired: placeStats.placesRetired,
        conflictsPending: placeStats.conflictsPending,
        snapshots: placeStats.snapshots,
        mediaObjects: mediaStats.objects,
        mediaBytes: mediaStats.bytes,
        mediaUnreviewed: mediaStats.unreviewed,
        accessPending: this.accessPending(),
        ...(this.mediaLimitBytes === undefined ? {} : { mediaLimitBytes: this.mediaLimitBytes }),
      },
    };
  }
}
