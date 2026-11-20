import * as protocolTypes from "@beaconsgg/protocol-types";
import {
  adminBackupRunsSchema,
  adminMediaListSchema,
  adminMediaReviewSchema,
  adminRestoreInspectionSchema,
  adminSettingsSchema,
  adminStatusSchema,
  backupRunSchema,
  blockEntrySchema,
  accessEntrySchema,
  accessResultSchema,
  discoveryResponseSchema,
  type ErrorCode,
  errorResultSchema,
  geoBBoxSchema,
  geocodeResultSchema,
  mailboxMessageSchema,
  mediaSchema,
  MAX_PROFILE_BYTES,
  mediaUploadSchema,
  movementSchema,
  opaqueItemSchema,
  opEnvelopeSchema,
  okResultSchema,
  placeAtlasImportOptionsSchema,
  placeAtlasPinSchema,
  placeAtlasPreviewSchema,
  placeAtlasSurveySchema,
  placeConflictSchema,
  placeDetailSchema,
  placeEditSetSchema,
  placeExportSchema,
  placeGeometrySchema,
  placeProposalSchema,
  placeSnapshotSchema,
  placeSummarySchema,
  placeTaxonomySchema,
  placesQueryResultSchema,
  policySchema,
  profileDocReadSchema,
  roomSchema,
  serverDescriptorSchema,
  UNDERSTANDS_HEADER,
} from "@beaconsgg/protocol-types";
import { CODE_FALLBACKS, NOT_FOUND_FALLBACKS } from "@beaconsgg/protocol-types/server";
import { z } from "zod";
import {
  ATLAS_OP_HEADER,
  opsOf,
  SIGNED_ROUTES,
  type SignedOp,
  type SignedPath,
} from "../common/signed-routes";
import { MAX_ABOUT_LENGTH, type ServerConfig } from "../config";

/**
 * Build the OpenAPI 3.1 document for the Beacon server's REST surface.
 *
 * The component schemas are generated from the `@beaconsgg/protocol-types` zod schemas with zod's own
 * `z.toJSONSchema` (JSON Schema 2020-12, the dialect of OpenAPI 3.1), so the spec cannot drift from
 * the wire contract. Each signed route's request body comes from `SIGNED_ROUTES`, the table its
 * controller reads its op name and params schema from.
 *
 * Only REST is described. The socket.io live and map channels are server-to-client events, described
 * in the hand-written API reference. State-changing ops are signed `OpEnvelope`s POSTed over REST; the
 * signature is computed on the client, so interactive "try it out" works only for the unsigned GETs.
 */

/** A server entry: a URL, which may hold `{variables}`. */
interface OpenApiServer {
  url: string;
  description?: string;
  variables?: Record<string, { default: string; description?: string }>;
}

/** A minimal OpenAPI 3.1 document shape (only the fields we emit). */
export interface OpenApiDocument {
  openapi: "3.1.0";
  info: { title: string; version: string; description: string };
  servers: OpenApiServer[];
  tags: Array<{ name: string; description: string }>;
  paths: Record<string, unknown>;
  components: { schemas: Record<string, unknown>; responses: Record<string, unknown> };
}

type Schema = Record<string, unknown>;

/** A named `$ref` into `components.schemas`. */
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });

/** A payload whose fields sit beside `ok: true` in a signed route's answer, as one closed object. */
const okBeside = <S extends z.ZodObject>(schema: S) => schema.extend({ ok: z.literal(true) });

/** What the server answers with, by component name. Generated as zod's `output`. */
const RESPONSE_SCHEMAS: Record<string, z.ZodType> = {
  Room: roomSchema,
  OkResult: okResultSchema,
  ServerDescriptor: serverDescriptorSchema,
  DiscoveryResponse: discoveryResponseSchema,
  GeocodeResult: geocodeResultSchema,
  PlaceSummary: placeSummarySchema,
  PlaceDetail: placeDetailSchema,
  PlacesQueryResult: placesQueryResultSchema,
  PlaceSnapshot: placeSnapshotSchema,
  PlaceConflict: placeConflictSchema,
  PlaceProposal: placeProposalSchema,
  PlaceTaxonomy: placeTaxonomySchema,
  PlaceAtlasPreview: placeAtlasPreviewSchema,
  PlaceAtlasSurvey: placeAtlasSurveySchema,
  PlaceAtlasPin: placeAtlasPinSchema,
  MailboxMessage: mailboxMessageSchema,
  AdminStatus: adminStatusSchema,
  BlockEntry: blockEntrySchema,
  AccessEntry: accessEntrySchema,
  AccessResult: accessResultSchema,
  BackupRun: backupRunSchema,
  // These answers carry `ok: true` beside the payload's own fields.
  AdminMediaList: okBeside(adminMediaListSchema),
  AdminMediaReview: okBeside(adminMediaReviewSchema),
  AdminSettings: okBeside(adminSettingsSchema),
  AdminBackupRuns: okBeside(adminBackupRunsSchema),
  AdminRestoreInspection: okBeside(adminRestoreInspectionSchema),
};

/** What a client sends, besides each signed op's params. Generated as zod's `input`. */
const REQUEST_SCHEMAS: Record<string, z.ZodType> = {
  OpEnvelope: opEnvelopeSchema,
  MediaUpload: mediaUploadSchema,
  // The read twin, and as input, so open: the server keeps the fields a newer app signed and this
  // build does not know, and serves them back on `GET /profiles/{id}`.
  ProfileDoc: profileDocReadSchema,
};

/**
 * Schemas both sides nest, named so they are written out once and referenced. Generated both ways,
 * and the build fails if the two differ.
 */
const SHARED_SCHEMAS: Record<string, z.ZodType> = {
  Policy: policySchema,
  OpaqueItem: opaqueItemSchema,
  Media: mediaSchema,
  Movement: movementSchema,
  PlaceGeometry: placeGeometrySchema,
  GeoBBox: geoBBoxSchema,
  PlaceEditSet: placeEditSetSchema,
  PlaceAtlasImportOptions: placeAtlasImportOptionsSchema,
  PlaceExport: placeExportSchema,
};

/** `word` with its first letter in upper case. */
const upperFirst = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/** Each core schema by object, to the names core exports it under, for {@link paramsComponent}. */
const CORE_SCHEMA_NAMES = new Map<unknown, string[]>();
for (const [name, value] of Object.entries(protocolTypes)) {
  if (!name.endsWith("Schema") || !(value instanceof z.ZodType)) continue;
  const component = upperFirst(name.slice(0, -"Schema".length));
  CORE_SCHEMA_NAMES.set(value, [...(CORE_SCHEMA_NAMES.get(value) ?? []), component]);
}

/** `admin.restore.inspect` → `AdminRestoreInspectParams`. */
const opParamsName = (op: string): string => `${op.split(".").map(upperFirst).join("")}Params`;

/**
 * The component a signed op's params are published as: core's own name for the schema, so the spec
 * and the SDK say the same thing (`placeProposalReviewParamsSchema` → `PlaceProposalReviewParams`,
 * the type a client already imports). Core exports a few schemas under two names (restore's
 * inspect and start take the same params), and then the op's own name picks. A schema core does
 * not export yet (`mailbox.fetch`'s) is named after its op.
 */
export function paramsComponent(op: SignedOp): string {
  const fromOp = opParamsName(op.op);
  const names = op.params === undefined ? undefined : CORE_SCHEMA_NAMES.get(op.params);
  // Never a throw: the document is built at boot, and a core release adding an alias must not stop
  // a server starting. The suite holds each op to the name it is published under.
  if (names === undefined || names.includes(fromOp)) return fromOp;
  return [...names].sort()[0]!;
}

/**
 * Generate named components from zod schemas, each nested schema that is itself named written as a
 * `$ref` to its own component. Two names for one zod schema make the second an alias of the first.
 */
function generate(
  io: "input" | "output",
  named: Record<string, z.ZodType>,
): Record<string, Schema> {
  const registry = z.registry<{ id: string }>();
  const aliases: Record<string, Schema> = {};
  for (const [id, schema] of Object.entries(named)) {
    const existing = registry.get(schema);
    if (existing) aliases[id] = ref(existing.id);
    else registry.add(schema, { id });
  }
  const { schemas } = z.toJSONSchema(registry, {
    target: "draft-2020-12",
    io,
    uri: (id) => `#/components/schemas/${id}`,
  });
  const generated = Object.fromEntries(
    Object.entries(schemas).map(([id, { $schema: _dialect, $id: _id, ...schema }]) => [
      id,
      schema as Schema,
    ]),
  );
  return { ...generated, ...aliases };
}

