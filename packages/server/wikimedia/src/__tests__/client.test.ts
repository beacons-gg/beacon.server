import { describe, expect, it, vi } from "vitest";
import { byteUrl, WikimediaClient } from "../client";

/** A client whose every request succeeds with `body` — the shared happy-path mock. */
const clientFor = (body: unknown, spy?: (url: URL) => void): WikimediaClient =>
  new WikimediaClient({
    userAgent: "t",
    minIntervalMs: 0,
    sleep: () => Promise.resolve(),
    fetchImpl: ((url: URL) => {
      spy?.(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: () => Promise.resolve(body),
      } as unknown as Response);
    }) as unknown as typeof fetch,
  });

/**
 * The client's job at this seam is to say *whether Wikimedia answered*, because the caller leaves
 * unanswered rows unstamped for a re-run. Getting that wrong in either direction is expensive: report
 * a refusal as unanswered and a permanently-bad batch is re-asked forever, pinning the candidate
 * window the stamp exists to advance; report a give-up as an answer and a transient throttle becomes
 * a permanent "this place has no article".
 */
describe("WikimediaClient — did Wikimedia answer?", () => {
  const client = (fetchImpl: typeof fetch) =>
    new WikimediaClient({
      userAgent: "test (ops@example.com)",
      minIntervalMs: 0,
      fetchImpl,
      sleep: () => Promise.resolve(),
    });

  const res = (opts: {
    status?: number;
    body?: unknown;
    headers?: Record<string, string>;
  }): Response =>
    ({
      ok: (opts.status ?? 200) < 400,
      status: opts.status ?? 200,
      headers: { get: (n: string) => opts.headers?.[n.toLowerCase()] ?? null },
      json: () => Promise.resolve(opts.body ?? {}),
    }) as unknown as Response;

  it("reports an answer as available, even when it is empty", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res({ body: { entities: {} } }));
    const out = await client(fetchImpl as unknown as typeof fetch).enwikiTitlesForQids(["Q1"]);
    expect(out).toMatchObject({ unavailable: false });
    expect(out.titles.size).toBe(0);
  });

  it("reports retry exhaustion as unavailable", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(res({ status: 429, headers: { "retry-after": "1" } }));
    const out = await client(fetchImpl as unknown as typeof fetch).articles(["X"]);
    expect(out.unavailable).toBe(true);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1); // it did retry before giving up
  });

  /** A `Retry-After` we may not wait out is a give-up, not a wait — one batch can't pin a 53k-row run. */
  it("gives up rather than wait out an unreasonable Retry-After, without sleeping", async () => {
    const slept: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(res({ status: 429, headers: { "retry-after": "3600" } }));
    const c = new WikimediaClient({
      userAgent: "t",
      minIntervalMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });
    expect((await c.articles(["X"])).unavailable).toBe(true);
    expect(slept).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  /** A 4xx that isn't throttling IS an answer — deliberately not unavailable, or we'd re-ask forever. */
  it("reports a non-throttling refusal as answered, so the row gets stamped", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res({ status: 400 }));
    const out = await client(fetchImpl as unknown as typeof fetch).commonsFiles(["File:X.jpg"]);
    expect(out).toMatchObject({ unavailable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // and not retried
  });

  /**
   * The third state, and the one the concordance leans on hardest: Wikidata saying "no such entity"
   * is knowledge worth keeping, while never answering is not. A caller that saw one bucket would
   * either re-ask about a deleted QID on every build or stamp a throttle as "this QID does not exist".
   */
  it("separates an entity Wikidata says is absent from a batch it never answered", async () => {
    const answered = vi.fn().mockResolvedValue(
      res({
        body: { entities: { Q1: { claims: {} }, Q2: { missing: true } } },
      }),
    );
    const out = await client(answered as unknown as typeof fetch).entities(["Q1", "Q2"]);
    expect(out.unavailable).toBe(false);
    expect([...out.entities.keys()]).toEqual(["Q1"]);
    expect([...out.absent]).toEqual(["Q2"]);

    const refused = vi.fn().mockResolvedValue(res({ status: 429 }));
    const gaveUp = await client(refused as unknown as typeof fetch).entities(["Q1", "Q2"]);
    expect(gaveUp.unavailable).toBe(true);
    // Nothing learned, so nothing claimed — in particular Q2 is NOT reported absent.
    expect(gaveUp.entities.size).toBe(0);
    expect(gaveUp.absent.size).toBe(0);
  });
});

/**
 * Claim flattening, which is where a caller's questions actually get answered — "does this entity have
 * coordinates", "what NRHP number does it assert". Both are load-bearing for identity, and both are
 * wrong if a snak that carries no value is counted as one.
 */
