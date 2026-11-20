import {
  CONTRIB_LICENSE_TERMS,
  type ContribLicense,
  type DidKey,
  type Media,
  type MediaCredit,
  type PlaceEditSet,
  type PlaceProposalReviewParams,
  type PlaceProposalsFetchParams,
  type PlaceProposeParams,
} from "@beaconsgg/protocol-types";
import { Injectable } from "@nestjs/common";
import { ulid } from "ulid";
import { DidRateLimiter } from "../common/did-rate-limit";
import type { ServerConfig } from "../config";
import { liveView } from "../settings/live-config";
import type {
  PlaceFields,
  PlaceProposalRecord,
  PlaceRecord,
  PlaceStore,
} from "../stores/place-store";
import type { MediaIngester } from "../media/media-transfer";
import { commitCuratedRecord, definedFields, splitSelfSource } from "./canonical";
import { CONTRIB_SOURCE } from "./merge";
import { isVocabularyPair } from "@beaconsgg/place-taxonomy";

/** The contribution knobs, lifted out of {@link ServerConfig} so the service is easy to test. */
export interface ContributionsConfig {
  /**
   * `BEACON_PLACES_PROPOSALS`: whether NEW submissions are accepted. Already ANDed with
   * `BEACON_PLACES` by the loader, so this is the whole condition the player routes gate on.
   */
  submissionsEnabled: boolean;
  cellPrecision: number;
  /** Per-DID submissions allowed per {@link rateWindowMs}. */
  rateMax: number;
  rateWindowMs: number;
  /** Per-DID cap on *unreviewed* submissions — bounds queue flooding independently of the rate. */
  maxPending: number;
}
/** The contributions slice, as accessors over the live config — see settings/live-config.ts. */
export function contributionsConfigFrom(c: ServerConfig): ContributionsConfig {
  return liveView(c, {
    submissionsEnabled: "placesContributionsEnabled",
    cellPrecision: "placesCellPrecision",
    rateMax: "placesProposalRateMax",
    rateWindowMs: "placesProposalRateWindowMs",
    maxPending: "placesProposalMaxPending",
  });
}

/** Default page size for a proposal listing (the caller may request less). */
const DEFAULT_PAGE = 50;

/** Why a submission was refused — the controller maps each to its status code. */
export type ProposeRejection =
  | { reason: "invalidPair" } // category/subcategory not a curated pair
  | { reason: "unknownPlace" } // improvement target absent or retired
  | { reason: "unknownMedia"; hash: string } // a hash this server can't serve
  | { reason: "rateLimited" }
  | { reason: "tooManyPending"; max: number };

export class ProposeError extends Error {
  constructor(readonly rejection: ProposeRejection) {
    super(rejection.reason);
    this.name = "ProposeError";
  }
}

/**
 * The one `MediaService` method the submit validator needs. A slice of the existing
 * {@link MediaIngester} port rather than a second declaration of the same method — that interface
 * lives in `media/` precisely so a feature dir never re-describes the media surface.
 */
export type MediaPresence = Pick<MediaIngester, "lookupIngested">;

/**
 * Player contributions to the place dataset (`doc/spec/place-proposals.md` §5 to §6): a signed DID
 * proposes a place the dataset lacks, or descriptor fields for one it has, and **nothing is visible
 * until an operator approves it**. This is the one place the platform deliberately doesn't extend
 * radical trust — not because it doubts a gameplay claim (it never checks those), but because the
 * dataset is shared infrastructure that other games, other servers, and export files inherit.
 *
 * Approval writes a `contrib` source record through the same merge/commit path a connector snapshot
 * and an operator edit use, so an approved contribution is just another source — ranked above `osm`
 * (reviewed human input beats a raw connector value) and below `list:`/`admin`.
 */
@Injectable()
export class ContributionsService {
  private readonly limiter: DidRateLimiter;

