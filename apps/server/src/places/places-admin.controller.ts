import {
  type DidKey,
  type OpEnvelope,
  type PlaceAtlasPreview,
  type PlaceDetail,
  type PlaceAtlasSurvey,
  type PlaceExport,
} from "@beaconsgg/protocol-types";
import { auditLine } from "../common/audit";
import { resolve } from "node:path";
import {
  containedPath,
  dirVolumeReader,
  httpVolumeReader,
  versionFromLatest,
  type VolumeReader,
} from "@beaconsgg/atlas-volume";
import type { Request } from "express";
import { Body, Controller, Inject, Logger, Post, Req, UseGuards } from "@nestjs/common";
import { AdminGate } from "../common/admin-gate";
import { badRequest, missing, notFound, parseParams } from "../common/capability-http";
import { NonceService } from "../common/nonce.service";
import { ATLAS_OP_HEADER, type ParsedOp, SIGNED_ROUTES } from "../common/signed-routes";
import { AllowWhileLocked } from "../common/write-lock.guard";
import { WriteRateLimitGuard } from "../common/rate-limit.guard";
import type {
  AtlasPinRecord,
  PlaceConflictRecord,
  PlaceProposalRecord,
  PlaceRecord,
  PlaceSnapshotRecord,
} from "../stores/place-store";
import { PlacesAdminService } from "./admin.service";
import { ContributionsService, ProposeError } from "./contributions.service";
import { rejectProposal } from "./contributions.controller";
import { AtlasStaging, StagingError } from "./atlas-staging";
import { AtlasSurveys } from "./atlas-survey";
import { ATLAS_OUTBOUND, ATLAS_VOLUMES_DIR } from "./connectors/atlas";
import { OutboundError, type OutboundClient } from "../common/outbound-http";
import { SnapshotParamsError, SnapshotService } from "./snapshot.service";

/**
 * Statuses that mean a hosted URL has no `latest.json`, so it names a version, not a root. A public
 * S3 bucket that does not allow listing answers a missing object with 403.
 */
const NOT_FOUND = new Set([403, 404, 410]);

/** Rethrow `err`, as a 400 when it is the operator's input that is wrong rather than this server. */
function operatorErrorAsBadRequest(err: unknown): never {
  if (err instanceof SnapshotParamsError || err instanceof StagingError) badRequest(err.message);
  throw err;
}

/** Decode the header envelope, or 400 — malformed base64/JSON is a client error, said plainly. */
function envelopeFromHeader(req: Request): unknown {
  const raw = req.headers[ATLAS_OP_HEADER];
  if (typeof raw !== "string" || raw === "") badRequest(`missing ${ATLAS_OP_HEADER} header`);
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as unknown;
  } catch {
    badRequest(`unreadable ${ATLAS_OP_HEADER} header`);
  }
}

/**
 * The places **admin** surface (the places spec, `doc/spec/places.md` §6.3): signed envelopes
 * exactly like mailbox/media (`verifyOp` → the actor is cryptographic), **plus** the server-wide
 * operator allowlist (`BEACON_ADMINS`, the shared {@link AdminGate}) — these routes rewrite the
 * dataset the server serves, so they are never public, even in v1. All routes are POSTs (a signed
 * read rides a body, the `POST /mailbox/fetch` precedent). Disabled capability **or** no admins
 * configured ⇒ `404` (the surface looks absent); verified-but-not-allowlisted ⇒ `403`.
 *
 * **Audit:** every write logs one `{op, actor, target}` line under the same `Admin` context as the
 * other admin routes (`doc/spec/admin-api.md` §3). A nonce-idempotent write logs inside its bracket,
 * so a replayed envelope does not log a second time. Signed reads log nothing.
 */
@Controller()
export class PlacesAdminController {
  private readonly logger = new Logger("Admin");

  constructor(
    private readonly snapshots: SnapshotService,
    private readonly admin: PlacesAdminService,
    private readonly gate: AdminGate,
    private readonly nonce: NonceService,
    private readonly contributions: ContributionsService,
    private readonly staging: AtlasStaging,
    private readonly surveys: AtlasSurveys,
    @Inject(ATLAS_OUTBOUND) private readonly atlasOutbound: OutboundClient,
    @Inject(ATLAS_VOLUMES_DIR) private readonly atlasVolumesDir: string | undefined,
  ) {}