describe("WikidataValue — flattening a claim", () => {
  const withClaims = async (claims: unknown) => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve({ entities: { Q1: { claims } } }),
    } as unknown as Response);
    const c = new WikimediaClient({
      userAgent: "t",
      minIntervalMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
    });
    return (await c.entities(["Q1"])).entities.get("Q1");
  };

  const snak = (value: unknown, snaktype = "value") => ({
    mainsnak: { snaktype, datavalue: { value } },
  });

  it("keeps each datatype as itself rather than coercing to text", async () => {
    const entity = await withClaims({
      P649: [snak("77001360")],
      P625: [
        snak({
          latitude: 47.94766,
          longitude: -122.30474,
          globe: "http://www.wikidata.org/entity/Q2",
        }),
      ],
      P31: [snak({ "entity-type": "item", id: "Q39715" })],
    });
    expect(entity?.claims["P649"]).toEqual([{ kind: "string", value: "77001360" }]);
    expect(entity?.claims["P625"]).toEqual([
      { kind: "coordinate", lat: 47.94766, lng: -122.30474 },
    ]);
    expect(entity?.claims["P31"]).toEqual([{ kind: "item", id: "Q39715" }]);
  });

  /**
   * `somevalue` means "there is a coordinate and nobody recorded it". Counting it would make the
   * has-coordinates test — the one that tells a lighthouse from the company that operates 54 cameras —
   * true for an entity that has explicitly declined to say where it is.
   */
  it("drops a snak with no value, and the property with it when that is all it had", async () => {
    const entity = await withClaims({
      P625: [snak(undefined, "somevalue"), snak(undefined, "novalue")],
      P18: [snak(undefined, "somevalue"), snak("Real.jpg")],
    });
    expect(entity?.claims["P625"]).toBeUndefined();
    expect(entity?.claims["P18"]).toEqual([{ kind: "string", value: "Real.jpg" }]);
  });

  /** An unmodelled datatype (quantity, time, monolingual text) is skipped, never stringified. */
  it("skips a datatype it does not model", async () => {
    const entity = await withClaims({ P2044: [snak({ amount: "+30", unit: "Q11573" })] });
    expect(entity?.claims["P2044"]).toBeUndefined();
  });
});

/**
 * The preflight. `apps/atlas/doc/spec/place-identity.md` §2 asks for it by name because a property
 * id that changed meaning resolves nothing while looking exactly like a region with no
 * cross-references — and existence alone does not catch it, since P8460 and P2528 are live ids
 * meaning something else entirely.
 */
describe("properties — the concordance preflight", () => {
  it("returns datatype and label, and reports an unknown id as absent", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () =>
        Promise.resolve({
          entities: {
            P649: { datatype: "external-id", labels: { en: { value: "NRHP reference number" } } },
            P9999999: { missing: true },
            // A well-formed reply with no datatype is not a property — treated as absent rather
            // than as a property whose datatype is the empty string.
            Q5: { labels: { en: { value: "human" } } },
          },
        }),
    } as unknown as Response);
    const c = new WikimediaClient({
      userAgent: "t",
      minIntervalMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
    });
    const out = await c.properties(["P649", "P9999999", "Q5"]);
    expect(out.properties.get("P649")).toEqual({
      datatype: "external-id",
      label: "NRHP reference number",
    });
    expect([...out.absent].sort()).toEqual(["P9999999", "Q5"]);
  });
});

/**
 * `commonsFiles` is the media crawl's whole metadata pass: one request has to answer the licence question,
 * build a republishable credit, and say where the bytes are. It used to answer only the first.
 */
