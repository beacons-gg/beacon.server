/**
 * The sharp-backed WebP re-encode — one encoder, two callers.
 *
 * A Beacon server re-encodes images it ingests itself; Cartographer's media crawl re-encodes the ones it
 * publishes into a volume. Both are apps, an app never imports an app, so the encoder lives here.
 *
 * **The sizes are not here.** They are in `@beaconsgg/protocol-types` (`PLACE_THUMB_PX`/`PLACE_FULL_PX`),
 * because the admin console's browser canvas encoder spends the sizes too and cannot link a native
 * dependency. A sharp-bearing package would have left that copy in place, which is the duplication
 * worth removing.
 *
 * And **not re-exported from here**, which the first cut did as a convenience: within one app it immediately
 * produced two import paths for the same constant, and it made an RN/browser-safe number reachable only
 * through a package carrying a native binary. One address each.
 *
 * **The quality is here** ({@link WEBP_QUALITY}): it is this encoder's setting, not part of the
 * wire, so core 0.4.3 deprecated its copy. Only this encoder's callers read it: the browser canvas
 * counts quality from 0 to 1, for a different codec.
 *
 * **Cartographer is the only caller.** A Beacon server stores Atlas's photos unmodified
 * (`apps/atlas/doc/spec/beacon-integration.md` §5) and encodes nothing, so this could fold back
 * into Cartographer. Recorded rather than presented as a permanent seam.
 */
import sharp from "sharp";

/** The WebP quality (0 to 100) the media crawl encodes at, for the thumb and the full image alike. */
export const WEBP_QUALITY = 72;

/** Resize+encode seam (default: {@link sharpResizer}), injectable so tests avoid the native dep. */
export interface ImageResizer {
  toWebp(bytes: Buffer, maxPx: number, quality: number): Promise<Buffer>;
}

/**
 * The default sharp-backed resizer: EXIF-orient, fit-inside `maxPx`, encode WebP (metadata dropped).
 *
 * `withoutEnlargement` is not only an efficiency choice — it is why nothing in this pipeline can
 * upscale, which `apps/atlas/doc/spec/sources.md` §3 requires of any published imagery: a small
 * photo stays small rather than being enlarged into detail it never had.
 */
export const sharpResizer: ImageResizer = {
  toWebp(bytes, maxPx, quality) {
    return sharp(bytes)
      .rotate() // bake in EXIF orientation before the WebP re-encode drops metadata
      .resize(maxPx, maxPx, { fit: "inside", withoutEnlargement: true })
      .webp({ quality })
      .toBuffer();
  },
};