  /**
   * Close out a source that is no longer an input (the Atlas integration spec,
   * `apps/atlas/doc/spec/beacon-integration.md` §6): every live record of `source` goes gone as a
   * durable run. The service refuses living inputs — this exists for the residue the deleted OSM
   * connectors left behind, after Atlas volumes have adopted it.
   */
  @Post("places/admin/sources/retire")
  @UseGuards(WriteRateLimitGuard)
  async retireSource(@Body() body: unknown): Promise<{ ok: true; snapshot: PlaceSnapshotRecord }> {
    return this.idempotentRun(body, SIGNED_ROUTES["places/admin/sources/retire"], (params, actor) =>
      this.snapshots.createSourceRetire(params.source, actor),
    );
  }

  /** Signed read: one snapshot by id, or the recent list — the progress poll. */
  @AllowWhileLocked()
  @Post("places/admin/snapshots/fetch")
  async fetch(@Body() body: unknown): Promise<{ ok: true; snapshots: PlaceSnapshotRecord[] }> {
    const params = await this.signedRead(body, SIGNED_ROUTES["places/admin/snapshots/fetch"]);
    let snapshots: PlaceSnapshotRecord[];
    if (params.id !== undefined) {
      const snapshot = await this.snapshots.getSnapshot(params.id);
      snapshots = snapshot ? [snapshot] : [];
    } else {
      snapshots = await this.snapshots.listSnapshots();
    }
    return { ok: true, snapshots };
  }

  /**
   * Close out one run by id (`doc/spec/places.md` §6.3): a live run stops cooperatively at its next
   * chunk boundary; a run orphaned by a restart is flipped straight to a terminal state. Idempotent
   * by nature (re-cancelling a terminal run is a no-op), so it rides the plain signed gate — no
   * nonce.
   */
  @AllowWhileLocked()
  @Post("places/admin/snapshots/cancel")
  @UseGuards(WriteRateLimitGuard)
  async cancel(@Body() body: unknown): Promise<{ ok: true; snapshot: PlaceSnapshotRecord }> {
    const route = SIGNED_ROUTES["places/admin/snapshots/cancel"];
    const { actor, env } = this.verify(body, route.op);
    const params = parseParams(route.params, env.params);
    const snapshot = await this.snapshots.cancel(params.id);
    if (!snapshot) missing("unknownRun", "unknown snapshot");
    this.audit(route.op, actor, snapshot.id, `status=${snapshot.status}`);
    return { ok: true, snapshot };
  }

  // ── Atlas volumes: runtime import, no deploy-time configuration ─────────────────────────────────

  /**
   * Stage an uploaded volume archive and answer its preview. The signed envelope rides the
   * `x-beacon-op` header because the body **is the archive**, streamed to disk — a gigabyte does not
   * fit inside a JSON envelope, and base64 would inflate it by a third. The envelope attests
   * `{hash, size}`; the bytes are hashed as they arrive and refused on mismatch, which is the same
   * integrity link the media upload uses at photo scale.
   */
  @Post("places/admin/atlas/upload")
  @UseGuards(WriteRateLimitGuard)
  async atlasUpload(
    @Req() req: Request,
  ): Promise<{ ok: true; staged: string; preview: PlaceAtlasPreview }> {
    const route = SIGNED_ROUTES["places/admin/atlas/upload"];
    // The surface's 404s before the header is read, so a server with places off or no admins
    // answers the same 404 whatever the request carries, as every other route here does.
    this.assertPlaces();
    this.gate.assertEnabled();
    const { actor, env } = this.verify(envelopeFromHeader(req), route.op);
    const params = parseParams(route.params, env.params);

    let staged: string;
    try {
      staged = await this.staging.stage(req, params);
    } catch (err) {
      if (err instanceof StagingError) badRequest(err.message);
      throw err;
    }
    this.audit(route.op, actor, staged, `size=${params.size}`);
    // Preview immediately — the operator's next screen is the confirm. A tree whose manifest cannot
    // be read is discarded now rather than left for the boot sweep.
    try {
      const preview = await this.snapshots.inspectAtlas(
        await dirVolumeReader(this.staging.dir(staged)),
      );
      return { ok: true, staged, preview };
    } catch (err) {
      await this.staging.discard(staged);
      if (err instanceof SnapshotParamsError) badRequest(err.message);
      throw err;
    }
  }