describe("WikimediaClient.commonsFiles — the full credit", () => {
  const page = {
    title: "File:X Y.jpg",
    imageinfo: [
      {
        extmetadata: {
          LicenseShortName: { value: "CC BY-SA 4.0" },
          Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Msact">Msact</a>' },
          LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0" },
        },
        url: "https://upload.wikimedia.org/wikipedia/commons/6/6b/X_Y.jpg",
        descriptionurl: "https://commons.wikimedia.org/wiki/File:X_Y.jpg",
        thumburl:
          "https://upload.wikimedia.org/wikipedia/commons/thumb/6/6b/X_Y.jpg/1024px-X_Y.jpg",
        width: 3808,
        height: 2696,
        mime: "image/jpeg",
      },
    ],
  };

  it("reads licence, author, licence URL and source page in one call", async () => {
    const out = await clientFor({ query: { pages: [page] } }).commonsFiles(["File:X_Y.jpg"], 1024);
    expect(out.files.get("File:X Y.jpg")).toEqual({
      license: "CC BY-SA 4.0",
      author: "Msact", // the HTML Commons actually returns, stripped
      licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0",
      sourceUrl: "https://commons.wikimedia.org/wiki/File:X_Y.jpg",
      url: page.imageinfo[0]!.url,
      thumbUrl: page.imageinfo[0]!.thumburl,
      width: 3808,
      height: 2696,
      mime: "image/jpeg",
    });
  });

  it("asks for a width-scaled rendering only when one is wanted", async () => {
    const urls: URL[] = [];
    await clientFor({ query: { pages: [page] } }, (u) => urls.push(u)).commonsFiles(["File:A.jpg"]);
    expect(urls[0]?.searchParams.get("iiurlwidth")).toBeNull();
    await clientFor({ query: { pages: [page] } }, (u) => urls.push(u)).commonsFiles(
      ["File:A.jpg"],
      1024,
    );
    expect(urls[1]?.searchParams.get("iiurlwidth")).toBe("1024");
  });

  /** The licence is still the gate: a file with none is one we may not redistribute, whatever else it has. */
  it("still gates on a resolvable licence", async () => {
    const bare = { title: "File:No.jpg", imageinfo: [{ url: "https://u/x.jpg", width: 10 }] };
    const out = await clientFor({ query: { pages: [bare] } }).commonsFiles(["File:No.jpg"]);
    expect(out.files.get("File:No.jpg")?.license).toBeUndefined();
  });

  it("omits absent fields rather than setting them undefined", async () => {
    const out = await clientFor({
      query: { pages: [{ title: "File:B.jpg", imageinfo: [{}] }] },
    }).commonsFiles(["File:B.jpg"]);
    expect(Object.keys(out.files.get("File:B.jpg") ?? {})).toEqual([]);
  });
});

/**
 * The upscale guard. MediaWiki answers `iiurlwidth=1024` for a 662px-wide original with a *1024px*
 * thumbnail — measured on `File:HPMS.jpg`. Publishing that would make Atlas an upscaler, which
 * `apps/atlas/doc/spec/sources.md` §3 rules out, and the re-encode's `withoutEnlargement` cannot
 * undo an enlargement that already happened upstream.
 */
describe("byteUrl", () => {
  const orig = "https://u/original.jpg";
  const thumb = "https://u/thumb/1024px-original.jpg";

  it("takes the original when it is no wider than we want", () => {
    expect(byteUrl({ width: 662, url: orig, thumbUrl: thumb }, 1024)).toBe(orig);
    expect(byteUrl({ width: 1024, url: orig, thumbUrl: thumb }, 1024)).toBe(orig);
  });

  it("takes the scaled rendering only when the original is genuinely bigger", () => {
    expect(byteUrl({ width: 3808, url: orig, thumbUrl: thumb }, 1024)).toBe(thumb);
  });

  it("falls back to the original when no rendering was offered", () => {
    expect(byteUrl({ width: 3808, url: orig }, 1024)).toBe(orig);
  });

  it("has nothing to fetch for a file with no URL at all", () => {
    expect(byteUrl({ license: "CC0" }, 1024)).toBeUndefined();
  });
});

/**
 * Byte fetches get the same three-state treatment as the batched reads, because the throttle that
 * motivated Atlas was on bytes: a 404 is knowledge, a 429 we cannot wait out is not.
 */
