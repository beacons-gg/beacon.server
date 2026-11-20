import { describe, expect, it } from "vitest";
import { mediaBareHash, mediaPath, mediaUrl } from "../format";
import { hashBytes, withAlgorithm } from "../trust";

/**
 * The media layout, tested here because both implementors read it and a published version's bytes are
 * immutable — a disagreement about where a file lives cannot be corrected in place later.
 */

const HASH = withAlgorithm("9fLmQz3TgAbCdEf0");

describe("mediaBareHash", () => {
  it("strips the algorithm prefix a volume writes", () => {
    expect(mediaBareHash(HASH)).toBe("9fLmQz3TgAbCdEf0");
  });

  it("passes an already-bare hash through — the server's spelling is the fixed point", () => {
    expect(mediaBareHash("9fLmQz3TgAbCdEf0")).toBe("9fLmQz3TgAbCdEf0");
    expect(mediaBareHash(mediaBareHash(HASH))).toBe(mediaBareHash(HASH));
  });
});

describe("mediaPath", () => {
  it("shards on the hash, not on the algorithm prefix", () => {
    // The bug this pins: sharding the prefixed form puts every file in one `sh/` directory.
    expect(mediaPath(HASH)).toBe("9f/9fLmQz3TgAbCdEf0.webp");
    expect(mediaPath(HASH)).toBe(mediaPath(mediaBareHash(HASH)));
  });

  it("carries the .webp extension a static host needs to answer with a content type", () => {
    expect(mediaPath(HASH).endsWith(".webp")).toBe(true);
  });

  it("keeps base64url's two non-alphanumeric characters, which are filename-safe", () => {
    expect(mediaPath(withAlgorithm("-_abc"))).toBe("-_/-_abc.webp");
  });
});

describe("mediaUrl", () => {
  /**
   * The trap: `media.base` is `../media/`, and resolving that against a version URL **without** a trailing
   * slash climbs one segment too far. Both spellings are equally natural to type into config.
   */
  it("resolves the same whether the configured version URL ends in a slash", () => {
    const want = "https://h.example/us-west/media/9f/9fLmQz3TgAbCdEf0.webp";
    expect(mediaUrl("https://h.example/us-west/2026-08", "../media/", HASH)).toBe(want);
    expect(mediaUrl("https://h.example/us-west/2026-08/", "../media/", HASH)).toBe(want);
  });

  it("honours an absolute base, which `apps/atlas/doc/spec/volume-format.md` §6 allows for a CDN", () => {
    expect(mediaUrl("https://h.example/us-west/2026-08", "https://cdn.example/m/", HASH)).toBe(
      "https://cdn.example/m/9f/9fLmQz3TgAbCdEf0.webp",
    );
  });

  it("works for a file: volume, which is how an operator runs the builder locally", () => {
    expect(mediaUrl("file:///out/2026-08", "../media/", HASH)).toBe(
      "file:///out/media/9f/9fLmQz3TgAbCdEf0.webp",
    );
  });
});

describe("hashBytes", () => {
  it("names its algorithm like every other hash in the tree", () => {
    expect(hashBytes(Buffer.from([0, 1, 2]))).toMatch(/^sha256:[A-Za-z0-9_-]+$/);
  });

  /** Media is the one thing in a volume that is not text; round-tripping it through utf8 corrupts it. */
  it("hashes raw bytes, including ones no utf8 string could hold", () => {
    const lone = Buffer.from([0xff, 0xfe, 0x00, 0x80]);
    expect(hashBytes(lone)).not.toBe(hashBytes(Buffer.from(lone.toString("utf8"), "utf8")));
  });
});