  /** Signed read: a hosted volume's preview — who signed it, what it holds, how the pin stands. */
  @Post("places/admin/atlas/inspect")
  async atlasInspect(@Body() body: unknown): Promise<{ ok: true; preview: PlaceAtlasPreview }> {
    const params = await this.signedRead(body, SIGNED_ROUTES["places/admin/atlas/inspect"]);
    try {
      const target = await this.resolveTarget(params);
      const preview = await this.snapshots.inspectAtlas(await this.readerFor(target), {
        versionUrl: target.url,
      });
      return { ok: true, preview };
    } catch (err) {
      operatorErrorAsBadRequest(err);
    }
  }

  /**
   * Import a volume (queued run; idempotent by nonce). `publisher` restates the did the operator
   * confirmed on the preview — the service verifies the manifest against it and the pin against
   * both, so this op is meaningless to replay against a swapped volume.
   */
  @Post("places/admin/atlas/import")
  @UseGuards(WriteRateLimitGuard)
  async atlasImport(@Body() body: unknown): Promise<{ ok: true; snapshot: PlaceSnapshotRecord }> {
    return this.idempotentRun(
      body,
      SIGNED_ROUTES["places/admin/atlas/import"],
      async (params, actor) =>
        this.snapshots.createAtlasImport(
          await this.readerFor(await this.resolveTarget(params)),
          params,
          actor,
          {
            outbound: this.atlasOutbound,
            ...(params.staged !== undefined
              ? { cleanup: () => this.staging.discard(params.staged!) }
              : {}),
          },
        ),
    );
  }

  /**
   * Signed read: count what a volume holds in an area, by place type and by what each place carries,
   * so the operator chooses filters with numbers in front of them. Runs in the background; the
   * console polls with the same params until the survey is `done` or `failed`.
   */
  @Post("places/admin/atlas/survey")
  async atlasSurvey(@Body() body: unknown): Promise<{ ok: true; survey: PlaceAtlasSurvey }> {
    const params = await this.signedRead(body, SIGNED_ROUTES["places/admin/atlas/survey"]);
    const cells = params.cells ? [...new Set(params.cells)].sort() : undefined;
    // Keyed on the URL as given, so a poll answers from memory without touching the network. A
    // hosted root is resolved once, when the survey starts, and the survey keeps that version.
    const key = JSON.stringify([
      params.url ?? null,
      params.staged ?? null,
      params.path ?? null,
      cells,
    ]);
    try {
      const survey = await this.surveys.get(
        key,
        async () => this.readerFor(await this.resolveTarget(params)),
        cells,
      );
      return { ok: true, survey };
    } catch (err) {
      operatorErrorAsBadRequest(err);
    }
  }

  /** Forget a volume's publisher pin — the deliberate half of key rotation. Idempotent by nature. */
  @Post("places/admin/atlas/unpin")
  @UseGuards(WriteRateLimitGuard)
  async atlasUnpin(@Body() body: unknown): Promise<{ ok: true; removed: boolean }> {
    const route = SIGNED_ROUTES["places/admin/atlas/unpin"];
    const { actor, env } = this.verify(body, route.op);
    const params = parseParams(route.params, env.params);
    const removed = await this.snapshots.unpinAtlas(params.volume);
    this.audit(route.op, actor, params.volume, `removed=${String(removed)}`);
    return { ok: true, removed };
  }

  /**
   * Signed read: every volume→publisher pin, with who confirmed it and when. The audit list that
   * makes revocation *proactive* — before this, the only path to an unpin was a mismatch preview,
   * which requires possessing a volume signed by the very key you're trying to stop trusting.
   */
  @Post("places/admin/atlas/pins")
  async atlasPins(@Body() body: unknown): Promise<{ ok: true; pins: AtlasPinRecord[] }> {
    await this.signedRead(body, SIGNED_ROUTES["places/admin/atlas/pins"]);
    return { ok: true, pins: await this.snapshots.listAtlasPins() };
  }

  /** The params with a hosted URL resolved to the version it names (see `resolveVersionUrl`). */
  private async resolveTarget<T extends { url?: string | undefined }>(params: T): Promise<T> {
    return params.url !== undefined
      ? { ...params, url: await this.resolveVersionUrl(params.url) }
      : params;
  }

