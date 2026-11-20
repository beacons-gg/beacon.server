import { describe, expect, it } from "vitest";
import {
  bareCommonsName,
  commonsCategoryTitle,
  commonsFileTitle,
  commonsFileTitleFromUrl,
  IMAGE_TAGS,
  osmSourceId,
  WIKIPEDIA_CREDIT,
} from "../osm-refs";

describe("osmSourceId", () => {
  it("renders the Overpass-parity form every ingestion path must agree on", () => {
    // A divergent spelling does not error — it duplicates every place, because `upsert` resolves
    // identity on (source, sourceId). That silence is why this is shared rather than restated.
    expect(osmSourceId("N", "1")).toBe("node/1");
    expect(osmSourceId("W", "586464226")).toBe("way/586464226");
    expect(osmSourceId("R", "7")).toBe("relation/7");
  });

  it("returns nothing for an unrecognized type rather than inventing a prefix", () => {
    expect(osmSourceId("X", "1")).toBeUndefined();
    expect(osmSourceId("", "1")).toBeUndefined();
  });
});

describe("commonsCategoryTitle", () => {
  it("prefixes a bare P373 name and folds underscores to the form the API replies in", () => {
    // One category, two tag spellings — unfolded, the tier-2 bridge and the category cache both hold
    // two keys for it and each misses the other's.
    expect(commonsCategoryTitle("Museum of Death")).toBe("Category:Museum of Death");
    expect(commonsCategoryTitle("Category:Museum_of_Death")).toBe("Category:Museum of Death");
  });
});

describe("commonsFileTitle", () => {
  it("normalizes to the form MediaWiki replies in — spaces, not underscores", () => {
    // The rule whose absence rejected *every* lead image once: MediaWiki treats `_` and ` ` as the same
    // title character but always answers with spaces, while `pageimage` hands them out with underscores.
    expect(commonsFileTitle("Tunnel_View,_Yosemite_NP.jpg")).toBe(
      "File:Tunnel View, Yosemite NP.jpg",
    );
  });

  it("accepts a bare name, a prefixed one, or a padded one, and is idempotent", () => {
    expect(commonsFileTitle("Foo.jpg")).toBe("File:Foo.jpg");
    expect(commonsFileTitle("File:Foo.jpg")).toBe("File:Foo.jpg");
    expect(commonsFileTitle("  file:Foo.jpg ")).toBe("File:Foo.jpg");
    // Trim before stripping: the `^File:` anchor can't match past leading whitespace, so the other
    // order doubles the prefix on a padded value.
    expect(commonsFileTitle(commonsFileTitle("A_B.jpg"))).toBe("File:A B.jpg");
  });

  it("takes the file out of either URL form OSM tags actually use", () => {
    // Both measured on a real extract; the wiki-page form is the commoner one.
    expect(commonsFileTitle("https://commons.wikimedia.org/wiki/File:A_b.jpg")).toBe(
      "File:A b.jpg",
    );
    expect(
      commonsFileTitle("https://upload.wikimedia.org/wikipedia/commons/a/ab/Example.jpg"),
    ).toBe("File:Example.jpg");
  });

  it("takes the real file out of a thumb URL, not the scaled render's name", () => {
    // The last path segment would be `800px-Example.jpg` — a file that does not exist on Commons.
    expect(
      commonsFileTitle(
        "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Example.jpg/800px-Example.jpg",
      ),
    ).toBe("File:Example.jpg");
  });

  it("percent-decodes a URL's file name", () => {
    expect(commonsFileTitle("https://commons.wikimedia.org/wiki/File:A%20b%26c.jpg")).toBe(
      "File:A b&c.jpg",
    );
  });
});

describe("bareCommonsName", () => {
  it("keeps underscores — a URL builder wants the un-spaced form", () => {
    // Both forms are accepted by Special:FilePath and the upload host, and percent-encoding a space is
    // one more thing to get wrong.
    expect(bareCommonsName("File:A_b.jpg")).toBe("A_b.jpg");
    expect(bareCommonsName("  A_b.jpg ")).toBe("A_b.jpg");
  });
});

describe("commonsFileTitleFromUrl", () => {
  it("distinguishes a URL that names a file from one that doesn't", () => {
    // The caller needs the difference: a Wikimedia URL from some other host is still fetchable, but
    // there is no title to look a credit up by.
    expect(commonsFileTitleFromUrl("https://commons.wikimedia.org/wiki/File:A_b.jpg")).toBe(
      "File:A b.jpg",
    );
    expect(
      commonsFileTitleFromUrl("https://maps.wikimedia.org/img/osm-intl,5,0,0.png"),
    ).toBeUndefined();
  });
});

describe("the image-tag list", () => {
  it("is one list, in the order stage 4 reads it", () => {
    expect(IMAGE_TAGS).toEqual(["image", "wikimedia_commons", "wikidata", "brand:wikidata"]);
  });

  // `PREFERRED_IMAGE_TAGS`/`hasPreferredImageRef` were retired with `osm-enrich`: they answered "is the
  // mapper's reference better than what the enrichment job found?", and there is no enrichment job to
  // outrank. Stage 4 ranks every reference against every other through `(kind, claimedBy)` instead.
});

describe("the shared constants", () => {
  it("credits Wikipedia under the version its extracts are licensed as", () => {
    // Shared because it is an attribution fact: the copy that isn't updated when Wikimedia moves
    // version (3.0 → 4.0 has happened) is the one already baked into published data.
    expect(WIKIPEDIA_CREDIT.license).toBe("CC BY-SA 4.0");
    expect(WIKIPEDIA_CREDIT.licenseUrl).toContain("by-sa/4.0");
  });
});
