import { tilePath, httpVolumeReader, openVolume, type CellTile } from "@beaconsgg/atlas-volume";
import { cellBounds } from "@beaconsgg/geo";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OutboundHttp, OutboundLimiter, type OutboundClient } from "../common/outbound-http";
import { AtlasConnector } from "../places/connectors/atlas";
import { BASE, CELL, DICT, IMPOSTOR, PUBLISHER, lighthouse, volume } from "./atlas-fixture";

/**
 * The connector, against an in-memory volume served through a faked `fetch`.
 *
 * A real tree of files is what `apps/atlas/cartographer`'s own round-trip test covers; what needs testing
 * here is the *consumer's* half — the refusals, the re-validation, and the two things that would break the
 * runner if got wrong (an empty `media` array, and returning `[]` for a tile it could not read).
 */

function clientFor(files: Record<string, string>): OutboundClient {
  const http = new OutboundHttp({
    userAgent: "test",
    timeoutMs: 100,
    fetchImpl: (url) => {
      const path = String(url).slice(`${BASE}/`.length);
      const text = files[path];
      if (text === undefined) {
        return Promise.resolve({
          ok: false,
          status: 404,
          headers: { get: () => null },
          text: () => Promise.resolve(""),
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: () => Promise.resolve(text),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      });
    },
  });
  return { http, limiter: new OutboundLimiter(() => 0) };
}

// Mirrors the service's production sequence: open (verify) first, then hand the connector a
// verified root — a connector never establishes trust itself.
const connect = async (files: Record<string, string>, publisher = PUBLISHER.did) => {
  const client = clientFor(files);
  const reader = httpVolumeReader(BASE, (url) =>
    client.http.getText(url, { limiter: client.limiter }),
  );
  const root = await openVolume(reader, {
    expectedPublisher: publisher,
    label: "atlas:us-west",
    warn: (m) => console.warn(m),
  });
  return new AtlasConnector(reader, root, client, "us-west", "test.example");
};

let tile: CellTile;
beforeEach(() => {
  tile = { cell: CELL, revision: 1, places: [lighthouse()] };
});

describe("mapping a tile record", () => {
  it("names itself for the volume, so provenance reads correctly", async () => {
    expect((await connect(volume(tile))).id).toBe("atlas:us-west");
  });

  it("de-interns the dictionary and derives the server's own sourceId form", async () => {
    const places = await (await connect(volume(tile))).fetchChunk(cellBounds(CELL), undefined);
    expect(places).toHaveLength(1);
    const place = places[0]!;
    // `way/586464226`, not the builder's `osm:w/586464226` — or it matches nothing the osm connector wrote.
    expect(place.sourceId).toBe("way/586464226");
    expect(place.fields.category).toBe("landmark");
    expect(place.fields.subcategory).toBe("structure");
    expect(place.fields.name).toBe("Mukilteo Lighthouse");
    expect(place.fields.point).toEqual({ lat: 47.94766, lng: -122.30474 });
    expect(place.fields.descriptionCredit).toEqual(DICT.credits[0]);
    // Every contributing source's line, so the volume stays lawfully redistributable.
    expect(place.attribution).toBe("© OpenStreetMap contributors (ODbL) · Wikipedia contributors");
  });

  it("offers the place's former ids for the runner to follow", async () => {
    tile.places[0] = { ...lighthouse(), aliases: ["01OLD"] };
    const places = await (await connect(volume(tile))).fetchChunk(cellBounds(CELL), undefined);
    expect(places[0]!.aliasSourceIds).toEqual(["01OLD"]);
  });

  /**
   * The trap: the runner's media policy tests `fields.media !== undefined`, so an empty array would count
   * as "this source supplies media", blank the place's photos and block the fallback. Absent, per-field
   * merge keeps whatever another source ingested.
   */
  it("omits media for a place with no photos — absent, never empty", async () => {
    const place = (await (await connect(volume(tile))).fetchChunk(cellBounds(CELL), undefined))[0]!;
    expect("media" in place.fields).toBe(false);
  });

  describe("a place that does carry photos", () => {
    const withPhotos = () => {
      const t: CellTile = { ...tile, places: [{ ...lighthouse() }] };
      t.places[0] = {
        ...lighthouse(),
        media: [
          {
            hash: "sha256:thumbAAA",
            role: "thumb",
            credit: 0,
            source: 1,
            author: "A photographer",
          },
          {
            hash: "sha256:fullAAA",
            role: "full",
            credit: 0,
            source: 1,
            author: "A photographer",
            sourceUrl: "https://commons.wikimedia.org/wiki/File:X.jpg",
          },
        ],
      };
      return t;
    };

    it("maps a pair with the hash spelled the way the media store spells it", async () => {
      const place = (
        await (await connect(volume(withPhotos()))).fetchChunk(cellBounds(CELL), undefined)
      )[0]!;
      // Bare base64url, no `sha256:` — `ingestTrusted` re-hashes and compares against exactly this.
      expect(place.fields.media?.map((m) => m.hash)).toEqual(["thumbAAA", "fullAAA"]);
      expect(place.fields.media?.map((m) => m.role)).toEqual(["thumb", "full"]);
      // The media **kind**, not the MIME type. `pickMedia`, `mediaPairs` and the game's `markerThumb`
      // all filter `m.type === "image"`, so "image/webp" here stores fine and shows nowhere.
      expect(place.fields.media?.map((m) => m.type)).toEqual(["image", "image"]);
    });

    it("resolves the fetch URL under the volume, through media.base", async () => {
      const place = (
        await (await connect(volume(withPhotos()))).fetchChunk(cellBounds(CELL), undefined)
      )[0]!;
      // `../media/` against `.../us-west/2026-08` — one segment up, not two.
      expect(place.fields.media?.[0]?.uris).toEqual([
        "https://atlas.example.org/us-west/media/th/thumbAAA.webp",
      ]);
    });

    /** The interned licence pair and the per-file author/page, reassembled into one credit. */
    it("rebuilds a full credit from the interned licence and the per-file fields", async () => {
      const place = (
        await (await connect(volume(withPhotos()))).fetchChunk(cellBounds(CELL), undefined)
      )[0]!;
      expect(place.fields.media?.[1]?.credit).toEqual({
        license: "CC BY-SA 4.0",
        author: "A photographer",
        sourceUrl: "https://commons.wikimedia.org/wiki/File:X.jpg",
      });
    });

    /**
     * The transport is what lets the runner fetch a non-`hash@host` address without widening
     * `mediaOriginUrl`, which untrusted `places.import` data also flows through.
     *
     * It **constructs** the URL from the verified hash rather than trusting the one in `uris` — so a
     * tampered `uris` cannot redirect the fetch, which is a stronger property than validating it and
     * needs no same-origin check to hold.
     */
    it("derives the fetch URL from the hash, ignoring whatever uris says", async () => {
      const connector = await connect(volume(withPhotos()));
      const place = (await connector.fetchChunk(cellBounds(CELL), undefined))[0]!;
      const entry = place.fields.media![0]!;
      const expected = "https://atlas.example.org/us-west/media/th/thumbAAA.webp";
      expect(connector.mediaTransport.origin(entry)).toBe(expected);
      // A rewritten pointer changes nothing: the hash is the input, not the URL.
      expect(connector.mediaTransport.origin({ ...entry, uris: ["https://evil.example/x"] })).toBe(
        expected,
      );
      expect(connector.mediaTransport.origin({ ...entry, uris: [] })).toBe(expected);
    });

    it("asserts the content type rather than leaving it to a mirror's headers", async () => {
      expect((await connect(volume(withPhotos()))).mediaTransport.type).toBe("image/webp");
    });
  });

  /**
   * `raw` participates in the runner's byte-identity `unchanged` check, and dictionary indices are
   * per-version — so carrying the tile record would make every place `updated` on any republish and
   * re-log the whole admin-conflict set.
   */
  it("carries no raw payload, so a republish does not churn every place", async () => {
    const place = (await (await connect(volume(tile))).fetchChunk(cellBounds(CELL), undefined))[0]!;
    expect(place.raw).toBeUndefined();
  });

  it("honours a category filter", async () => {
    const places = await (await connect(volume(tile))).fetchChunk(cellBounds(CELL), ["park"]);
    expect(places).toEqual([]);
  });

  it("returns nothing for a cell the volume does not hold, which is not a failure", async () => {
    const places = await (await connect(volume(tile))).fetchChunk(cellBounds("c22zn"), undefined);
    expect(places).toEqual([]);
  });
});

describe("re-validation — a signature proves provenance, not correctness", () => {
  it("drops a place whose category the server's enum cannot parse, and says so", async () => {
    tile.places[0] = { ...lighthouse(), category: 2 };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await (await connect(volume(tile))).fetchChunk(cellBounds(CELL), undefined)).toEqual([]);
    // Reported, not silent: a volume importing fewer places than it holds with nothing recording it is
    // the same failure class as a throttled fetch recorded as "this place has no photo".
    expect(warn.mock.calls.flat().join(" ")).toMatch(/refused 1 on category/);
    warn.mockRestore();
  });

  /** The place still imports — a bad slug is not a reason to lose the place. */
  it("drops an invalid subcategory but keeps the place", async () => {
    tile.places[0] = { ...lighthouse(), subcategory: 1 };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const place = (await (await connect(volume(tile))).fetchChunk(cellBounds(CELL), undefined))[0]!;
    expect(place.fields.subcategory).toBeUndefined();
    expect(place.fields.category).toBe("landmark");
    expect(warn.mock.calls.flat().join(" ")).toMatch(/refused 1 on subcategory/);
    warn.mockRestore();
  });

  it("drops a place whose point is out of range", async () => {
    tile.places[0] = { ...lighthouse(), point: [-122.3, 91] };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await (await connect(volume(tile))).fetchChunk(cellBounds(CELL), undefined)).toEqual([]);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/refused 1 on point/);
    warn.mockRestore();
  });
});