/** Every component schema: the responses, the requests, the signed ops' params and the refusal. */
function componentSchemas(): Record<string, Schema> {
  const params: Record<string, z.ZodType> = {};
  for (const op of Object.values(SIGNED_ROUTES).flat() as SignedOp[]) {
    if (op.params === undefined) continue;
    const name = paramsComponent(op);
    if (params[name] !== undefined && params[name] !== op.params) {
      throw new Error(`two params schemas are named ${name}`);
    }
    params[name] = op.params;
  }
  const output = generate("output", {
    ...RESPONSE_SCHEMAS,
    ...SHARED_SCHEMAS,
    Refusal: refusalSchema(),
  });
  const input = generate("input", { ...REQUEST_SCHEMAS, ...params, ...SHARED_SCHEMAS });
  for (const name of Object.keys(SHARED_SCHEMAS)) {
    if (JSON.stringify(input[name]) !== JSON.stringify(output[name])) {
      throw new Error(`${name} reads differently as input and as output; name the two apart`);
    }
  }
  return { ...output, ...input };
}

/** The 404 codes that fall back to `unknownRoute` (core's `NOT_FOUND_FALLBACKS`), as a list for the docs. */
const NOT_FOUND_CODE_LIST = Object.keys(NOT_FOUND_FALLBACKS)
  .map((code) => `\`${code}\``)
  .join(", ");

/** What each code the core protocol defines means, in its order, for the `Refusal` schema. */
const CORE_CODES = {
  badsig: "The signature does not verify.",
  invalid:
    "The body, the envelope or its params are malformed. `fields` names the keys this server " +
    "does not know when those keys are the only problem.",
  unknownRoom: "The room is gone or never existed.",
  expired: "The room has closed.",
  denied:
    "The caller may not do this. The account is blocked, the room's policy does not allow the op " +
    "for this player, or the signer is not on `BEACON_ADMINS`.",
  gameNotAdmitted: "This server does not admit the envelope's game, or the envelope names no game.",
  phase: "The room's current phase does not allow the op.",
  full: "The room has reached its capacity.",
  gone: "The item was already taken or claimed.",
  empty: "The room has nothing to take.",
  locked: "The time window is not open. This server answers `phase` for that case instead.",
  rateLimited: "The caller went over a rate limit.",
  stale: "The envelope's `baseVersion` is no longer the room's version, or a profile is older.",
  deviceRevoked: "The account revoked the signing device.",
  clockSkew: "The envelope's `issuedAt` is more than five minutes from the server's clock.",
  gameNotAccepted: "This room does not open the op to the envelope's game.",
  notMember:
    "The server's `accessLevel` is `request` or `private`, and the signer is not a member. " +
    "`denied` to a client that has not declared this code.",
  unknownRoute:
    "No route serves the path, or the capability that serves the path is turned off. A 404 that " +
    `names a missing thing (${NOT_FOUND_CODE_LIST}) is \`unknownRoute\` to a client that has not ` +
    "declared that code.",
  unknownPlace: "No active place has that `unique`.",
  unknownMedia: "No media has that hash, or a proposal names media this server does not store.",
  unknownProposal: "No proposal has that id.",
  unknownRun: "No run has that id.",
  noAbout: "The operator has set no about text.",
} satisfies Record<ErrorCode, string>;

/** Every code this server refuses with over HTTP: the core protocol's, then its own. */
export const REFUSAL_CODES: Readonly<Record<string, string>> = {
  ...CORE_CODES,
  tooLarge: "The body, or a value in the body, is over the server's limit.",
  replayed: "The nonce was used before by a signed read.",
  conflict:
    "The server's state refuses the request: another account holds the room id, or a backup or " +
    "restore is already running.",
  writeLocked: "The server is locked read-only. Try again after the `Retry-After` interval.",
  invalidPair: "The `subcategory` is not a curated slug of the `category`.",
  tooManyPending:
    "The account already has as many proposals awaiting review as the server allows. A state " +
    "refusal (409): it clears when an operator reviews one, so retrying does not help.",
  unsupportedType: "This server does not take the media type.",
  hashMismatch: "The bytes do not match the signed hash.",
  metadataPresent: "The image carries EXIF or GPS metadata. Strip the metadata and upload again.",
  quotaExceeded: "The account's media quota or the server's storage is full.",
  upstreamUnavailable: "The geocoder this server proxies did not answer.",
  unknownProfile: "No profile for that account is published to this server.",
};

/**
 * The `{ ok: false, error, message?, fields? }` body every refusal carries: the core protocol's
 * error result, its `error` a string rather than a closed list. The codes are documented, but a
 * newer server may add one in a minor release, and a generated client must read that as a refusal
 * it does not know rather than reject the body.
 */
function refusalSchema(): z.ZodType {
  return errorResultSchema
    .extend({
      error: z.string().meta({
        description:
          "The refusal's code. These are the codes this server sends; a newer server may add " +
          "codes, so read an unknown one as a refusal you have no special handling for.\n\n" +
          Object.entries(REFUSAL_CODES)
            .map(([code, meaning]) => `- \`${code}\`: ${meaning}`)
            .join("\n"),
        examples: Object.keys(REFUSAL_CODES),
      }),
    })
    .meta({
      description:
        `A refusal. The server sends ${Object.keys(CODE_FALLBACKS)
          .map((code) => `\`${code}\``)
          .join(", ")} only to a client that declares the code in the \`${UNDERSTANDS_HEADER}\` ` +
        "header, as `code:<name>`. Any other client gets the older code in its place: " +
        Object.entries(CODE_FALLBACKS)
          .map(([code, fallback]) => `\`${fallback}\` for \`${code}\``)
          .join(", ") +
        `, and \`unknownRoute\` for a 404 ${NOT_FOUND_CODE_LIST}. ` +
        "Every other code goes to every client.",
    });
}

/** `{ content: { application/json: { schema } } }`. */
const jsonContent = (schema: unknown) => ({ content: { "application/json": { schema } } });
/** A required JSON request body. */
const jsonBody = (schema: unknown, description?: string) => ({
  required: true,
  ...(description === undefined ? {} : { description }),
  ...jsonContent(schema),
});
/** A response with a description, and a JSON body when there is a schema. */
const res = (description: string, schema?: unknown) => ({
  description,
  ...(schema ? jsonContent(schema) : {}),
});
/** An `{ ok: true, ...props }` answer: how a signed route wraps its payload. */
const okWith = (props: Record<string, unknown>, optional: readonly string[] = []): Schema => ({
  type: "object",
  required: ["ok", ...Object.keys(props).filter((key) => !optional.includes(key))],
  properties: { ok: { const: true }, ...props },
});
/** An array of a component. */
const listOf = (name: string): Schema => ({ type: "array", items: ref(name) });
/** A query/path parameter. */
const param = (
  name: string,
  location: "query" | "path",
  opts: { required?: boolean; description?: string; example?: string } = {},
) => ({
  name,
  in: location,
  required: opts.required ?? location === "path",
  schema: { type: "string", ...(opts.example ? { examples: [opts.example] } : {}) },
  ...(opts.description ? { description: opts.description } : {}),
});

/** `Opt-in capability (BEACON_X): routes 404 when disabled.` */
const optIn = (flag: string) => `Opt-in capability (\`${flag}\`): routes 404 when disabled.`;

/** A status a route may refuse with. */
type RefusalStatus = "400" | "401" | "403" | "404" | "409" | "413" | "415" | "422" | "429" | "503";
type Refusals = Partial<Record<RefusalStatus, string>>;

/** Refusals many routes answer word for word, written once under `components.responses`. */
const SHARED_RESPONSES = {
  BadSignature: "The signature does not verify (`badsig`).",
  TooLarge: "The body is over the server's size limit (`tooLarge`).",
  UnsupportedBody: "The server does not take the body's charset or content encoding (`invalid`).",
  WriteLocked:
    "The server is locked read-only (`writeLocked`). The answer carries a `Retry-After` header.",
  WriteRateLimited: "The client went over the write rate limit (`rateLimited`).",
  ReadRateLimited: "The client went over the read rate limit (`rateLimited`).",
  SignedReadRateLimited: "The client went over the signed-read rate limit (`rateLimited`).",
} as const;

/** What a JSON body can be refused for before any route sees the body, beside a 400 `invalid`. */
const JSON_BODY_REFUSALS: Refusals = {
  "413": SHARED_RESPONSES.TooLarge,
  "415": SHARED_RESPONSES.UnsupportedBody,
};

