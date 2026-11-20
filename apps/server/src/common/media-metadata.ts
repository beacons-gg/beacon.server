import exifr from "exifr";

/**
 * exifr options that surface ONLY privacy-relevant metadata blocks (EXIF / GPS / XMP / IPTC) and skip
 * structural headers — a clean PNG's IHDR (width/height/bit-depth) would otherwise look like "metadata".
 * Verified: a clean image parses to `undefined`; an image carrying a GPS/EXIF block parses to a
 * populated object.
 */
const PRIVACY_BLOCKS = {
  ifd0: false,
  ihdr: false,
  jfif: false,
  icc: false,
  thumbnail: false,
  interop: false,
  exif: true,
  gps: true,
  xmp: true,
  iptc: true,
} as const;

/**
 * True if `bytes` carry EXIF / GPS / XMP / IPTC metadata (`doc/spec/mailbox-and-media.md` §5.5).
 * The media host **detect-and-rejects** dirty uploads rather than stripping them — stripping would
 * rewrite the bytes and therefore change the signed content hash. Detection sniffs the actual
 * bytes, so a spoofed `type` can't smuggle a dirty **image** through.
 *
 * **Scope: images only.** `exifr` understands image containers; bytes it can't parse (audio, or an
 * unknown format) yield no readable metadata and are treated as **clean**. So the server-enforced
 * privacy guarantee covers image types only — for any non-image type on the allowlist (e.g.
 * `audio/mpeg`), stripping metadata is the **client's** responsibility and the server cannot verify
 * it. This is the narrowed beta privacy claim (`doc/spec/mailbox-and-media.md` §5.5); keep
 * `BEACON_MEDIA_TYPES` to types you accept under that split.
 */
export async function containsPrivacyMetadata(bytes: Buffer): Promise<boolean> {
  try {
    // exifr accepts these per-block boolean toggles at runtime (verified), but its `Options` type
    // declares the block keys as objects — cast through the documented parameter type.
    const opts = PRIVACY_BLOCKS as unknown as Parameters<typeof exifr.parse>[1];
    const parsed: unknown = await exifr.parse(bytes, opts);
    return parsed != null && typeof parsed === "object" && Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}