  constructor(
    private readonly store: PlaceStore,
    private readonly cfg: ContributionsConfig,
    /**
     * Whether this server can serve a referenced photo, as a thunk for the same reason {@link
     * serverDid} is one: media is a runtime capability, and reading it eagerly captured
     * `mediaEnabled` as it stood at boot (`doc/spec/runtime-settings.md` §3.4). An operator
     * enabling media later would have left every photo-bearing submission refused for the life of
     * the process.
     */
    private readonly media: () => MediaPresence | undefined,
    /**
     * This server's own DID, as the attribution party for an uncredited contribution.
     *
     * A thunk, like {@link now}, because `ServerIdentity` resolves its key during module init and
     * this service is constructed by a factory that runs before that — reading it eagerly would
     * capture whatever the getter did at construction time, which is either a throw or a stale
     * value the day key rotation exists.
     */
    private readonly serverDid: () => string,
    private readonly now: () => number = () => Date.now(),
  ) {
    // A view, not a copy: pinning the two numbers here would fix the budget at boot, which is the
    // staleness this round removes. `DidRateLimiter` reads them per check.
    this.limiter = new DidRateLimiter(liveView(cfg, { windowMs: "rateWindowMs", max: "rateMax" }));
  }

  /**
   * Whether new submissions are accepted — the player routes 404 when off.
   *
   * The **review** routes deliberately don't consult this; they ride the places-capability gate the
   * rest of the admin surface uses, so closing submissions never strands a backlog an operator still
   * has to decide.
   */
  get enabled(): boolean {
    return this.cfg.submissionsEnabled;
  }

  /**
   * Record a submission as `pending`. Validation is all cheap and all before anything is persisted:
   * the category pair, the target's existence, and that every referenced media hash is one **this**
   * server can serve (a reviewer must be able to see the photo they're judging).
   *
   * A new-place proposal's `id` becomes the place's `unique` if it's approved, which is what makes
   * approval idempotent — see {@link approve}.
   */
  async propose(params: PlaceProposeParams, actor: DidKey): Promise<PlaceProposalRecord> {
    const { target } = params;

    if (target.kind === "new" && !isVocabularyPair(target.category, target.subcategory)) {
      throw new ProposeError({ reason: "invalidPair" });
    }
    if (target.kind === "existing") {
      const place = await this.store.getPlace(target.unique);
      if (!place || place.status !== "active") throw new ProposeError({ reason: "unknownPlace" });
    }
    // Re-addressed to THIS server's copy, not merely checked against it. The hash is the identity
    // and `uris` are only location hints — but every consumer fetches `uris[0]`, so keeping the
    // client's pointer would mean the reviewer judges bytes from a host we don't control and the
    // approved place serves them forever, with whoever owns that host free to swap them afterwards.
    // Same normalization `MediaTransfer` does on the snapshot path, for the same reason.
    const media: Media[] = [];
    for (const entry of target.media ?? []) {
      // With media off there is no store to check, so a photo-bearing proposal can't be accepted:
      // this server could neither show the reviewer the bytes nor serve them on the place.
      const presence = this.media();
      const local = presence ? await presence.lookupIngested(entry.hash) : undefined;
      if (!local) throw new ProposeError({ reason: "unknownMedia", hash: entry.hash });
      // The client's own `credit` is dropped and **rebuilt from what this server knows** — the
      // licence the contributor granted and whether they asked to be named. A submitted credit is
      // an attribution line published on a public read; taking the client's would let it name
      // anyone. Built here rather than at approval because this is the one place a contributed
      // media entry is constructed, and it means the reviewer judges exactly what will publish.
      media.push({
        type: entry.type,
        ...(entry.role ? { role: entry.role } : {}),
        hash: entry.hash,
        uris: [local.id],
        credit: contribCredit(target.license, params.credit, actor, this.serverDid()),
      });
    }
    // Budgets last, so a submission rejected on shape never burns one — and the free in-memory
    // limiter before the DB count, so a DID parked at its pending cap can't spend a COUNT per
    // attempt forever without ever consuming rate budget.
    if (!this.limiter.check(actor, this.now())) throw new ProposeError({ reason: "rateLimited" });
    if ((await this.store.countPendingByDid(actor)) >= this.cfg.maxPending) {
      throw new ProposeError({ reason: "tooManyPending", max: this.cfg.maxPending });
    }

    const proposal: PlaceProposalRecord = {
      id: ulid(this.now()),
      ...(target.kind === "existing" ? { placeUnique: target.unique } : {}),
      proposedBy: actor,
      credit: params.credit,
      license: target.license,
      fields: { ...proposedFields(target), ...(media.length > 0 ? { media } : {}) },
      ...(params.note !== undefined ? { note: params.note } : {}),
      status: "pending",
      createdAt: new Date(this.now()).toISOString(),
    };
    await this.store.createProposal(proposal);
    return proposal;
  }