/** The 400 every signed route can answer, for a JSON body or a raw one. */
const signedMalformed = (json: boolean): Refusals => ({
  "400":
    `${json ? "The body is not JSON, the envelope" : "The envelope"} or its params are ` +
    "malformed, or the op is not one this route takes (`invalid`); `fields` names the keys this " +
    "server does not know when those are the only problem. An `issuedAt` more than five minutes " +
    "from the server's clock answers `clockSkew`.",
});

/** What every signed route can be refused for, beside the 400. */
const SIGNED_REFUSALS: Refusals = {
  "401": SHARED_RESPONSES.BadSignature,
  "403":
    "The server blocked the account (`denied`), or the account revoked the signing device " +
    "(`deviceRevoked`).",
};

/** What the operator gate adds. */
const ADMIN_REFUSALS: Refusals = {
  "403": "The signer is not on `BEACON_ADMINS` (`denied`).",
  "404": "No admins are configured (`unknownRoute`).",
};

const NONCE_OF_A_READ: Refusals = {
  "409": "A signed read already used the nonce (`replayed`).",
};
const LIMITED_WRITE: Refusals = { "429": SHARED_RESPONSES.WriteRateLimited };
const LIMITED_READ: Refusals = { "429": SHARED_RESPONSES.ReadRateLimited };
const LIMITED_SIGNED_READ: Refusals = { "429": SHARED_RESPONSES.SignedReadRateLimited };
const LOCKED: Refusals = { "503": SHARED_RESPONSES.WriteLocked };

/**
 * Each refusal as a response, the sentences for one status joined in order. A refusal that reads
 * the same as a shared one is a `$ref` to it.
 */
function refusals(...sets: Refusals[]): Record<string, unknown> {
  const merged: Record<string, string[]> = {};
  for (const set of sets) {
    for (const [status, sentence] of Object.entries(set)) (merged[status] ??= []).push(sentence);
  }
  return Object.fromEntries(
    Object.entries(merged).map(([status, sentences]) => {
      const description = sentences.join(" ");
      const shared = Object.entries(SHARED_RESPONSES).find(([, text]) => text === description)?.[0];
      return [
        status,
        shared ? { $ref: `#/components/responses/${shared}` } : res(description, ref("Refusal")),
      ];
    }),
  );
}

/** Responses in status order, so the document reads top to bottom. */
function byStatus(responses: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(responses).sort(([a], [b]) => a.localeCompare(b)));
}

/** How one route is documented. */
interface RouteDoc {
  tags: [string];
  summary: string;
  description?: string;
  parameters?: unknown[];
  /** The success answer: 201 for a POST (Nest's default), 200 for a GET. */
  ok: { description: string; schema?: unknown };
  /** What this route refuses for, beyond what its kind of route always can. */
  refusals?: Refusals;
  /** The route has a rate-limit guard. */
  limited?: boolean;
}

/** How one signed route is documented. */
interface SignedDoc extends RouteDoc {
  /**
   * The route is idempotent by envelope nonce, so a retry gets the first answer, and a nonce a
   * signed read used answers 409 `replayed`.
   */
  idempotent?: boolean;
  /** The route answers while the server is locked read-only (`@AllowWhileLocked`). */
  allowWhileLocked?: boolean;
  /** The route is a signed read with the signed-read rate-limit guard. */
  readLimited?: boolean;
  /** The route is a write a server at `request` or `private` takes from members only. */
  membersOnly?: boolean;
}

/** An unsigned GET route. */
function get(doc: RouteDoc) {
  return {
    get: {
      tags: doc.tags,
      summary: doc.summary,
      ...(doc.description ? { description: doc.description } : {}),
      ...(doc.parameters ? { parameters: doc.parameters } : {}),
      responses: byStatus({
        "200": res(doc.ok.description, doc.ok.schema),
        ...refusals(doc.refusals ?? {}, doc.limited ? LIMITED_READ : {}),
      }),
    },
  };
}

/**
 * The signed envelope a route takes, `op` fixed to the route's op name and `params` pointing at the
 * params schema. A route serving several ops takes any of them. Ops whose params the server does
 * not define share one branch, their names an enum.
 */
function signedEnvelope(path: SignedPath): Schema {
  const ops = opsOf(path);
  // A room op names its room, which must be the one in the path.
  const room = ops.some((op) => op.policyParams) ? { required: ["room"] } : {};
  const variant = (op: unknown, params: unknown): Schema => ({
    allOf: [ref("OpEnvelope"), { type: "object", properties: { op, params }, ...room }],
  });
  const branches = ops
    .filter((op) => op.params !== undefined)
    .map((op) => variant({ const: op.op }, ref(paramsComponent(op))));
  const open = ops.filter((op) => op.params === undefined).map((op) => op.op);
  if (open.length > 0) {
    branches.push(
      variant(open.length === 1 ? { const: open[0] } : { enum: open }, {
        type: "object",
        description: ops.some((op) => op.policyParams)
          ? "The params the room's policy defines for the op."
          : "The server reads no params.",
      }),
    );
  }
  return branches.length === 1 ? branches[0]! : { oneOf: branches };
}

/** The op names a signed route takes, for its request's description. */
function opNames(path: SignedPath): string {
  const names = opsOf(path).map((op) => `\`${op.op}\``);
  return names.length === 1 ? `op ${names[0]}` : `ops ${names.join(", ")}`;
}

/**
 * An operation's `operationId`, from its method and OpenAPI path: `POST /places/admin/edit` →
 * `postPlacesAdminEdit`, `GET /rooms/{id}` → `getRoomsById`. Derived rather than written per route,
 * so every route has one, two routes cannot share one (a method and path are unique), and the names
 * a client generator builds on cannot drift from the routes. Renaming a route renames its
 * operation, which is the honest outcome: the route a generated client called is gone either way.
 */
export function operationId(method: string, path: string): string {
  const words = path
    .split("/")
    .filter((segment) => segment !== "")
    .flatMap((segment) => {
      const param = /^\{(\w+)\}$/.exec(segment);
      return param ? ["by", param[1]!] : segment.split(/[^A-Za-z0-9]+/);
    });
  return method + words.map(upperFirst).join("");
}

/** The paths with each operation's {@link operationId} put first in it. */
function withOperationIds(paths: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(paths).map(([path, item]) => [
      path,
      Object.fromEntries(
        Object.entries(item as Record<string, object>).map(([method, operation]) => [
          method,
          { operationId: operationId(method, path), ...operation },
        ]),
      ),
    ]),
  );
}

/** The OpenAPI path for a mounted Nest path: `rooms/:id/ops` → `/rooms/{id}/ops`. */
export const openApiPath = (path: string): string => `/${path.replace(/:(\w+)/g, "{$1}")}`;

/** The operator routes, which sit behind `AdminGate`: everything under `admin/` and `places/admin/`. */
const isAdmin = (path: SignedPath): boolean => /^(places\/)?admin\//.test(path);

/**
 * A signed POST route, its request body built from {@link SIGNED_ROUTES}. `body` replaces the JSON
 * envelope body for a route whose envelope travels elsewhere; `raw` says the body is not JSON.
 */
function signed(
  path: SignedPath,
  doc: SignedDoc,
  body: { requestBody?: unknown; raw?: boolean } = {},
) {
  return {
    [openApiPath(path)]: {
      post: {
        tags: doc.tags,
        summary: doc.summary,
        ...(doc.description ? { description: doc.description } : {}),
        ...(doc.parameters ? { parameters: doc.parameters } : {}),
        requestBody:
          body.requestBody ??
          jsonBody(signedEnvelope(path), `A signed \`OpEnvelope\` carrying ${opNames(path)}.`),
        responses: byStatus({
          "201": res(doc.ok.description, doc.ok.schema),
          ...refusals(
            signedMalformed(!body.raw),
            body.raw ? {} : JSON_BODY_REFUSALS,
            SIGNED_REFUSALS,
            isAdmin(path) ? ADMIN_REFUSALS : {},
            doc.refusals ?? {},
            doc.membersOnly ? NOT_MEMBER : {},
            doc.idempotent ? NONCE_OF_A_READ : {},
            doc.limited ? LIMITED_WRITE : {},
            doc.readLimited ? LIMITED_SIGNED_READ : {},
            doc.allowWhileLocked ? {} : LOCKED,
          ),
        }),
      },
    },
  };
}

