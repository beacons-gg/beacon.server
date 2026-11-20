import { HANDLERS } from "@beaconsgg/policy-engine";
import {
  accessRequestParamsSchema,
  accessStatusParamsSchema,
  adminAccessAdmitAllParamsSchema,
  adminAccessDidParamsSchema,
  adminAccessFetchParamsSchema,
  adminBackupRunsParamsSchema,
  adminBackupStartParamsSchema,
  adminBlocklistAddParamsSchema,
  adminBlocklistFetchParamsSchema,
  adminBlocklistRemoveParamsSchema,
  adminMediaListParamsSchema,
  adminMediaRemoveParamsSchema,
  adminMediaReviewParamsSchema,
  adminRestoreInspectParamsSchema,
  adminRestoreStartParamsSchema,
  adminRoomRemoveParamsSchema,
  adminSettingsGetParamsSchema,
  adminSettingsResetParamsSchema,
  adminSettingsSetParamsSchema,
  adminStatusParamsSchema,
  mailboxAckParamsSchema,
  mailboxFetchParamsSchema,
  mailboxSendParamsSchema,
  mediaPutParamsSchema,
  placeAtlasImportParamsSchema,
  placeAtlasInspectParamsSchema,
  placeAtlasPinsFetchParamsSchema,
  placeAtlasSurveyParamsSchema,
  placeAtlasUnpinParamsSchema,
  placeAtlasUploadParamsSchema,
  placeConflictsFetchParamsSchema,
  placeConflictsResolveParamsSchema,
  placeContribExportParamsSchema,
  placeCreateParamsSchema,
  placeEditParamsSchema,
  placeExportParamsSchema,
  placeImportParamsSchema,
  placeParamsSchema,
  placeProposalReviewParamsSchema,
  placeProposalsFetchParamsSchema,
  placeProposeParamsSchema,
  placeSnapshotCancelParamsSchema,
  placeSnapshotsFetchParamsSchema,
  placeSourceRetireParamsSchema,
  scoutCancelParamsSchema,
  scoutReportParamsSchema,
} from "@beaconsgg/protocol-types";
import type { ZodType } from "zod";

/**
 * One op a signed route takes: the name its envelope's `op` must carry, and the schema its `params`
 * parse with. `params` is absent only when someone other than the server defines them (a room op,
 * whose params the game's policy decides).
 */
export interface SignedOp {
  readonly op: string;
  readonly params?: ZodType;
  /** The params are the room policy's to define, so the server publishes no schema for them. */
  readonly policyParams?: true;
}

/** An op the server parses the params of: what a controller passes to a signed bracket. */
export interface ParsedOp<P> {
  readonly op: string;
  readonly params: ZodType<P>;
}

/** An op with a params schema, typed so a controller's parse returns the params' own type. */
function op<Op extends string, P>(name: Op, params: ZodType<P>): ParsedOp<P> & { readonly op: Op } {
  return { op: name, params };
}

/**
 * The ops `POST /rooms/:id/ops` takes: the engine's handlers. Only the names, because a room op's
 * params are what the room's policy says they are.
 */
const ROOM_OPS: readonly SignedOp[] = Object.keys(HANDLERS).map((name) => ({
  op: name,
  policyParams: true,
}));

/** The header `POST /places/admin/atlas/upload` takes its envelope in, as base64 of its JSON. */
export const ATLAS_OP_HEADER = "x-beacon-op";

/**
 * Every signed route, by its path as mounted, with the op or ops its envelope may carry.
 *
 * The controllers take their op names and params schemas from here, and the OpenAPI document
 * builds each signed route's request body from here, so the two cannot disagree. A test holds the
 * keys to the POST routes the app mounts. `POST /profiles` is the one POST missing from this table:
 * a profile doc is signed by the account root and is not an op envelope.
 */
