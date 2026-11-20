import { accountFromMnemonic, signUtf8 } from "@beaconsgg/identity";
import { canonicalJson } from "@beaconsgg/protocol-types";
import { describe, expect, it } from "vitest";
import type { ManifestBody } from "../format";
import { checkManifest, hashText, withAlgorithm } from "../trust";

/**
 * The trust root, tested directly. `apps/atlas/doc/spec/beacon-integration.md` §7 is explicit that
 * this signature does work a check cannot — the taxonomy's sensitive-place exclusions are a
 * tag-level rule that a published `category` carries no trace of — so a reader accepting a volume
 * it should have refused is the most consequential failure in the format.
 */

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const ACCOUNT = accountFromMnemonic(MNEMONIC);
const OTHER = accountFromMnemonic(
  "legal winner thank year wave sausage worth useful legal winner thank yellow",
);

const body = (over: Partial<ManifestBody> = {}): ManifestBody => ({
  format: 1,
  volume: "us-west",
  version: "2026-08",
  revision: 1,
  createdAt: "2026-08-06T00:00:00.000Z",
  publisher: ACCOUNT.did,
  bounds: { minLat: 47, minLng: -123, maxLat: 48, maxLng: -122 },
  coverage: ["c2"],
  cellPrecision: 5,
  places: 1,
  index: { path: "index.json", hash: "sha256:ii", bytes: 10 },
  dict: { path: "dict.json", hash: "sha256:dd", bytes: 20 },
  media: { base: "../media/", count: 0, bytes: 0 },
  taxonomy: 3,
  mediaProfile: { thumbPx: 256, fullPx: 1024, format: "image/webp" },
  inputs: [],
  licenses: [],
  ...over,
});

const signed = (over: Partial<ManifestBody> = {}, signer = ACCOUNT): string => {
  const b = body(over);
  return JSON.stringify({ ...b, signature: signUtf8(canonicalJson(b), signer.root.privateKey) });
};

describe("hashes name their own algorithm", () => {
  it("prefixes a digest, which is what keeps the choice reversible", () => {
    expect(withAlgorithm("abc")).toBe("sha256:abc");
    expect(hashText("hello")).toMatch(/^sha256:[A-Za-z0-9_-]+$/);
  });

  it("is stable, so a reader and a writer agree about the same bytes", () => {
    expect(hashText("hello")).toBe(hashText("hello"));
    expect(hashText("hello")).not.toBe(hashText("hello "));
  });
});

describe("checkManifest", () => {
  it("accepts a manifest signed by the publisher it names", () => {
    const result = checkManifest(signed());
    expect(result.ok).toBe(true);
    expect(result.ok && result.manifest.volume).toBe("us-west");
  });

  it("accepts it when the caller names the same publisher it was configured for", () => {
    expect(checkManifest(signed(), ACCOUNT.did).ok).toBe(true);
  });

  /**
   * The refusal that matters most: *"A volume whose signature does not match a configured key is
   * not read at all"* (`apps/atlas/doc/spec/beacon-integration.md` §2). Checked before the
   * cryptography, because whether some other publisher's signature happens to verify is not a
   * question worth asking.
   */
  it("refuses a volume from a publisher the reader was not configured for", () => {
    const result = checkManifest(signed({ publisher: OTHER.did }, OTHER), ACCOUNT.did);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("publisher-not-configured");
  });

  it("refuses a manifest whose body was altered after signing", () => {
    const parsed = JSON.parse(signed()) as Record<string, unknown>;
    parsed["places"] = 999;
    const result = checkManifest(JSON.stringify(parsed), ACCOUNT.did);
    expect(result.ok === false && result.reason).toBe("signature-invalid");
  });

  it("refuses a manifest signed by a different key than it names", () => {
    // Names our publisher, signed by someone else — the substitution a compromised mirror would attempt.
    const b = body();
    const forged = JSON.stringify({
      ...b,
      signature: signUtf8(canonicalJson(b), OTHER.root.privateKey),
    });
    expect(checkManifest(forged, ACCOUNT.did).ok === false).toBe(true);
  });

  /** Distinct reasons, because they are distinct operator problems. */
  it("distinguishes malformed, unsigned and undecodable from an invalid signature", () => {
    expect(checkManifest("not json").ok === false).toBe(true);
    expect((checkManifest("not json") as { reason: string }).reason).toBe("malformed");
    expect((checkManifest(JSON.stringify(body())) as { reason: string }).reason).toBe("unsigned");
    expect(
      (
        checkManifest(
          JSON.stringify({ ...body({ publisher: "did:key:nope" }), signature: "x" }),
        ) as {
          reason: string;
        }
      ).reason,
    ).toBe("publisher-undecodable");
  });

  /** Never throws — a reader maps a rejection to a refusal, not to a 500. */
  it("returns rather than throwing, for every input", () => {
    for (const input of ["", "null", "[]", "{}", '{"publisher":1}']) {
      expect(() => checkManifest(input)).not.toThrow();
      expect(checkManifest(input).ok).toBe(false);
    }
  });

  /** Nor on a value JCS has no form for, which only `JSON.parse` writes. */
  it("refuses a manifest with no canonical form as malformed, rather than throwing", () => {
    const text = signed({ licenses: [1] as never });
    const deep = "[".repeat(20_000) + "]".repeat(20_000);
    for (const bad of [
      text.replace('"licenses":[1]', '"licenses":[1e400]'),
      text.replace('"licenses":[1]', `"licenses":${deep}`),
    ]) {
      expect(() => checkManifest(bad, ACCOUNT.did)).not.toThrow();
      expect((checkManifest(bad, ACCOUNT.did) as { reason: string }).reason).toBe("malformed");
    }
  });

  /**
   * JCS canonicalization means key order is not part of the signed content — a mirror that re-serialized
   * the JSON must not invalidate the volume.
   */
  it("verifies regardless of the manifest's key order", () => {
    const parsed = JSON.parse(signed()) as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(parsed).reverse());
    expect(checkManifest(JSON.stringify(reordered), ACCOUNT.did).ok).toBe(true);
  });
});