/** How a signed request is made, for the document's description. */
const SIGNING =
  "## Signed requests\n\n" +
  "Every request that changes state, and every signed read, carries a signed `OpEnvelope`: the " +
  "op name and its `params`, the acting account (`actor`), the device key that signs " +
  "(`device`) with the account's authorization of that key (`auth`), a `nonce`, the issue time, " +
  "and `sig`, an Ed25519 signature by `device` over the canonical JSON (RFC 8785) of the envelope " +
  "without `sig`. The server answers a bad signature with 401 `badsig`, and an envelope issued " +
  "outside its replay window with 400 `clockSkew`. A game's envelope names its game slug, and the " +
  "operator routes take envelopes from a key on the server's admin allowlist. The envelope is " +
  "the JSON body, except on `POST /media`, which wraps the envelope beside the bytes, and on " +
  "`POST /places/admin/atlas/upload`, which takes the envelope in a header. `POST /profiles` " +
  "takes a profile doc, which the account signs itself.\n\n" +
  "Each signed route's request body fixes `op` to the op names the route takes and points " +
  "`params` at the schema the server parses them with. `POST /rooms/{id}/ops` lists its op names " +
  "only: the params of a room op are what the room's policy says they are.\n\n" +
  "The signature is computed on the client, so this page cannot send a signed request. Use the " +
  "client SDK (`@beaconsgg/client-sdk`), which builds and signs envelopes, and the signing guide " +
  "in the Beacon documentation. The unsigned GET routes can be tried from here.";

/** What a refusal looks like, for the document's description. */
const REFUSALS =
  "## Refusals\n\n" +
  "A refusal carries the JSON body `{ ok: false, error, message?, fields? }` (the `Refusal` " +
  "schema), " +
  "where `error` is a code a client can act on. A path no route serves answers 404 " +
  "`unknownRoute`, a request body over the server's limit answers 413 `tooLarge`, and a body the " +
  "server cannot read answers `invalid`: a 400 for one that is not JSON, a 415 for a charset or " +
  "an encoding it does not take. A reply without that body, such as a reverse proxy's error " +
  "page, is not the server's refusal.";

/**
 * The spec as published for the docs and for client generators, committed as `openapi.json`: no
 * particular server, so its one server entry is a template whose host the reader fills in. Its
 * version says unreleased; a release stamps its own.
 */
export function publishedOpenApiDocument(): OpenApiDocument {
  return buildOpenApiDocument({ name: "Beacon server", version: "unreleased" }, [
    {
      url: "https://{host}",
      description: "A Beacon server",
      variables: { host: { default: "beacon.example", description: "the server's host name" } },
    },
  ]);
}

/** The spec a running server serves, naming itself as the one server. */
export function serverOpenApiDocument(config: ServerConfig): OpenApiDocument {
  return buildOpenApiDocument(config, [{ url: config.publicUrl }]);
}

const PLACES_OFF: Refusals = { "404": "The places capability is off (`unknownRoute`)." };
const MAILBOX_OFF: Refusals = { "404": "The mailbox capability is off (`unknownRoute`)." };
const PLACE_DETAIL = okWith({ place: ref("PlaceDetail") });
const NO_GAME: Refusals = { "403": "The envelope names no game (`gameNotAdmitted`)." };
const GAME_NOT_ADMITTED: Refusals = {
  "403":
    "This server does not take the envelope's game, or the envelope names none (`gameNotAdmitted`).",
};
const REPLAYED: Refusals = { "409": "The nonce was used before (`replayed`)." };
const NOT_MEMBER: Refusals = {
  "403":
    "The server's `accessLevel` is `request` or `private` and the signer is not a member " +
    "(`notMember`).",
};
const REMOVED = okWith({ removed: { type: "boolean" } });