describe("WikimediaClient.bytes", () => {
  const byteClient = (
    fetchImpl: unknown,
    sleep: (ms: number) => Promise<void> = () => Promise.resolve(),
  ) =>
    new WikimediaClient({
      userAgent: "t",
      minIntervalMs: 0,
      sleep,
      fetchImpl: fetchImpl as typeof fetch,
    });

  const byteRes = (opts: {
    status?: number;
    body?: Buffer;
    headers?: Record<string, string>;
  }): Response =>
    ({
      ok: (opts.status ?? 200) < 400,
      status: opts.status ?? 200,
      headers: { get: (n: string) => opts.headers?.[n.toLowerCase()] ?? null },
      // `Buffer.from([9]).buffer` is the whole pooled ArrayBuffer (8 KiB), not one byte — copy it out,
      // or a 1-byte body arrives looking oversize.
      arrayBuffer: () => Promise.resolve(new Uint8Array(opts.body ?? Buffer.alloc(0)).buffer),
    }) as unknown as Response;

  it("returns the bytes and the declared type", async () => {
    const body = Buffer.from([1, 2, 3, 4]);
    const out = await byteClient(
      vi.fn().mockResolvedValue(byteRes({ body, headers: { "content-type": "image/jpeg" } })),
    ).bytes("https://u/x.jpg", 1000);
    expect(out).toMatchObject({ kind: "ok", type: "image/jpeg" });
  });

  it("calls a 404 refused — an answer, recorded once and never re-asked", async () => {
    const out = await byteClient(vi.fn().mockResolvedValue(byteRes({ status: 404 }))).bytes(
      "https://u/x.jpg",
      1000,
    );
    expect(out).toEqual({ kind: "refused", reason: "http-404" });
  });

  it("calls a throttle we cannot wait out unanswered, so the file stays retryable", async () => {
    const out = await byteClient(
      vi.fn().mockResolvedValue(byteRes({ status: 429, headers: { "retry-after": "3600" } })),
    ).bytes("https://u/x.jpg", 1000);
    expect(out).toEqual({ kind: "unanswered" });
  });

  it("waits out a short Retry-After and succeeds on the retry", async () => {
    const slept: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(byteRes({ status: 429, headers: { "retry-after": "1" } }))
      .mockResolvedValueOnce(byteRes({ body: Buffer.from([9]) }));
    const out = await byteClient(fetchImpl, (ms) => {
      slept.push(ms);
      return Promise.resolve();
    }).bytes("https://u/x.jpg", 1000);
    expect(out).toMatchObject({ kind: "ok" });
    expect(slept).toEqual([1000]); // it waited as asked, rather than backing off on its own schedule
  });

  it("refuses an oversize file on the declared length, before pulling the body", async () => {
    const arrayBuffer = vi.fn();
    const out = await byteClient(
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: (n: string) => (n.toLowerCase() === "content-length" ? "999999" : null) },
        arrayBuffer,
      }),
    ).bytes("https://u/x.jpg", 1000);
    expect(out).toEqual({ kind: "refused", reason: "too-large" });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  /** `content-length` is optional and may lie, so the measured size is what actually binds. */
  it("refuses an oversize file that declared nothing", async () => {
    const out = await byteClient(
      vi.fn().mockResolvedValue(byteRes({ body: Buffer.alloc(2000) })),
    ).bytes("https://u/x.jpg", 1000);
    expect(out).toEqual({ kind: "refused", reason: "too-large" });
  });
});

/**
 * The two Commons lookups the geo stage leans on. Both keep the three-state contract; the shapes
 * under test are the ones a caller cannot see go wrong — a redlink category that still has members,
 * and a geotagged page that resolves to something other than a file.
 */
describe("categoryFiles / titlesForPageIds — the geo stage's lookups", () => {
  it("lists a category's files and reports it existing", async () => {
    const out = await clientFor({
      query: {
        pages: [{ title: "Category:X", missing: undefined }],
        categorymembers: [{ title: "File:A.jpg" }, { title: "File:B.jpg" }],
      },
    }).categoryFiles("Category:X");
    expect(out).toMatchObject({ exists: true, unavailable: false });
    expect(out.files).toEqual(["File:A.jpg", "File:B.jpg"]);
  });

  /** A category page can be a redlink and still contain files — that is not "absent". */
  it("treats a redlink category with members as existing", async () => {
    const out = await clientFor({
      query: {
        pages: [{ title: "Category:X", missing: true }],
        categorymembers: [{ title: "File:A.jpg" }],
      },
    }).categoryFiles("Category:X");
    expect(out.exists).toBe(true);
  });

  it("reports no-page-and-no-members as not existing", async () => {
    const out = await clientFor({
      query: { pages: [{ title: "Category:X", missing: true }], categorymembers: [] },
    }).categoryFiles("Category:X");
    expect(out).toMatchObject({ exists: false, files: [] });
  });

  it("resolves page ids to titles, and buckets deleted and non-File pages as missing", async () => {
    const out = await clientFor({
      query: {
        pages: [
          { pageid: 1, ns: 6, title: "File:A.jpg" },
          { pageid: 2, missing: true },
          { pageid: 3, ns: 0, title: "Some gallery" },
        ],
      },
    }).titlesForPageIds([1, 2, 3, 4]);
    expect(out.titles.get(1)).toBe("File:A.jpg");
    expect(out.missing.has(2)).toBe(true);
    expect(out.missing.has(3)).toBe(true); // coordinates on a gallery page, not a file
    // 4 was never mentioned — neither map holds it, so the caller leaves it unanswered.
    expect(out.titles.has(4) || out.missing.has(4)).toBe(false);
  });
});