describe("refusals", () => {
  /** *"A volume whose signature does not match a configured key is not read at all"* (the integration spec, §2). */
  it("refuses a volume signed by a publisher the operator did not configure", async () => {
    await expect(connect(volume(tile, {}, IMPOSTOR))).rejects.toThrow(/refusing volume/);
  });

  /**
   * **Throws, never returns `[]`.** The runner has no per-chunk catch and its retirement pass sits outside
   * the try — so a swallowed read failure would mark the chunk done and retire every place in it.
   */
  it("throws on a tile whose bytes do not match the hash the index advertised", async () => {
    const files = volume(tile);
    files[tilePath(CELL)] = JSON.stringify({ ...tile, places: [] });
    await expect((await connect(files)).fetchChunk(cellBounds(CELL), undefined)).rejects.toThrow(
      /does not match the hash/,
    );
  });

  it("throws on a tampered index", async () => {
    const files = volume(tile);
    files["index.json"] = JSON.stringify({ cellPrecision: 5, cells: [] });
    // The index is hash-checked at open, before a connector exists to fetch anything.
    await expect(connect(files)).rejects.toThrow(/does not match the hash/);
  });

  it("refuses a volume tiled at a precision this server does not chunk at", async () => {
    await expect(connect(volume(tile, { cellPrecision: 6 }))).rejects.toThrow(
      /one chunk would not be one tile/,
    );
  });

  it("refuses a format version it does not read", async () => {
    await expect(connect(volume(tile, { format: 2 }))).rejects.toThrow(
      /format 2 is not one this server reads/,
    );
  });
});