export const SIGNED_ROUTES = {
  rooms: op("place", placeParamsSchema),
  "rooms/:id/ops": ROOM_OPS,
  // The relay serves a scout's report and its cancel through one entry.
  scouts: [op("report", scoutReportParamsSchema), op("cancel", scoutCancelParamsSchema)],

  mailbox: op("mailbox.send", mailboxSendParamsSchema),
  "mailbox/fetch": op("mailbox.fetch", mailboxFetchParamsSchema),
  "mailbox/ack": op("mailbox.ack", mailboxAckParamsSchema),
  // The envelope rides inside `MediaUpload`, beside the base64 bytes.
  media: op("media.put", mediaPutParamsSchema),

  "access/request": op("access.request", accessRequestParamsSchema),
  "access/status": op("access.status", accessStatusParamsSchema),

  "places/propose": op("places.propose", placeProposeParamsSchema),
  "places/proposals/fetch": op("places.proposals.fetch", placeProposalsFetchParamsSchema),
  "places/admin/sources/retire": op("places.source.retire", placeSourceRetireParamsSchema),
  "places/admin/export": op("places.export", placeExportParamsSchema),
  "places/admin/contrib/export": op("places.contrib.export", placeContribExportParamsSchema),
  "places/admin/import": op("places.import", placeImportParamsSchema),
  "places/admin/proposals/fetch": op("places.proposals.fetch", placeProposalsFetchParamsSchema),
  "places/admin/proposals/review": op("places.proposals.review", placeProposalReviewParamsSchema),
  "places/admin/create": op("places.create", placeCreateParamsSchema),
  "places/admin/edit": op("places.edit", placeEditParamsSchema),
  "places/admin/conflicts/fetch": op("places.conflicts.fetch", placeConflictsFetchParamsSchema),
  "places/admin/conflicts/resolve": op(
    "places.conflicts.resolve",
    placeConflictsResolveParamsSchema,
  ),
  // The envelope rides the `ATLAS_OP_HEADER` header, because the body is the archive.
  "places/admin/atlas/upload": op("places.atlas.upload", placeAtlasUploadParamsSchema),
  "places/admin/atlas/inspect": op("places.atlas.inspect", placeAtlasInspectParamsSchema),
  "places/admin/atlas/import": op("places.atlas.import", placeAtlasImportParamsSchema),
  "places/admin/atlas/survey": op("places.atlas.survey", placeAtlasSurveyParamsSchema),
  "places/admin/atlas/unpin": op("places.atlas.unpin", placeAtlasUnpinParamsSchema),
  "places/admin/atlas/pins": op("places.atlas.pins.fetch", placeAtlasPinsFetchParamsSchema),
  "places/admin/snapshots/fetch": op("places.snapshots.fetch", placeSnapshotsFetchParamsSchema),
  "places/admin/snapshots/cancel": op("places.snapshot.cancel", placeSnapshotCancelParamsSchema),

  "admin/status": op("admin.status", adminStatusParamsSchema),
  "admin/backup/start": op("admin.backup.start", adminBackupStartParamsSchema),
  "admin/backup/runs": op("admin.backup.runs", adminBackupRunsParamsSchema),
  "admin/restore/inspect": op("admin.restore.inspect", adminRestoreInspectParamsSchema),
  "admin/restore/start": op("admin.restore.start", adminRestoreStartParamsSchema),
  "admin/rooms/remove": op("admin.room.remove", adminRoomRemoveParamsSchema),
  "admin/media/remove": op("admin.media.remove", adminMediaRemoveParamsSchema),
  "admin/media/list": op("admin.media.list", adminMediaListParamsSchema),
  "admin/media/review": op("admin.media.review", adminMediaReviewParamsSchema),
  "admin/blocklist/add": op("admin.blocklist.add", adminBlocklistAddParamsSchema),
  "admin/blocklist/remove": op("admin.blocklist.remove", adminBlocklistRemoveParamsSchema),
  "admin/blocklist/fetch": op("admin.blocklist.fetch", adminBlocklistFetchParamsSchema),
  "admin/access/fetch": op("admin.access.fetch", adminAccessFetchParamsSchema),
  "admin/access/add": op("admin.access.add", adminAccessDidParamsSchema),
  "admin/access/decline": op("admin.access.decline", adminAccessDidParamsSchema),
  "admin/access/remove": op("admin.access.remove", adminAccessDidParamsSchema),
  "admin/access/admitAll": op("admin.access.admitAll", adminAccessAdmitAllParamsSchema),
  "admin/settings/get": op("admin.settings.get", adminSettingsGetParamsSchema),
  "admin/settings/set": op("admin.settings.set", adminSettingsSetParamsSchema),
  "admin/settings/reset": op("admin.settings.reset", adminSettingsResetParamsSchema),
} as const satisfies Record<string, SignedOp | readonly SignedOp[]>;

/** A path in {@link SIGNED_ROUTES}. */
export type SignedPath = keyof typeof SIGNED_ROUTES;

/** The ops a route takes, in the table's order. */
export function opsOf(path: SignedPath): readonly SignedOp[] {
  return [SIGNED_ROUTES[path]].flat();
}