function buildOpenApiDocument(
  info: Pick<ServerConfig, "name" | "version">,
  servers: OpenApiServer[],
): OpenApiDocument {
  return {
    openapi: "3.1.0",
    info: {
      title: info.name,
      version: info.version,
      description:
        "The Beacon server's REST API. The server verifies identity and signatures, and never " +
        "judges a gameplay claim. Every state-changing op is a signed `OpEnvelope` POSTed over " +
        "REST; the socket.io live and map channels are server-to-client events, described in the " +
        "API reference rather than here. Some routes are opt-in capabilities that answer 404 while " +
        "their setting is off.\n\n" +
        REFUSALS +
        "\n\n" +
        SIGNING,
    },
    servers,
    tags: [
      { name: "health", description: "Liveness and readiness probes" },
      { name: "discovery", description: "Spatial discovery and the signed server descriptor" },
      {
        name: "rooms",
        description: "Rooms: shared state under a signed policy, changed by signed ops",
      },
      { name: "scouts", description: "Single-writer advertised scout movement (signed relay)" },
      { name: "profiles", description: "Self-signed profile docs and device revocation" },
      { name: "access", description: "Asking to join a server that takes members only" },
      { name: "mailbox", description: "Per-recipient notification drop (opt-in)" },
      { name: "media", description: "Content-addressed media store (opt-in)" },
      { name: "geocode", description: "Geohash to neighborhood, city, state and country (opt-in)" },
      { name: "places", description: "The server's place dataset by geohash cell (opt-in)" },
      {
        name: "admin",
        description:
          "The operator surface the console uses: signed by a key on `BEACON_ADMINS`, 404 when none is configured",
      },
    ],
    paths: withOperationIds({
      "/health": get({
        tags: ["health"],
        summary: "Liveness probe",
        ok: {
          description: "The process is up.",
          schema: okStatus("ok"),
        },
      }),
      "/health/ready": {
        get: {
          tags: ["health"],
          summary: "Readiness probe (store reachable)",
          responses: {
            "200": res("The store answers.", okStatus("ready")),
            "503": res("The store does not answer.", {
              type: "object",
              required: ["status", "error"],
              properties: { status: { const: "not-ready" }, error: { type: "string" } },
            }),
          },
        },
      },
      "/discovery": get({
        tags: ["discovery"],
        summary: "Anonymous spatial discovery over geohash cells",
        parameters: [
          param("cells", "query", {
            required: true,
            description: "comma-separated geohash cells",
            example: "9q8yy,9q8yz",
          }),
          param("types", "query", { description: "comma-separated room types to keep" }),
          param("games", "query", {
            description:
              "game slugs: only rooms these games own or may act on, and only their scouts. Absent: every game's",
          }),
        ],
        ok: {
          description: "rooms and scouts in the queried cells",
          schema: ref("DiscoveryResponse"),
        },
        refusals: { "400": "The `cells`, `types` or `games` are invalid (`invalid`)." },
        limited: true,
      }),
      "/server/descriptor": get({
        tags: ["discovery"],
        summary: "Signed server coverage advertisement (identity, coverage, capabilities)",
        ok: { description: "descriptor", schema: ref("ServerDescriptor") },
        limited: true,
      }),
      "/server/about": get({
        tags: ["discovery"],
        summary: "The operator's long description of the server, as Markdown (unsigned)",
        ok: {
          description: "`{ about, updated }`: the Markdown text and when it was last set",
          schema: {
            type: "object",
            required: ["about", "updated"],
            properties: {
              about: { type: "string", maxLength: MAX_ABOUT_LENGTH },
              updated: { type: "string", format: "date-time" },
            },
          },
        },
        refusals: { "404": "The operator has set no about text (`noAbout`)." },
        limited: true,
      }),
      ...signed("rooms", {
        membersOnly: true,
        tags: ["rooms"],
        summary: "Place a room from a signed place op (idempotent by nonce)",
        ok: {
          description: "The room is placed, or was already placed by this nonce.",
          schema: okWith({
            id: { type: "string", description: "`unique@host`" },
            version: { type: "integer" },
            room: ref("Room"),
          }),
        },
        refusals: {
          "400":
            "A policy rule is invalid, the provenance of the room or of a seeded item does not " +
            "verify, or the starting state is out of range (`invalid`).",
          ...GAME_NOT_ADMITTED,
          "409": "Another account already placed a room with this `unique` (`conflict`).",
          "429": "The account went over its write budget (`rateLimited`).",
        },
        limited: true,
      }),
      "/rooms/{id}": get({
        tags: ["rooms"],
        summary: "Resolve current room state",
        parameters: [
          param("id", "path", { description: "unique@host" }),
          param("games", "query", {
            description: "game slugs: the room only if one of them owns it or may act on it",
          }),
        ],
        ok: { description: "room", schema: ref("Room") },
        refusals: {
          "400": "The `games` are invalid (`invalid`).",
          "404": "The room is unknown, or not open to the listed games (`unknownRoom`).",
        },
        limited: true,
      }),
      ...signed("rooms/:id/ops", {
        membersOnly: true,
        tags: ["rooms"],
        summary: "Apply a signed op to a room",
        description:
          "The room engine verifies and applies the op. The op names are the ones the engine " +
          "handles; the room's policy decides which of them the room takes, who may send each " +
          "and what its params are.",
        parameters: [param("id", "path", { description: "unique@host" })],
        ok: { description: "The op's result.", schema: ref("OkResult") },
        refusals: {
          "400": "The envelope's `room` does not match the URL (`invalid`).",
          "403":
            "The room's policy has no such op or does not allow the player to send it (`denied`), this server " +
            "does not admit the envelope's game or the envelope names none (`gameNotAdmitted`), or " +
            "this room does not open the op to the game (`gameNotAccepted`).",
          "404": "The room is unknown (`unknownRoom`) or has closed (`expired`).",
          "409": "The room's state refuses the op: `phase`, `full`, `gone`, `empty` or `stale`.",
          "429": "The account went over its budget for room ops (`rateLimited`).",
        },
        limited: true,
      }),
      ...signed("scouts", {
        membersOnly: true,
        tags: ["scouts"],
        summary: "Relay a signed scout report (deploy / heartbeat) or cancel",
        ok: {
          description: "Relayed. A report answers with the scout's `unique` as `id`.",
          schema: okWith({ id: { type: "string" } }, ["id"]),
        },
        refusals: {
          "400":
            "The scout's provenance does not verify, or its lifetime is out of range (`invalid`).",
          "403":
            "This server does not admit the envelope's game, or the envelope names none " +
            "(`gameNotAdmitted`). Another account owns the scout (`denied`).",
          "429": "The account went over its relay budget (`rateLimited`).",
        },
        limited: true,
      }),
      "/profiles": {
        post: {
          tags: ["profiles"],
          summary: "Publish a self-signed profile doc (high-water by version)",
          requestBody: jsonBody(ref("ProfileDoc")),
          responses: byStatus({
            "201": res(
              "The profile is accepted.",
              okWith({ id: { type: "string" }, version: { type: "integer" } }),
            ),
            ...refusals(
              JSON_BODY_REFUSALS,
              {
                "400":
                  "The body is not JSON, not a profile doc, or its signature fails (`invalid`).",
                "403": "The server blocked the account (`denied`).",
                "409": "The profile is older than the stored version (`stale`).",
                "413": `The profile is over ${MAX_PROFILE_BYTES} bytes of canonical JSON (\`tooLarge\`).`,
              },
              LIMITED_WRITE,
              LOCKED,
            ),
          }),
        },
      },
      "/profiles/{id}": get({
        tags: ["profiles"],
        summary: "Resolve a published profile doc by account DID",
        parameters: [param("id", "path", { description: "account did:key" })],
        ok: { description: "profile", schema: ref("ProfileDoc") },
        refusals: {
          "404": "No profile for the account is published to this server (`unknownProfile`).",
        },
        limited: true,
      }),
      ...signed("mailbox", {
        membersOnly: true,
        tags: ["mailbox"],
        idempotent: true,
        summary: "Send a signed message to a recipient DID",
        description: optIn("BEACON_MAILBOX"),
        ok: { description: "stored", schema: okWith({ id: { type: "string" } }) },
        refusals: {
          ...GAME_NOT_ADMITTED,
          ...MAILBOX_OFF,
          "413": "The message body is over the server's limit (`tooLarge`).",
          "429": "The account went over its send rate (`rateLimited`).",
        },
        limited: true,
      }),
      ...signed("mailbox/fetch", {
        tags: ["mailbox"],
        summary: "Authenticated read of the caller's messages",
        description: optIn("BEACON_MAILBOX"),
        ok: {
          description: "the verified reader's messages from the envelope's game",
          schema: okWith({ messages: listOf("MailboxMessage") }),
        },
        refusals: {
          ...NO_GAME,
          ...MAILBOX_OFF,
          ...REPLAYED,
        },
        readLimited: true,
      }),
      ...signed("mailbox/ack", {
        tags: ["mailbox"],
        idempotent: true,
        summary: "Delete delivered messages by id",
        description: optIn("BEACON_MAILBOX"),
        ok: {
          description: "acked (the envelope's game's messages only)",
          schema: okWith({ deleted: { type: "integer" } }),
        },
        refusals: { ...NO_GAME, ...MAILBOX_OFF },
        limited: true,
      }),
      ...signed(
        "media",
        {
          tags: ["media"],
          idempotent: true,
          membersOnly: true,
          summary: "Upload content-addressed media (a signed attestation and the base64 bytes)",
          description: `${optIn("BEACON_MEDIA")} The body is a \`MediaUpload\`: the signed envelope in \`env\` and the base64 bytes in \`data\`.`,
          ok: {
            description: "Stored, or already stored. `id` is `<hash>@host`.",
            schema: okWith({ id: { type: "string" } }),
          },
          refusals: {
            "400":
              "The bytes do not match the declared size (`invalid`) or the signed hash (`hashMismatch`).",
            "403":
              "This server does not take the envelope's game, or the envelope names none " +
              "(`gameNotAdmitted`). An envelope from an operator may name no game.",
            "404": "The media capability is off (`unknownRoute`).",
            "413":
              "The media is over the size limit (`tooLarge`), or over the account's quota or the " +
              "server's storage (`quotaExceeded`).",
            "415": "The media type is not allowed (`unsupportedType`).",
            "422": "The image carries EXIF or GPS metadata (`metadataPresent`).",
            "429": "The account went over its upload rate (`rateLimited`).",
          },
          limited: true,
        },
        {
          requestBody: jsonBody(
            {
              allOf: [
                ref("MediaUpload"),
                { type: "object", properties: { env: signedEnvelope("media") } },
              ],
            },
            `A \`MediaUpload\` whose \`env\` is a signed \`OpEnvelope\` carrying ${opNames("media")}.`,
          ),
        },
      ),
      "/media/{hash}": {
        get: {
          tags: ["media"],
          summary: "Public content-addressed fetch (streams bytes or 302-redirects to a CDN)",
          description: optIn("BEACON_MEDIA"),
          parameters: [param("hash", "path", { description: "sha256 base64url content id" })],
          responses: byStatus({
            "200": { description: "the media bytes (immutable-cached)", content: { "*/*": {} } },
            "302": res("redirect to CDN"),
            ...refusals(
              {
                "404":
                  "The media capability is off (`unknownRoute`), or no media has that hash " +
                  "(`unknownMedia`).",
              },
              LIMITED_READ,
            ),
          }),
        },
      },
      "/geocode": get({
        tags: ["geocode"],
        summary: "Reverse-geocode a geohash to a neighborhood, city, state and country label",
        description:
          `${optIn("BEACON_GEOCODE")} Proxies a geocoder (Nominatim) with a server-side cache. ` +
          "The `neighborhood` field is omitted for a cache cell coarser than geohash-7 (about 150 m), " +
          "whose center can sit in a different neighborhood than the point that asked, so the " +
          "precision of the answer follows the precision of the geohash you send.",
        parameters: [param("geohash", "query", { required: true, example: "9q8yyk8" })],
        ok: { description: "place label", schema: ref("GeocodeResult") },
        refusals: {
          "400": "The `geohash` is not a valid geohash cell (`invalid`).",
          "404": "The geocode capability is off (`unknownRoute`).",
          "503": "The upstream geocoder did not answer (`upstreamUnavailable`).",
        },
        limited: true,
      }),
      "/places/taxonomy": get({
        tags: ["places"],
        summary: "The curated vocabulary of categories and their subcategories",
        description: `${optIn("BEACON_PLACES")} What a contribution UI renders its pickers from, and what \`places.propose\` fences new-place submissions to. Slugs are **namespaced per category**: always read the pair. Derived from the server's tag map, so it changes only when an operator edits it; freely cacheable. Display labels are a game concern.`,
        ok: { description: "the vocabulary", schema: ref("PlaceTaxonomy") },
        refusals: PLACES_OFF,
        limited: true,
      }),
      "/places": get({
        tags: ["places"],
        summary: "Places from the server's owned dataset within the queried cells",
        description: `${optIn("BEACON_PLACES")} Serves the curated place dataset, always from the server's own store, never proxied. Multi-cell CSV query (the discovery shape) with optional taxonomy \`categories\` filter. Keyset-paginated: a full page returns a \`cursor\`; re-query with \`?cursor=<cursor>\` (same \`cells\`/\`categories\`) to fetch the next page.`,
        parameters: [
          param("cells", "query", { required: true, example: "c23nb,c23nc" }),
          param("categories", "query", { example: "park,nature" }),
          param("cursor", "query", {
            description: "keyset cursor: a prior page's `cursor` (a place ULID)",
            example: "01J2X6M0R9V8Q4T5N7B3C1D2E4",
          }),
          param("limit", "query", {
            description: "page size (clamped to the server max)",
            example: "1000",
          }),
          param("spread", "query", {
            description:
              "`1` samples one page evenly across the cells instead of taking the lowest ids. A " +
              "spread page has no `cursor`, and a request may not send both.",
            example: "1",
          }),
        ],
        ok: { description: "places in the queried cells", schema: ref("PlacesQueryResult") },
        refusals: {
          "400":
            "A query parameter is invalid: a cell's charset or precision, the count of cells or " +
            "categories, a `cursor` that is not a ULID, a `limit` that is not a positive integer, " +
            "or a `spread` other than `1` or beside a `cursor` (`invalid`).",
          ...PLACES_OFF,
        },
        limited: true,
      }),
      "/places/{unique}": get({
        tags: ["places"],
        summary: "One place with its full geometry and provenance",
        description:
          "Pass `?contributors=1` to include the DIDs of players whose approved contribution to " +
          "this place asked to be credited. Opt-in because `PlaceDetail` is strict: a client that " +
          "doesn't ask never receives the key, so the field could ship ahead of the apps that read it.",
        parameters: [
          param("unique", "path", { required: true, example: "01J2X6M0R9V8Q4T5N7B3C1D2E4" }),
          param("contributors", "query", { example: "1" }),
        ],
        ok: { description: "the place detail", schema: ref("PlaceDetail") },
        refusals: {
          "400": "The `unique` is not a ULID (`invalid`).",
          "404":
            "The places capability is off (`unknownRoute`), or no active place has that " +
            "`unique` (`unknownPlace`).",
        },
        limited: true,
      }),
      ...signed("places/admin/sources/retire", {
        tags: ["places"],
        idempotent: true,
        summary: "Close out a source that is no longer an input (signed, operator-allowlisted)",
        description: `${optIn("BEACON_PLACES")} Marks every live record of the named source gone as a durable run: the migration path for legacy connector residue (\`osm\`), refused for the living inputs (\`admin\`, \`contrib\`, \`list:*\`, \`atlas:*\`). Run it after importing the Atlas volumes that cover the region, so adoption has already carried place identity. Idempotent by envelope nonce.`,
        ok: {
          description: "the queued retire run",
          schema: okWith({ snapshot: ref("PlaceSnapshot") }),
        },
        refusals: { "400": "The source is a living input (`invalid`).", ...PLACES_OFF },
        limited: true,
      }),
      ...signed("places/admin/export", {
        tags: ["places"],
        summary: "Export the dataset (or a boundary's slice) as a GeoJSON FeatureCollection",
        description: `${optIn("BEACON_PLACES")} A signed read from an allowlisted key. The interchange file for setting up, moving, or sharing lists across servers; dataset attribution travels in the beacon block.`,
        ok: {
          description: "the interchange file",
          schema: okWith({ collection: ref("PlaceExport") }),
        },
        refusals: { ...PLACES_OFF, ...REPLAYED },
      }),
      ...signed("places/admin/contrib/export", {
        tags: ["places"],
        summary: "Export the approved player contributions (signed read)",
        description: `${optIn("BEACON_PLACES")} An optional \`boundary\` limits the export. The approved contributions this server holds, as a FeatureCollection, so they can be shared with another dataset. Off unless the operator turns on \`BEACON_PLACES_PROPOSALS_EXPORT\`: player-derived data leaves the server only by that choice, and while it is off the route answers 404.`,
        ok: {
          description: "the contributions",
          schema: okWith({ collection: ref("PlaceExport") }),
        },
        refusals: {
          "404": "The places capability or the contribution export is off (`unknownRoute`).",
          ...REPLAYED,
        },
      }),
      ...signed("places/admin/import", {
        tags: ["places"],
        idempotent: true,
        summary: "Import a FeatureCollection as a list:<name> source (queued run)",
        description: `${optIn("BEACON_PLACES")} Signed by an allowlisted key. Replace-the-list semantics; features keep their unique (re-import updates in place); media re-hosted by hash-verified transfer when the media capability is on.`,
        ok: {
          description: "the queued import run",
          schema: okWith({ snapshot: ref("PlaceSnapshot") }),
        },
        refusals: { "400": "The collection is empty or refused (`invalid`).", ...PLACES_OFF },
        limited: true,
      }),
      ...signed("places/propose", {
        membersOnly: true,
        tags: ["places"],
        idempotent: true,
        summary: "Propose a new place, or descriptor fields for one that exists",
        description: `${optIn("BEACON_PLACES_PROPOSALS")} A **signed player** request from any DID (this is not the operator surface), rate-limited per DID and capped on unreviewed backlog. Records a \`pending\` proposal and publishes **nothing**: an operator must approve it before it reaches any read path. A new place needs a valid \`(category, subcategory)\` pair; an improvement may only add \`name\`/\`description\`/\`website\`/\`media\`. Referenced media must already be stored on THIS server. Idempotent by envelope nonce.`,
        ok: {
          description: "the recorded proposal",
          schema: okWith({ proposal: ref("PlaceProposal") }),
        },
        refusals: {
          "400":
            "The category pair is not curated (`invalidPair`), the place is unknown " +
            "(`unknownPlace`), or the media is not stored here (`unknownMedia`).",
          ...GAME_NOT_ADMITTED,
          "404": "The places capability or submissions are off (`unknownRoute`).",
          "409":
            "The account has as many proposals awaiting review as the server allows " +
            "(`tooManyPending`). Not retryable: it clears when an operator reviews one.",
          "429": "The account went over its submission rate (`rateLimited`).",
        },
        limited: true,
      }),
      ...signed("places/proposals/fetch", {
        tags: ["places"],
        summary: "Your own submissions and their outcomes",
        description: `${optIn("BEACON_PLACES_PROPOSALS")} A signed read, scoped to the **verified actor**: there is deliberately no way to read anyone else's (a contribution ties a DID to a point in the world). Keyset-paginated, newest first.`,
        ok: {
          description: "your proposals",
          schema: okWith({ proposals: listOf("PlaceProposal") }),
        },
        refusals: {
          "404": "The places capability or submissions are off (`unknownRoute`).",
          ...REPLAYED,
        },
        readLimited: true,
      }),
      ...signed("places/admin/proposals/fetch", {
        tags: ["places"],
        summary: "The whole contribution review queue",
        description: `${optIn("BEACON_PLACES")} Signed by an allowlisted key. The unscoped view of the same op contributors use. Reachable whenever places is on, so closing submissions never strands a backlog.`,
        ok: {
          description: "pending and decided proposals",
          schema: okWith({ proposals: listOf("PlaceProposal") }),
        },
        refusals: { ...PLACES_OFF, ...REPLAYED },
      }),
      ...signed("places/admin/proposals/review", {
        tags: ["places"],
        idempotent: true,
        summary: "Approve or reject a contribution",
        description: `${optIn("BEACON_PLACES")} Signed by an allowlisted key. Approval lands the submission as a \`contrib\` source record (ranked above \`osm\`, below \`list:\`/\`admin\`); \`edits\` amends it first. Rejection writes nothing to the dataset. The stamp is conditional on \`pending\`, so the first decision stands.`,
        ok: {
          description: "the decided proposal",
          schema: okWith({ proposal: ref("PlaceProposal") }),
        },
        refusals: {
          "400": "The place the proposal improves has retired (`unknownPlace`).",
          "404":
            "The places capability is off (`unknownRoute`), or no proposal has that id " +
            "(`unknownProposal`).",
        },
        limited: true,
      }),
      ...signed("places/admin/create", {
        tags: ["places"],
        idempotent: true,
        summary: "Author a place by hand",
        description: `${optIn("BEACON_PLACES")} Signed by an allowlisted key. Mints a place from the given fields as an \`admin\` source: the operator counterpart to a connector snapshot, and the one way to add a place no connector produced. \`category\` and \`point\` are required; everything else is adjustable afterwards via \`places.edit\`.`,
        ok: {
          description: "the created place, as `GET /places/{unique}` reads it",
          schema: PLACE_DETAIL,
        },
        refusals: PLACES_OFF,
        limited: true,
      }),
      ...signed("places/admin/edit", {
        tags: ["places"],
        idempotent: true,
        summary: "Per-field admin edit (set overrides / clear them)",
        description: `${optIn("BEACON_PLACES")} Signed by an allowlisted key. Set fields become admin-held (merge-winning, conflict-protected); cleared fields flow back from the connectors.`,
        ok: {
          description:
            "the recomputed place, as `GET /places/{unique}` reads it (a retired place too)",
          schema: PLACE_DETAIL,
        },
        refusals: {
          "400": "The edit sets and clears nothing (`invalid`).",
          "404":
            "The places capability is off (`unknownRoute`), or no place has that `unique` " +
            "(`unknownPlace`).",
        },
        limited: true,
      }),
      ...signed("places/admin/conflicts/fetch", {
        tags: ["places"],
        summary: "The pending-revision queue (unresolved-first)",
        ok: {
          description: "conflict rows",
          schema: okWith({ conflicts: listOf("PlaceConflict") }),
        },
        refusals: { ...PLACES_OFF, ...REPLAYED },
      }),
      ...signed("places/admin/conflicts/resolve", {
        tags: ["places"],
        idempotent: true,
        summary: "Mark conflict rows reviewed (idempotent)",
        ok: {
          description: "how many rows flipped",
          schema: okWith({ resolved: { type: "integer" } }),
        },
        refusals: PLACES_OFF,
        limited: true,
      }),
      ...signed(
        "places/admin/atlas/upload",
        {
          tags: ["places"],
          summary: "Stage an Atlas volume archive",
          description:
            `${optIn("BEACON_PLACES")} The body is the zip archive. The signed envelope rides the ` +
            `\`${ATLAS_OP_HEADER}\` header and attests the archive's \`hash\` and \`size\`.`,
          ok: {
            description: "The staged id and the volume's preview.",
            schema: okWith({ staged: { type: "string" }, preview: ref("PlaceAtlasPreview") }),
          },
          refusals: {
            "400":
              `The \`${ATLAS_OP_HEADER}\` header is missing or unreadable, the archive does not match the ` +
              "attested hash and size, or the archive is not a readable volume (`invalid`).",
            ...PLACES_OFF,
          },
          limited: true,
          parameters: [
            {
              name: ATLAS_OP_HEADER,
              in: "header",
              required: true,
              description: `The signed \`OpEnvelope\` carrying ${opNames("places/admin/atlas/upload")}, as base64 of its JSON.`,
              schema: {
                type: "string",
                contentEncoding: "base64",
                contentMediaType: "application/json",
                contentSchema: signedEnvelope("places/admin/atlas/upload"),
              },
            },
          ],
        },
        {
          requestBody: { required: true, content: { "application/octet-stream": {} } },
          raw: true,
        },
      ),
      ...signed("places/admin/atlas/inspect", {
        tags: ["places"],
        summary: "Preview a hosted volume before trusting it (signed read; url in params)",
        ok: {
          description: "preview: who signed it, what it holds, how the pin stands",
          schema: okWith({ preview: ref("PlaceAtlasPreview") }),
        },
        refusals: {
          "400": "The volume is unreachable, unsigned or malformed (`invalid`).",
          ...PLACES_OFF,
          ...REPLAYED,
        },
      }),
      ...signed("places/admin/atlas/import", {
        tags: ["places"],
        idempotent: true,
        summary:
          "Import a volume (url or staged id + the confirmed publisher did; optional boundary and/or " +
          "cells (coverage-style geohash prefixes) scope the run to just those cells; queued run, " +
          "idempotent by nonce)",
        ok: {
          description: "the queued import run",
          schema: okWith({ snapshot: ref("PlaceSnapshot") }),
        },
        refusals: {
          "400":
            "The publisher does not match the manifest or the pin, or the volume is unreadable (`invalid`).",
          ...PLACES_OFF,
        },
        limited: true,
      }),
      ...signed("places/admin/atlas/survey", {
        tags: ["places"],
        summary: "Count what a volume holds in an area (signed read)",
        description: `${optIn("BEACON_PLACES")} A volume by \`url\` or \`staged\` id, and optional \`cells\`. Counts the places by type and by what each carries, so the operator chooses import filters with numbers in front of them. The survey runs in the background: poll with the same params until it is \`done\` or \`failed\`.`,
        ok: {
          description: "the survey so far",
          schema: okWith({ survey: ref("PlaceAtlasSurvey") }),
        },
        refusals: {
          "400": "The volume is unreachable, unsigned or malformed (`invalid`).",
          ...PLACES_OFF,
          ...REPLAYED,
        },
      }),
      ...signed("places/admin/atlas/unpin", {
        tags: ["places"],
        summary: "Forget a volume's pinned publisher: the deliberate half of key rotation",
        ok: { description: "removed: whether a pin existed", schema: REMOVED },
        refusals: PLACES_OFF,
        limited: true,
      }),
      ...signed("places/admin/atlas/pins", {
        tags: ["places"],
        summary: "Signed read: every volume's pinned publisher, with who confirmed it and when",
        ok: {
          description: "pins: the audit list revocation starts from",
          schema: okWith({ pins: listOf("PlaceAtlasPin") }),
        },
        refusals: { ...PLACES_OFF, ...REPLAYED },
      }),
      ...signed("places/admin/snapshots/fetch", {
        tags: ["places"],
        summary: "Poll snapshots (signed read: one by id, or the recent list)",
        ok: { description: "snapshots", schema: okWith({ snapshots: listOf("PlaceSnapshot") }) },
        refusals: { ...PLACES_OFF, ...REPLAYED },
        allowWhileLocked: true,
      }),
      ...signed("places/admin/snapshots/cancel", {
        tags: ["places"],
        summary: "Cancel a run by id",
        description: `${optIn("BEACON_PLACES")} A live run stops at its next chunk boundary; a run a restart left behind moves straight to a terminal state. Canceling a run that has already ended changes nothing. Answers while the server is locked.`,
        ok: { description: "the run", schema: okWith({ snapshot: ref("PlaceSnapshot") }) },
        refusals: {
          "404":
            "The places capability is off (`unknownRoute`), or no run has that id (`unknownRun`).",
        },
        allowWhileLocked: true,
        limited: true,
      }),
      ...signed("access/request", {
        tags: ["access"],
        idempotent: true,
        summary: "Ask to join a server at the `request` level",
        description:
          "A signed request from any account, with an optional note to the operator. An `open` " +
          "server answers `member` and records nothing. A pending request takes the new note. A " +
          "member or a declined player is answered as they stand. Publish your profile first, so " +
          "the operator can see who is asking. Idempotent by envelope nonce.",
        ok: { description: "the level and your standing", schema: ref("AccessResult") },
        refusals: {
          "403": "The server is `private` and takes no requests (`denied`).",
          "429":
            "The account went over its write budget, or 1000 requests already wait for an " +
            "answer (`rateLimited`).",
        },
        limited: true,
      }),
      ...signed("access/status", {
        tags: ["access"],
        summary: "Where you stand on this server (signed read)",
        description:
          "`member`, `pending`, `declined` or `none`. Everyone is a member of an `open` server, " +
          "and an admin is a member of every server.",
        ok: { description: "the level and your standing", schema: ref("AccessResult") },
        refusals: REPLAYED,
        readLimited: true,
      }),
      ...signed("admin/status", {
        tags: ["admin"],
        summary: "Operator dashboard overview (signed read)",
        description:
          "Descriptor facts, authenticated and fresh, plus cheap operational counts from every " +
          "durable store. The admin surface is never advertised in the descriptor.",
        ok: { description: "the status overview", schema: okWith({ status: ref("AdminStatus") }) },
        refusals: REPLAYED,
        allowWhileLocked: true,
      }),
      ...signed("admin/backup/start", {
        tags: ["admin"],
        idempotent: true,
        summary: "Back up the server to an S3 prefix (a durable run)",
        description:
          "Answers at once with the queued run; the console polls `admin.backup.runs`. " +
          "Credentials arrive with the request and are never stored. Idempotent by envelope " +
          "nonce; answers while the server is locked.",
        ok: { description: "the run", schema: okWith({ run: ref("BackupRun") }) },
        refusals: {
          "400": "The endpoint is not allowed (`invalid`).",
          "409": "A backup or restore is already queued or running (`conflict`).",
        },
        allowWhileLocked: true,
        limited: true,
      }),
      ...signed("admin/backup/runs", {
        tags: ["admin"],
        summary: "One backup run by id, or the most recent runs (signed read)",
        description:
          "The console's progress poll: one run by id, or the most recent 50 of both kinds. " +
          "Answers while the server is locked.",
        ok: { description: "the runs", schema: ref("AdminBackupRuns") },
        refusals: REPLAYED,
        allowWhileLocked: true,
      }),
      ...signed("admin/restore/inspect", {
        tags: ["admin"],
        summary: "Read a backup's manifest and whether this server would restore it (signed read)",
        description:
          "Reads `manifest.json` at the given S3 prefix; `refusal` says, in a sentence, why this " +
          "server would not restore it. Answers while locked.",
        ok: {
          description: "the manifest, and a refusal if any",
          schema: ref("AdminRestoreInspection"),
        },
        refusals: {
          "400":
            "The prefix holds no readable manifest, or the endpoint is not allowed (`invalid`).",
          ...REPLAYED,
        },
        allowWhileLocked: true,
      }),
      ...signed("admin/restore/start", {
        tags: ["admin"],
        idempotent: true,
        summary: "Restore this server from a backup (a durable run, then a restart)",
        description:
          "Locks the server, copies the files, replaces the database in one transaction, writes " +
          "the run `done` and exits so the process restarts. Refused with the reason inspect " +
          "gives. Idempotent by nonce; answers while locked.",
        ok: { description: "the run", schema: okWith({ run: ref("BackupRun") }) },
        refusals: {
          "400":
            "The server would not restore the backup, for the reason inspect gives (`invalid`).",
          "409": "A backup or restore is already queued or running (`conflict`).",
        },
        allowWhileLocked: true,
        limited: true,
      }),
      ...signed("admin/rooms/remove", {
        tags: ["admin"],
        idempotent: true,
        summary: "Force-remove a custodied room (moderation)",
        description:
          "Removal rides the engine's normal close path: watchers get the standard `closed` and " +
          "`roomGone` events and a racing op sees `expired`. Idempotent by envelope nonce; " +
          "`removed:false` for an unknown room.",
        ok: { description: "whether a room was removed", schema: REMOVED },
        limited: true,
      }),
      ...signed("admin/media/remove", {
        tags: ["admin"],
        idempotent: true,
        summary: "Delete a media object by content hash (moderation)",
        description:
          "Deletes blob bytes and metadata. Content addressing means a re-upload re-creates it; " +
          "block the owner for repeat abuse. Idempotent by envelope nonce; `removed:false` for " +
          "an unknown hash.",
        ok: { description: "whether a media object was removed", schema: REMOVED },
        limited: true,
      }),
      ...signed("admin/media/list", {
        tags: ["admin"],
        summary: "Browse the media store (signed read, paginated)",
        description:
          "One page of media metadata (hash, type, size, owner, timestamps, review stamp), " +
          "ordered by `sort` (`recent` = newest-first, the default; `size` = largest-first), with " +
          "optional `owner`/`type`/`reviewed` filters and an opaque keyset `cursor` (valid only " +
          "for the `sort` that produced it). Enumeration is admin-only; the bytes themselves are " +
          "already public at `GET /media/:hash`.",
        ok: { description: "a media page", schema: ref("AdminMediaList") },
        refusals: { "400": "The `cursor` is invalid (`invalid`).", ...REPLAYED },
      }),
      ...signed("admin/media/review", {
        tags: ["admin"],
        idempotent: true,
        summary: "Mark a media object reviewed (moderation queue)",
        description:
          "Set (`reviewed:true`) or clear (`reviewed:false`) the moderation review stamp on one " +
          "object by content hash. Idempotent by envelope nonce; an unknown hash reports the " +
          "cleared stamp.",
        ok: { description: "the review stamp", schema: ref("AdminMediaReview") },
        limited: true,
      }),
      ...signed("admin/blocklist/add", {
        tags: ["admin"],
        idempotent: true,
        summary: "Durably block a DID",
        description:
          "The DID's signed capability/admin requests are denied immediately and durably " +
          "(survives restarts; `BEACON_BLOCKLIST` env entries seed the same table at boot). A DID " +
          "on `BEACON_ADMINS` cannot be blocked.",
        ok: { description: "added", schema: okWith({}) },
        refusals: { "400": "The DID is on `BEACON_ADMINS` (`invalid`)." },
        limited: true,
      }),
      ...signed("admin/blocklist/remove", {
        tags: ["admin"],
        idempotent: true,
        summary: "Lift a durable blocklist entry",
        ok: { description: "whether an entry was removed", schema: REMOVED },
        limited: true,
      }),
      ...signed("admin/blocklist/fetch", {
        tags: ["admin"],
        summary: "The durable blocklist (signed read)",
        ok: { description: "blocklist entries", schema: okWith({ entries: listOf("BlockEntry") }) },
        refusals: REPLAYED,
      }),
      ...signed("admin/access/fetch", {
        tags: ["admin"],
        summary: "The member list (signed read)",
        description:
          "Pending requests oldest first, then members, then declined players. `status` lists one " +
          "kind only. Admins are members without an entry.",
        ok: { description: "the entries", schema: okWith({ entries: listOf("AccessEntry") }) },
        refusals: REPLAYED,
      }),
      ...signed("admin/access/add", {
        tags: ["admin"],
        idempotent: true,
        summary: "Make an account a member, approving its request if it has one",
        ok: { description: "the entry", schema: okWith({ entry: ref("AccessEntry") }) },
        limited: true,
      }),
      ...signed("admin/access/decline", {
        tags: ["admin"],
        idempotent: true,
        summary: "Decline a pending request",
        description:
          "The player cannot ask again until an admin approves them or removes the entry.",
        ok: { description: "the entry", schema: okWith({ entry: ref("AccessEntry") }) },
        refusals: { "400": "The account has no pending request (`invalid`)." },
        limited: true,
      }),
      ...signed("admin/access/remove", {
        tags: ["admin"],
        idempotent: true,
        summary: "Remove an entry from the member list",
        description: "A member loses write access, and a declined player may ask again.",
        ok: { description: "whether an entry was removed", schema: REMOVED },
        limited: true,
      }),
      ...signed("admin/access/admitAll", {
        tags: ["admin"],
        idempotent: true,
        summary: "Make a member of every account with a profile on this server",
        description:
          "For moving a server off `open` without shutting out its players. Admins and members " +
          "are left as they are.",
        ok: {
          description: "how many became members",
          schema: okWith({ added: { type: "integer" } }),
        },
        limited: true,
      }),
      ...signed("admin/settings/get", {
        tags: ["admin"],
        summary: "The whole server configuration (signed read)",
        description:
          "Every configuration field with its provenance: the runtime settings an admin may " +
          "change, then the deploy-time fields read-only, each naming the environment variable " +
          "behind it. Key material and the S3 credentials are reported as set or unset, never by " +
          "value.",
        ok: { description: "`{ok, settings}`", schema: ref("AdminSettings") },
        refusals: REPLAYED,
        allowWhileLocked: true,
      }),
      ...signed("admin/settings/set", {
        tags: ["admin"],
        idempotent: true,
        summary: "Override settings, effective without a redeploy",
        description:
          "Carries a `settings` map. Several keys at once is the design: these settings " +
          "constrain each other, so turning `placesEnabled` off means turning its dependants off " +
          "in the same write. The whole patch is validated against the resulting configuration " +
          "before any of it is stored. A `null` value overrides a setting to *no value*, which is " +
          "not the same as a reset. Idempotent by envelope nonce; the result is the whole " +
          "configuration, because a write can move a field it did not name.",
        ok: { description: "`{ok, settings}`", schema: ref("AdminSettings") },
        refusals: {
          "400": "A key is not writable, or a value or the combination is refused (`invalid`).",
        },
        allowWhileLocked: true,
        limited: true,
      }),
      ...signed("admin/settings/reset", {
        tags: ["admin"],
        idempotent: true,
        summary: "Hand settings back to the environment",
        description:
          "Drops the override rows for `keys`, so each setting tracks its environment variable " +
          "again. Never refused for the combination it leaves: a dependant whose prerequisite has " +
          "gone goes dormant and applies again if the prerequisite comes back.",
        ok: { description: "`{ok, settings}`", schema: ref("AdminSettings") },
        refusals: { "400": "A key is not an editable setting (`invalid`)." },
        allowWhileLocked: true,
        limited: true,
      }),
    }),
    components: {
      schemas: componentSchemas(),
      responses: Object.fromEntries(
        Object.entries(SHARED_RESPONSES).map(([name, description]) => [
          name,
          res(description, ref("Refusal")),
        ]),
      ),
    },
  };
}

/** A health probe's `{ status }` body. */
function okStatus(status: string): Schema {
  return { type: "object", required: ["status"], properties: { status: { const: status } } };
}
