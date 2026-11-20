/**
 * Core's published vectors, run here over the core this server installs. Core's own suite holds
 * them against its source. This holds them against the registry copy the server is built on, and
 * through the server's own entry points where it has one: a lockfile that resolved a build whose
 * bytes differ, or a boundary that stopped accepting what a client signs, fails here and not in
 * production.
 *
 * Nothing in this file signs. Every artifact is the vector's own, so a pass means this server
 * verifies exactly the bytes the vectors pin.
 */
import {
  SIGNING_VECTOR_NOW,
  SIGNING_VECTORS,
  type SigningVector,
} from "@beaconsgg/identity/conformance";
import {
  decodeDidKey,
  verifyRoomProvenance,
  verifyItemProvenance,
  verifyScoutProvenance,
  verifyUtf8,
} from "@beaconsgg/identity";
import { CONTAINMENT_VECTORS, containsPoint } from "@beaconsgg/geo";
import { canonicalJson } from "@beaconsgg/protocol-types";
import { describe, expect, it } from "vitest";
import { SIGNED_REQUEST_WINDOW_MS, verifySignedRequest } from "../common/signed-request";

type Of<K extends SigningVector["kind"]> = Extract<SigningVector, { kind: K }>;
const ofKind = <K extends SigningVector["kind"]>(kind: K): Of<K>[] =>
  SIGNING_VECTORS.filter((vector): vector is Of<K> => vector.kind === kind);

describe("signing vectors: the installed core reproduces the published bytes", () => {
  it.each(SIGNING_VECTORS)("$name", (vector) => {
    // The vectors are written with their keys out of order, so this fails for a canonicalizer
    // that does not sort them.
    expect(canonicalJson(vector.signed)).toBe(vector.signingInput);
    expect(verifyUtf8(vector.signingInput, vector.sig, decodeDidKey(vector.signer))).toBe(true);
  });

  it("covers every kind of signed artifact the wire carries", () => {
    expect([...new Set(SIGNING_VECTORS.map((vector) => vector.kind))].sort()).toEqual([
      "descriptor",
      "deviceAuthorization",
      "item",
      "op",
      "profile",
      "room",
      "scout",
    ]);
  });
});

describe("op vectors through the signed-request boundary", () => {
  const ops = ofKind("op");
  /** The envelope as a client posts it: what was signed, and the signature. */
  const envelope = (vector: Of<"op">) => ({ ...vector.signed, sig: vector.sig });
  const issued = (vector: Of<"op">) => Date.parse(vector.input.issuedAt);

  it("has op vectors to run", () => {
    expect(ops.length).toBeGreaterThan(0);
  });

  it.each(ops)("accepts $name, and attributes it to the signer's account", (vector) => {
    const result = verifySignedRequest(envelope(vector), vector.input.op, issued(vector));
    expect(result).toMatchObject({ ok: true, actor: vector.input.actor });
  });

  it.each(ops)("refuses $name with one field changed after signing", (vector) => {
    const tampered = { ...envelope(vector), nonce: "01K52A7Q3V9M8XH2B6T4R0N1ZZ" };
    expect(verifySignedRequest(tampered, vector.input.op, issued(vector))).toMatchObject({
      ok: false,
      status: 401,
      error: "badsig",
    });
  });

  it.each(ops)("refuses $name outside the replay window, by its own code", (vector) => {
    // The vectors' own instant is hours after the ops were issued: a valid signature, too old.
    const now = Date.parse(SIGNING_VECTOR_NOW);
    expect(now - issued(vector)).toBeGreaterThan(SIGNED_REQUEST_WINDOW_MS);
    expect(verifySignedRequest(envelope(vector), vector.input.op, now)).toMatchObject({
      ok: false,
      status: 400,
      error: "clockSkew",
    });
  });
});

describe("provenance vectors through the checks the room and scout routes make", () => {
  /** A `mintedBy` as it rides on the wire: the minter's key and its signature over the birth. */
  const mintedBy = (vector: SigningVector) => ({ id: vector.signer, sig: vector.sig });
  const forged = (vector: SigningVector) => ({
    ...mintedBy(vector),
    sig: vector.sig.replace(/.$/, (c) => (c === "A" ? "B" : "A")),
  });

  it.each(ofKind("room"))("room: $name", (vector) => {
    expect(verifyRoomProvenance(vector.input, mintedBy(vector))).toBe(true);
    expect(verifyRoomProvenance(vector.input, forged(vector))).toBe(false);
  });

  it.each(ofKind("item"))("item: $name", (vector) => {
    expect(verifyItemProvenance(vector.input, mintedBy(vector))).toBe(true);
    expect(verifyItemProvenance(vector.input, forged(vector))).toBe(false);
  });

  it.each(ofKind("scout"))("scout: $name", (vector) => {
    expect(verifyScoutProvenance(vector.input, mintedBy(vector))).toBe(true);
    expect(verifyScoutProvenance(vector.input, forged(vector))).toBe(false);
  });
});

describe("containment vectors: the place boundary check agrees with the client's", () => {
  it.each(CONTAINMENT_VECTORS)("$name", ({ point, geometry, expected }) => {
    expect(containsPoint(point, geometry)).toBe(expected);
  });
});