  /**
   * A page of proposals, newest first. `proposedBy` is the scope seam: the player route passes the
   * verified actor (so a contributor sees only their own), the admin route passes nothing.
   */
  list(params: PlaceProposalsFetchParams, proposedBy?: DidKey): Promise<PlaceProposalRecord[]> {
    return this.store.listProposals(
      {
        ...(params.status !== undefined ? { status: params.status } : {}),
        ...(proposedBy !== undefined ? { proposedBy } : {}),
      },
      params.limit ?? DEFAULT_PAGE,
      params.cursor,
    );
  }

  getProposal(id: string): Promise<PlaceProposalRecord | undefined> {
    return this.store.getProposal(id);
  }

  /**
   * An operator's decision. Approval applies the submission (amended by `edits`, so the common
   * "90% right" contribution is one click plus a tweak) and then stamps the row; rejection only
   * stamps. Returns `undefined` for an unknown id, and the unchanged record when it was already
   * reviewed — the stamp is conditional on `pending`, so two operators can't both win.
   */
  async review(
    params: PlaceProposalReviewParams,
    actor: DidKey,
  ): Promise<PlaceProposalRecord | undefined> {
    const proposal = await this.store.getProposal(params.id);
    if (!proposal) return undefined;
    if (proposal.status !== "pending") return proposal; // idempotent: the first decision stands

    const nowIso = new Date(this.now()).toISOString();
    // Apply BEFORE stamping. The two writes aren't one transaction, and this order is what makes a
    // crash between them safe: the row stays `pending`, and re-approving re-applies onto the same
    // place (a new-place proposal's id IS its place's unique, so the upsert is idempotent).
    const applied =
      params.decision === "approve"
        ? await this.apply(proposal, params.edits, actor, nowIso)
        : undefined;

    // An approval can legitimately land nothing: an improvement whose target place has retired since
    // it was submitted merges to fields that can't make a servable place, and `commitCuratedRecord`
    // writes nothing rather than guess. Failing here leaves the row `pending` and reviewable, which
    // is the honest outcome — stamping it `approved` would tell the contributor their work is live
    // when it was dropped on the floor, on a terminal row nobody can re-open.
    if (params.decision === "approve" && applied === undefined) {
      throw new ProposeError({ reason: "unknownPlace" });
    }

    // Conditional on `pending`, so a second admin deciding at the same time flips nothing and gets
    // the first decision back rather than overwriting it.
    //
    // KNOWN GAP, single-instance-scoped: the apply above has already run by then, so a concurrent
    // approve+reject can leave applied data on a row stamped `rejected`. Closing it properly means
    // claiming the row before applying, which needs `updateProposal` to be able to set
    // `appliedPlace` on an already-decided row and to release a claim — a store-interface change
    // across both implementations. Not worth it while a server runs one process per database; worth
    // it before there are two.
    await this.store.updateProposal(params.id, {
      status: params.decision === "approve" ? "approved" : "rejected",
      reviewedBy: actor,
      reviewedAt: nowIso,
      ...(params.reason !== undefined ? { reviewReason: params.reason } : {}),
      ...(applied !== undefined ? { appliedPlace: applied.unique } : {}),
    });
    return this.store.getProposal(params.id);
  }

