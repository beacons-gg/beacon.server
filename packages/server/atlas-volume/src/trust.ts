/**
 * What makes a volume trustworthy: the hash spelling every file in the tree uses, and the one signature
 * the whole tree hangs off.
 *
 * Shared rather than implemented twice because `apps/atlas/doc/spec/beacon-integration.md` §7 is
 * explicit that this signature is **doing work a check cannot**: the taxonomy's sensitive-place
 * exclusions are a tag-level rule, and a published `category` carries no trace of whether they were
 * applied. So the property holds by shared code plus an operator's opt-in trust in a publisher key
 * — and "shared code" has to mean one implementation, not two that agree today.
 */
import { decodeDidKey, sha256Base64url, verifyUtf8 } from "@beaconsgg/identity";
import { canonicalJson } from "@beaconsgg/protocol-types";
import type { Manifest, ManifestBody } from "./format";

/**
 * `sha256:<base64url-nopad>` — every hash a volume publishes names its own algorithm.
 *
 * sha256 rather than something faster because a volume's **media hash is the server's media identity**:
 * `ingestTrusted` re-hashes the bytes and rejects a mismatch, so a differently-hashed media entry could
 * never be ingested at all. Hashing tiles one way and media another would be a trap for every reader, so
 * it is one algorithm throughout. The prefix is what keeps that reversible.
 */
export function withAlgorithm(digest: string): string {
  return `sha256:${digest}`;
}

/** Hash text the way the tree does — used by the writer to advertise and by the reader to check. */
export function hashText(text: string): string {
  return withAlgorithm(sha256Base64url(Buffer.from(text, "utf8")));
}

/**
 * The same hash over raw bytes — media, which is the only thing in a volume that is not utf8 JSON.
 *
 * A separate function rather than a `hashText` that takes `string | Buffer`, because the difference that
 * matters is at the call site: everything else in the tree is text whose bytes are an encoding detail, while
 * a media file *is* bytes and re-encoding it through a string would corrupt it silently.
 */
export function hashBytes(bytes: Buffer): string {
  return withAlgorithm(sha256Base64url(bytes));
}

/** Why a manifest was not accepted. A reader reports which, because they mean different things. */
export type ManifestRejection =
  | "malformed"
  | "unsigned"
  | "publisher-undecodable"
  | "signature-invalid"
  | "publisher-not-configured";

export type ManifestCheck =
  { ok: true; manifest: Manifest } | { ok: false; reason: ManifestRejection; detail: string };

/**
 * Verify a manifest's signature over the JCS canonicalization of itself minus `signature`.
 *
 * **Fail-closed, and never throws** — the shape `verifyDescriptor` established: re-parse from the
 * text rather than trusting a caller-supplied object, `try`/`catch` the key decode and the
 * canonicalization (a `1e400` parses to `Infinity`, and nesting can run deeper than JCS can walk:
 * both are `malformed`), and return a reason rather than a bare boolean, because "this file is not
 * JSON" and "this file is signed by someone else" are different operator problems.
 *
 * `expectedPublisher` is the key the operator configured. Omit it only where the caller has already
 * decided which publisher it trusts — a volume from an unconfigured publisher must not be read at
 * all (`apps/atlas/doc/spec/beacon-integration.md` §2), so a reader passes it.
 */
export function checkManifest(manifestText: string, expectedPublisher?: string): ManifestCheck {
  let parsed: Manifest;
  try {
    parsed = JSON.parse(manifestText) as Manifest;
  } catch (error) {
    return { ok: false, reason: "malformed", detail: String(error) };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "malformed", detail: "not an object" };
  }

  const { signature, ...body } = parsed as Manifest & Record<string, unknown>;
  if (typeof signature !== "string" || signature === "") {
    return { ok: false, reason: "unsigned", detail: "manifest carries no signature" };
  }
  if (typeof parsed.publisher !== "string") {
    return { ok: false, reason: "malformed", detail: "manifest names no publisher" };
  }
  // Checked before the cryptography: a volume from a publisher this reader was not configured for is not
  // read at all, so whether its signature happens to verify is not a question worth asking.
  if (expectedPublisher !== undefined && parsed.publisher !== expectedPublisher) {
    return {
      ok: false,
      reason: "publisher-not-configured",
      detail: `signed by ${parsed.publisher}, configured for ${expectedPublisher}`,
    };
  }

  let publicKey: Uint8Array;
  try {
    publicKey = decodeDidKey(parsed.publisher);
  } catch {
    return {
      ok: false,
      reason: "publisher-undecodable",
      detail: `not a did:key this reader can decode: ${parsed.publisher}`,
    };
  }
  let message: string;
  try {
    message = manifestSigningInput(body as ManifestBody);
  } catch (error) {
    return { ok: false, reason: "malformed", detail: `no canonical form: ${String(error)}` };
  }
  if (!verifyUtf8(message, signature, publicKey)) {
    return {
      ok: false,
      reason: "signature-invalid",
      detail: `does not verify against ${parsed.publisher}`,
    };
  }
  return { ok: true, manifest: parsed };
}

/**
 * The signing input a publisher signs — the manifest body, canonicalized, signature excluded.
 *
 * Exported so the *writer* signs the same bytes {@link checkManifest} verifies. The publisher used to call
 * `canonicalJson` itself, which agreed by inspection rather than by construction: the two halves of one
 * signature contract are exactly where "they match today" is not a guarantee worth relying on.
 */
export function manifestSigningInput(body: ManifestBody): string {
  return canonicalJson(body);
}