  /**
   * The reader for whichever transport the params name — a URL fetched once, or a staged tree. A
   * hosted URL is read as given: resolve a volume root with `resolveTarget` first.
   */
  private async readerFor(params: {
    url?: string | undefined;
    staged?: string | undefined;
    path?: string | undefined;
  }): Promise<VolumeReader> {
    if (params.url !== undefined) {
      return httpVolumeReader(params.url, (url) => this.getAtlasText(url));
    }
    if (params.path !== undefined && this.atlasVolumesDir === undefined) {
      badRequest(
        "path imports are disabled — set BEACON_ATLAS_VOLUMES_DIR to the mounted volumes directory",
      );
    }
    // Both remaining branches are local directory reads whose failure is the operator's input — a
    // bad path, a consumed staging id, a tree with no latest.json — never this server failing.
    try {
      if (params.path !== undefined) {
        // A mounted tree — the fast local path. The op names a directory UNDER the configured root
        // and nothing else: `containedPath` is the same traversal gate the archive reader stands
        // behind, so an admin op can never turn into an arbitrary filesystem read.
        const root = resolve(this.atlasVolumesDir!);
        return await dirVolumeReader(containedPath(root, root, params.path), "mounted volume");
      }
      return await dirVolumeReader(this.staging.dir(params.staged!));
    } catch (err) {
      badRequest(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * A hosted volume URL as the version URL to read. The volume's root (`…/us-west/`) holds
   * `latest.json`, the pointer to its current version, so a root follows it; a version URL has no
   * `latest.json` and is used as given. Whatever this returns, the manifest read after it is the
   * check: a URL that is neither fails there with the manifest's own error. Only a missing
   * `latest.json` means "not a root"; any other failure reading it is reported as itself.
   */
  private async resolveVersionUrl(url: string): Promise<string> {
    const base = url.replace(/\/+$/, "");
    let text: string;
    try {
      text = await this.getAtlasText(`${base}/latest.json`);
    } catch (err) {
      if (err instanceof OutboundError && NOT_FOUND.has(err.status ?? 0)) return base;
      badRequest(`could not read ${base}/latest.json: ${err instanceof Error ? err.message : err}`);
    }
    const version = versionFromLatest(text);
    // One path segment under the root, never `.` or `..`, which would read outside it.
    if (version !== undefined && /^[\w.-]+$/.test(version) && !/^\.+$/.test(version)) {
      return `${base}/${version}`;
    }
    return base;
  }

  private getAtlasText(url: string): Promise<string> {
    return this.atlasOutbound.http.getText(url, { limiter: this.atlasOutbound.limiter });
  }

  /** Signed read: export the dataset (or a boundary's slice) as the interchange FeatureCollection. */
  @Post("places/admin/export")
  async export(@Body() body: unknown): Promise<{ ok: true; collection: PlaceExport }> {
    const params = await this.signedRead(body, SIGNED_ROUTES["places/admin/export"]);
    return { ok: true, collection: await this.admin.exportPlaces(params.boundary) };
  }

  /**
   * Signed read: the approved player contributions this server holds, as a `beacon-contrib/1` file
   * (`apps/atlas/doc/spec/beacon-integration.md` §9), the export half of the contribution
   * round-trip.
   *
   * **Off unless the operator turned it on.** This is the one direction in the architecture where
   * player-derived data leaves for a central party, so it is a deliberate act rather than a route
   * that exists by default. Absent the flag it 404s exactly like a disabled capability, rather than
   * returning an empty collection — "nothing to share" and "sharing is off" are different answers.
   */
  @Post("places/admin/contrib/export")
  async exportContrib(@Body() body: unknown): Promise<{ ok: true; collection: PlaceExport }> {
    if (!this.admin.contribExportEnabled) notFound("contribution export is not enabled");
    const params = await this.signedRead(body, SIGNED_ROUTES["places/admin/contrib/export"]);
    return { ok: true, collection: await this.admin.exportContributions(params.boundary) };
  }

  /** Land an interchange file as the `list:<name>` source (queued run; idempotent by nonce). */
  @Post("places/admin/import")
  @UseGuards(WriteRateLimitGuard)
  async import(@Body() body: unknown): Promise<{ ok: true; snapshot: PlaceSnapshotRecord }> {
    return this.idempotentRun(body, SIGNED_ROUTES["places/admin/import"], (params, actor) =>
      this.snapshots.createImport(params.name, params.collection, actor),
    );
  }

  /**
   * Author a place by hand (the place proposals spec, `doc/spec/place-proposals.md` §7): the verb
   * {@link edit} can't provide, since it 404s on an unknown `unique`. Lands as an `admin` source
   * record. Idempotent by nonce (a retry returns the place the first call created, never a
   * duplicate).
   */
  @Post("places/admin/create")
  @UseGuards(WriteRateLimitGuard)
  async createPlace(@Body() body: unknown): Promise<{ ok: true; place: PlaceDetail }> {
    return this.idempotentPlaceWrite(body, SIGNED_ROUTES["places/admin/create"], (params, actor) =>
      this.admin.create(params, actor),
    );
  }

  /**
   * Per-field admin edit (`doc/spec/places.md` §3.1): `set` fields become admin-held, `clear`
   * releases overrides. Idempotent by nonce (a retry re-reads, never re-applies); unknown place →
   * 404.
   */
  @Post("places/admin/edit")
  @UseGuards(WriteRateLimitGuard)
  async edit(@Body() body: unknown): Promise<{ ok: true; place: PlaceDetail }> {
    return this.idempotentPlaceWrite(body, SIGNED_ROUTES["places/admin/edit"], (params, actor) =>
      this.admin.edit(params.unique, params.set ?? {}, params.clear ?? [], actor),
    );
  }

  /**
   * Signed read: the **whole** contribution queue (`doc/spec/place-proposals.md` §6), newest first.
   * Same op name as the player-facing fetch — the gate is what decides the scope: a contributor's
   * route scopes to their own DID, this one doesn't scope at all.
   */
  @Post("places/admin/proposals/fetch")
  async proposalsFetch(
    @Body() body: unknown,
  ): Promise<{ ok: true; proposals: PlaceProposalRecord[] }> {
    // Rides the places-capability gate, NOT the submissions flag: closing submissions must not
    // strand a backlog an operator still has to decide.
    const params = await this.signedRead(body, SIGNED_ROUTES["places/admin/proposals/fetch"]);
    return { ok: true, proposals: await this.contributions.list(params) };
  }

  /**
   * Approve or reject a submission. Approval lands it as a `contrib` source record through the same
   * merge/commit path a snapshot uses; `edits` amends it first. Idempotent twice over — by nonce,
   * and by the store's pending-conditional stamp, so a second operator's decision can't overwrite
   * the first.
   */
  @Post("places/admin/proposals/review")
  @UseGuards(WriteRateLimitGuard)
  async proposalsReview(
    @Body() body: unknown,
  ): Promise<{ ok: true; proposal: PlaceProposalRecord }> {
    const route = SIGNED_ROUTES["places/admin/proposals/review"];
    const signed = this.verify(body, route.op);
    const { actor } = signed;
    const params = parseParams(route.params, signed.env.params);

    const { id } = await this.nonce.idempotentResult(signed, async () => {
      try {
        const reviewed = await this.contributions.review(params, actor);
        if (!reviewed) missing("unknownProposal", "unknown proposal");
        const { decision, reason } = params;
        this.audit(route.op, actor, reviewed.id, `decision=${decision}`, reason);
        return { id: reviewed.id };
      } catch (err) {
        // An approval whose place has retired since the submission applies nothing, and the
        // proposal stays pending so the operator can reject it instead.
        if (err instanceof ProposeError) rejectProposal(err.rejection);
        throw err;
      }
    });
    const proposal = await this.contributions.getProposal(id);
    if (!proposal) missing("unknownProposal", "unknown proposal"); // durable row — safety only
    return { ok: true, proposal };
  }

  /** Signed read: the pending-revision queue (unresolved-first), optionally for one place. */
  @Post("places/admin/conflicts/fetch")
  async conflictsFetch(
    @Body() body: unknown,
  ): Promise<{ ok: true; conflicts: PlaceConflictRecord[] }> {
    const params = await this.signedRead(body, SIGNED_ROUTES["places/admin/conflicts/fetch"]);
    return { ok: true, conflicts: await this.admin.listConflicts(params.unique) };
  }

  /** Mark conflict rows reviewed (idempotent by nonce; re-resolving flips nothing). */
  @Post("places/admin/conflicts/resolve")
  @UseGuards(WriteRateLimitGuard)
  async conflictsResolve(@Body() body: unknown): Promise<{ ok: true; resolved: number }> {
    const route = SIGNED_ROUTES["places/admin/conflicts/resolve"];
    const signed = this.verify(body, route.op);
    const params = parseParams(route.params, signed.env.params);
    const memo = await this.nonce.idempotentResult(signed, async () => {
      const resolved = await this.admin.resolveConflicts(params.ids);
      this.audit(route.op, signed.actor, params.ids.join(","), `resolved=${resolved}`);
      return { resolved };
    });
    return { ok: true, resolved: memo.resolved };
  }

  /**
   * The nonce-idempotent write pattern shared by the two **place-writing** routes (create + edit):
   * memo only the `unique` (the record itself is re-read, so a replay can't serve a stale snapshot
   * of it), then reload. `apply` returning `undefined` means the place doesn't exist → 404
   * `unknownPlace`. The answer is the place as the wire's `PlaceDetail`, never the store's record.
   *
   * Deliberately a sibling of {@link idempotentRun} rather than a generalization of it: that one is
   * snapshot-shaped (returns `{snapshot}`, reloads by run id, maps `SnapshotParamsError`), and
   * unifying them would change `places.edit`'s **persisted** memo key — which a retry landing across
   * a rolling deploy would read back as `undefined`.
   */
  private async idempotentPlaceWrite<P>(
    body: unknown,
    { op, params: schema }: ParsedOp<P>,
    apply: (params: P, actor: DidKey) => Promise<PlaceRecord | undefined>,
  ): Promise<{ ok: true; place: PlaceDetail }> {
    const signed = this.verify(body, op);
    const { actor } = signed;
    const params = parseParams(schema, signed.env.params);

    // Only the memoized `unique` is durable, so a **replay** has to re-read. A fresh write doesn't:
    // `apply` already returns the committed record, and in both paths its `createdAt` matches what
    // the store holds — `edit` re-reads after committing, and `create`'s row is new, so the
    // write-once `createdAt` is exactly the value it just passed.
    let written: PlaceRecord | undefined;
    const { unique } = await this.nonce.idempotentResult(signed, async () => {
      written = await apply(params, actor);
      if (!written) missing("unknownPlace", "unknown place");
      this.audit(op, actor, written.unique);
      return { unique: written.unique };
    });
    const place = written ?? (await this.snapshots.getPlace(unique));
    if (!place) missing("unknownPlace", "unknown place"); // places are never hard-deleted — safety only
    return { ok: true, place: await this.admin.detail(place) };
  }

  /**
   * The nonce-idempotent write pattern shared by every run-creating route: a retried nonce returns
   * the original run; params-shape and domain rejections map to 400.
   */
  private async idempotentRun<P>(
    body: unknown,
    { op, params: schema }: ParsedOp<P>,
    create: (params: P, actor: DidKey) => Promise<PlaceSnapshotRecord>,
  ): Promise<{ ok: true; snapshot: PlaceSnapshotRecord }> {
    const signed = this.verify(body, op);
    const { actor } = signed;
    const params = parseParams(schema, signed.env.params);
    const { id } = await this.nonce.idempotentResult(signed, async () => {
      try {
        const run = await create(params, actor);
        this.audit(op, actor, run.source, `run=${run.id}`);
        return { id: run.id };
      } catch (err) {
        if (err instanceof SnapshotParamsError) badRequest(err.message);
        throw err;
      }
    });
    const snapshot = await this.snapshots.getSnapshot(id);
    if (!snapshot) missing("unknownRun", "run record missing"); // durable rows — safety only
    return { ok: true, snapshot };
  }

  /** One structured audit line per write, in the admin routes' format (`doc/spec/admin-api.md` §3). */
  private audit(op: string, actor: DidKey, target: string, detail?: string, reason?: string): void {
    this.logger.log(auditLine(op, actor, target, [detail], reason));
  }

  /**
   * The capability check in front of the shared admin gate (the enabled check stays with the
   * controller — the capability-http convention): places off ⇒ these routes look absent.
   */
  private verify(body: unknown, op: string): { actor: DidKey; env: OpEnvelope } {
    this.assertPlaces();
    return this.gate.verify(body, op);
  }

  /** {@link verify}'s twin for fetch-style routes — capability 404, then the gate's read bracket. */
  private signedRead<P>(body: unknown, route: ParsedOp<P>): Promise<P> {
    this.assertPlaces();
    return this.gate.signedRead(body, route);
  }

  /** Places off ⇒ these routes look absent. The gate adds its own 404 for no admins configured. */
  private assertPlaces(): void {
    if (!this.snapshots.enabled) notFound("places capability not enabled");
  }
}
