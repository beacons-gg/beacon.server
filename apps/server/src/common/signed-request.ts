import { verifyOp } from "@beaconsgg/identity";
import { type DidKey, type OpEnvelope, opEnvelopeSchema } from "@beaconsgg/protocol-types";
import { paramsRefusal } from "@beaconsgg/protocol-types/server";

/**
 * Accepted `issuedAt` skew for a signed capability request, in either direction — mirrors the room
 * engine's `replayWindowMs` default (`doc/spec/room-operation.md` §6.2), so a captured request
 * can't replay forever.
 */
export const SIGNED_REQUEST_WINDOW_MS = 5 * 60_000;

export type SignedRequest =
  | { ok: true; actor: DidKey; env: OpEnvelope }
  | {
      ok: false;
      status: 400 | 401;
      error: "invalid" | "badsig" | "clockSkew";
      message: string;
      /** The envelope keys this build does not know, when that is all that is wrong. */
      fields?: string[];
    };

/**
 * Verify a signed capability request (mailbox / media) exactly the way the room engine verifies an
 * op (`doc/spec/mailbox-and-media.md` §3.2), minus the room machinery:
 *   1. re-validate the envelope schema (soundness never rests on the caller),
 *   2. check the `op` name against the one (or, for a relay serving several ops through one
 *      entry, the few) this route accepts,
 *   3. `verifyOp` — offline Ed25519 attribution; the `actor` is derived **from the signature**,
 *   4. `issuedAt` freshness.
 *
 * The returned `actor` is cryptographic (never a claimed field), so callers key blocklist, per-DID
 * rate limiting, and recipient-scoping on it. Idempotency (nonce dedup) is the caller's concern —
 * each capability route checks the durable {@link NonceService} replay log on `env.nonce` before
 * committing (`doc/spec/mailbox-and-media.md` §3.2).
 */
export function verifySignedRequest(
  body: unknown,
  op: string | readonly string[],
  now: number = Date.now(),
): SignedRequest {
  const accepted = typeof op === "string" ? [op] : op;
  const parsed = opEnvelopeSchema.safeParse(body);
  if (!parsed.success) return { status: 400, ...paramsRefusal(parsed.error) };
  if (!accepted.includes(parsed.data.op)) {
    const names = accepted.map((name) => `"${name}"`).join(" or ");
    return { ok: false, status: 400, error: "invalid", message: `expected op ${names}` };
  }

  const verification = verifyOp(parsed.data, now);
  if (!verification.ok) {
    // `malformed` past the schema is a body with no canonical form (a `1e400`, or nesting too deep
    // to walk): the sender's bug, not a bad signature.
    return verification.reason === "malformed"
      ? { ok: false, status: 400, error: "invalid", message: verification.reason }
      : { ok: false, status: 401, error: "badsig", message: verification.reason };
  }

  const issuedAt = Date.parse(parsed.data.issuedAt);
  if (Number.isNaN(issuedAt) || Math.abs(now - issuedAt) > SIGNED_REQUEST_WINDOW_MS) {
    // Its own code: the fix is the device's clock, which no player reads out of "invalid".
    return {
      ok: false,
      status: 400,
      error: "clockSkew",
      message: "issuedAt outside the replay window",
    };
  }

  return { ok: true, actor: verification.actor, env: parsed.data };
}