  /**
   * Land an approved submission as a `contrib` source record. An improvement folds into the place's
   * existing `contrib` record (one per place, the `admin` shape) so several contributors accumulate
   * into one merged record; a new place is created under the proposal's own id.
   */
  private async apply(
    proposal: PlaceProposalRecord,
    edits: PlaceEditSet | undefined,
    actor: DidKey,
    nowIso: string,
  ): Promise<PlaceRecord | undefined> {
    // The proposal's id doubles as a new place's unique — that's the idempotency trick.
    const unique = proposal.placeUnique ?? proposal.id;
    const { self, others } = await splitSelfSource(this.store, CONTRIB_SOURCE, unique);
    // A description's credit travels WITH the description — the rule that keeps an NPS narrative
    // from shipping under Wikipedia's licence, applied here so a contributed sentence never ships
    // under the previous contributor's. Set only when this submission actually contributes one, so
    // a photo-only improvement leaves the standing description and its credit alone.
    const describes = proposal.fields.description !== undefined;
    const credit =
      describes && proposal.license
        ? contribCredit(proposal.license, proposal.credit, proposal.proposedBy, this.serverDid())
        : undefined;
    return commitCuratedRecord(this.store, this.cfg.cellPrecision, {
      source: CONTRIB_SOURCE,
      unique,
      // Prior contributions + this one + the reviewer's amendments, in increasing precedence.
      // Note what that means: everything here lands at `contrib` rank, amendments included. A later
      // approved contribution touching the same field supersedes an earlier one — including a
      // reviewer's wording fix — with no conflict row. That's deliberate: `edits` amends *this
      // submission*, it doesn't freeze the field. An operator who wants a value held against both
      // connectors and future contributors promotes it with `places.edit` (admin rank).
      fields: definedFields({
        ...self?.fields,
        ...proposal.fields,
        ...edits,
        ...(credit ? { descriptionCredit: credit } : {}),
      }),
      others,
      actor,
      nowIso,
    });
  }
}

/**
 * **The one place the credit rule is decided** — what a contributed field or photo says about who it
 * came from and what may be done with it.
 *
 * Two halves, both settled at submit and never re-derived downstream:
 *
 * - **The licence** is the grant the contributor chose, covering the submission's text and photos
 *   alike. It is what lets an approved contribution travel to the open Atlas dataset at all — every
 *   other corpus a volume publishes states terms per item, and a field with no terms is one no
 *   redistributor can lawfully carry.
 * - **The author** is the contributor's DID when they asked to be credited, and **this server's**
 *   when they did not. The second is provenance, not attribution: an uncredited submission can only
 *   be CC0 (the wire refuses anything else), and CC0 asks for no attribution — but a published field
 *   should still say where it came from, and "a player on this server" is the honest answer.
 *
 * Built from what the server knows rather than from what the client sent, because a submitted credit
 * line is published on a public read and a client-supplied one could name anyone.
 */
function contribCredit(
  license: ContribLicense,
  credited: boolean,
  proposedBy: DidKey,
  serverDid: string,
): MediaCredit {
  const terms = CONTRIB_LICENSE_TERMS[license];
  return { license: terms.label, licenseUrl: terms.url, author: credited ? proposedBy : serverDid };
}

/**
 * The proposed values as canonical fields. Four keys on the wire target aren't kept: `kind` is the
 * discriminant, `unique` addresses the place being improved rather than describing it, `media`
 * is replaced by the caller with entries re-addressed to this server's own copy (see `propose`),
 * and `license` is a property of the submission rather than a field of the place.
 */
function proposedFields(target: PlaceProposeParams["target"]): PlaceFields {
  const fields = definedFields(target);
  delete (fields as { kind?: unknown }).kind;
  delete (fields as { unique?: unknown }).unique;
  delete (fields as { media?: unknown }).media;
  // The grant is a property of the submission, not a field of the place — it rides its own column,
  // and a copy in `fields` would reach `commitCuratedRecord` and land on the place record itself.
  delete (fields as { license?: unknown }).license;
  return fields;
}
