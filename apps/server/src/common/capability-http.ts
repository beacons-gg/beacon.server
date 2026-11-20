import { type NonceKey, type SignedBy, nonceKey } from "../stores/nonce-store";
import { NOT_FOUND_FALLBACKS, paramsRefusal } from "@beaconsgg/protocol-types/server";
import { HttpException, HttpStatus } from "@nestjs/common";
import type { ZodError, ZodType } from "zod";

/**
 * Shared HTTP error shapes for the signed endpoints. Every signed route answers with one consistent
 * `400` / `401` / `403` / `404` / `409` / `429` / `503` surface rather than each controller inventing its
 * own body. The request gate itself moved to `SignedRequestGate`, which throws through these.
 */

/** A refusal: the `{ ok: false, error, message? }` body every refusal carries, at `status`. */
export function refusal(status: number, error: string, message?: string): HttpException {
  return new HttpException(
    { ok: false, error, ...(message === undefined ? {} : { message }) },
    status,
  );
}

/**
 * 400 — a malformed capability request body or params. `error` defaults to the generic `"invalid"`;
 * pass a specific code when the client can act on *which* input was wrong.
 */
export function badRequest(message: string, error = "invalid"): never {
  throw refusal(HttpStatus.BAD_REQUEST, error, message);
}

/** 400 for params that did not parse, naming the fields this build does not know (`paramsRefusal`). */
export function badParams(error: ZodError): never {
  throw new HttpException(paramsRefusal(error), HttpStatus.BAD_REQUEST);
}

/**
 * Parse a signed op's params (or any request shape) with `schema`, or refuse with the one 400 every
 * route answers bad params with: `invalid`, and `fields` naming the keys this build does not know
 * when those are the only problem. One helper, so no route can fall back to zod's raw message.
 */
export function parseParams<P>(schema: ZodType<P>, value: unknown): P {
  const parsed = schema.safeParse(value);
  if (!parsed.success) badParams(parsed.error);
  return parsed.data;
}

/**
 * 404 `unknownRoute`: no such route, or the capability that serves it is turned off, so the route
 * looks absent. A thing the route names that does not exist answers {@link missing} instead.
 */
export function notFound(message?: string): never {
  throw refusal(HttpStatus.NOT_FOUND, "unknownRoute", message);
}

/**
 * The 404 codes that name what is missing, on a route that exists and is on: core's
 * `NOT_FOUND_FALLBACKS`. A caller that has not declared `code:<name>` gets `unknownRoute` for each
 * (`UnderstandsFilter`), which is what it read before.
 */
export type MissingCode = keyof typeof NOT_FOUND_FALLBACKS;

/** 404 naming the thing that does not exist: the route is there, the place or run is not. */
export function missing(error: MissingCode, message: string): never {
  throw refusal(HttpStatus.NOT_FOUND, error, message);
}

/** 409 — a replayed **read** nonce (a captured signed fetch can't be re-served). */
export function replayConflict(): never {
  throw refusal(HttpStatus.CONFLICT, "replayed", "request nonce already used");
}

/** 409: the request is fine but the server's state refuses it (`error` says which state). */
export function conflict(message: string, error = "conflict"): never {
  throw refusal(HttpStatus.CONFLICT, error, message);
}

/**
 * 403: the caller is refused (`error` names why, so a client can tell "you are blocked here" from
 * "your application is not welcome here" and respond differently to each). The shared status keeps
 * the family's one-shape promise; the code is what carries the distinction.
 */
export function denied(message: string, error = "denied"): never {
  throw refusal(HttpStatus.FORBIDDEN, error, message);
}

/** 429 — a per-DID budget is exhausted (`error` names which one, so a client can say why). */
export function rateLimited(message: string, error = "rateLimited"): never {
  throw refusal(HttpStatus.TOO_MANY_REQUESTS, error, message);
}

/** 503 — the server is locked read-only. A client treats a 5xx as retryable, so no new code to learn. */
export function writeLocked(): never {
  throw refusal(
    HttpStatus.SERVICE_UNAVAILABLE,
    "writeLocked",
    "this server is locked read-only; try again later",
  );
}

/**
 * The signed-**read** bracket every fetch-style route shares: a read has no idempotent result to
 * replay, so a re-used nonce is rejected outright (a captured fetch envelope can't be replayed to
 * re-read), then the params are parsed and the nonce burned.
 *
 * Callers pass an already-verified envelope, because *who* may call differs — the admin gate adds an
 * allowlist check, a player route doesn't — while the replay/parse discipline must not. Keeping it
 * here is what stops two routes serving the same op with different retry semantics.
 */
export async function signedReadParams<P>(
  // Structural rather than `NonceService` so this stays a leaf helper. `check` resolves the memo (or
  // `undefined`), which is exactly the truthiness the replay guard wants.
  nonce: {
    check(key: NonceKey): Promise<unknown>;
    remember(key: NonceKey, result: string): Promise<void>;
  },
  signed: SignedBy,
  schema: ZodType<P>,
): Promise<P> {
  const key = nonceKey(signed);
  if (await nonce.check(key)) replayConflict();
  const params = parseParams(schema, signed.env.params);
  await nonce.remember(key, "");
  return params;
}
