import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { PLACE_FULL_PX, PLACE_MEDIA_TYPE, PLACE_THUMB_PX } from "@beaconsgg/protocol-types";
import { WEBP_QUALITY, sharpResizer } from "../encode";

/** A solid-colour source image of a given size, as PNG bytes. */
async function png(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .png()
    .toBuffer();
}

describe("sharpResizer (real sharp)", () => {
  it("re-encodes an image to a bounded WebP", async () => {
    const webp = await sharpResizer.toWebp(await png(400, 300), 128, WEBP_QUALITY);
    const meta = await sharp(webp).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBeLessThanOrEqual(128);
    expect(meta.height).toBeLessThanOrEqual(128);
  });

  it("bounds the long edge and keeps the aspect ratio", async () => {
    const meta = await sharp(
      await sharpResizer.toWebp(await png(1000, 250), 500, WEBP_QUALITY),
    ).metadata();
    expect(meta.width).toBe(500);
    expect(meta.height).toBe(125);
  });

  /**
   * The one property `apps/atlas/doc/spec/sources.md` §3 requires of anything published: a small
   * photo is never enlarged into detail it never had. `withoutEnlargement` is what enforces it, so
   * it gets a test rather than a comment — an encoder option is one edit away from being dropped.
   */
  it("never upscales a source smaller than the bound", async () => {
    const meta = await sharp(
      await sharpResizer.toWebp(await png(64, 48), PLACE_FULL_PX, WEBP_QUALITY),
    ).metadata();
    expect(meta.width).toBe(64);
    expect(meta.height).toBe(48);
  });

  it("drops EXIF, because the re-encode carries no metadata forward", async () => {
    const withExif = await sharp(await png(300, 200))
      .withMetadata({ exif: { IFD0: { Copyright: "someone" } } })
      .jpeg()
      .toBuffer();
    const meta = await sharp(
      await sharpResizer.toWebp(withExif, PLACE_THUMB_PX, WEBP_QUALITY),
    ).metadata();
    expect(meta.exif).toBeUndefined();
  });

  it("declares the type it actually produces", async () => {
    const meta = await sharp(
      await sharpResizer.toWebp(await png(300, 200), 128, WEBP_QUALITY),
    ).metadata();
    expect(`image/${meta.format}`).toBe(PLACE_MEDIA_TYPE);
  });
});
