import { commonsFileTitle } from "@beaconsgg/place-taxonomy";

/**
 * The Wikimedia API surface the operator-side jobs use — batched reads over an injected `fetch`, so
 * the response-shaping (which is where the bugs live) is testable without a network.
 *
 * All of them are GETs against public read APIs. Etiquette is not optional here: the Wikimedia
 * User-Agent policy requires a descriptive agent with contact info, `maxlag` yields to a lagging
 * replica rather than piling on, and a `429`/`Retry-After` is honoured rather than retried
 * immediately. An operator running a continent-sized extract is a heavy anonymous client and should
 * behave like a polite one.
 *
 * The canonicalizer comes from `@beaconsgg/place-taxonomy`, which reads backwards by package name and is
 * right by content: `commonsFiles` has to key its result by the same title form its caller asked
 * with, and the shared Commons/Wikipedia reference vocabulary already lives there beside the OSM tags
 * that produce those titles. The alternatives were a second title normalizer or making the taxonomy
 * depend on an HTTP client.
 */

/**
 * MediaWiki's per-request caps for anonymous clients. Asking for more is a **refusal**, not a slower
 * answer, so a caller must chunk to these — and they live here, beside the calls they bound, because every
 * caller depends on them and a copy in each is a fact with no owner.
 */
export const BATCH = {
  /** `titles=` for `prop=extracts`, which is capped harder than a plain title list. */
  extracts: 20,
  /** `titles=` / `ids=` for everything else. */
  ids: 50,
} as const;

/** How many times a throttled or transient request is retried before the batch is given up on. */
const MAX_ATTEMPTS = 4;
/** Floor for a backoff wait, so a `Retry-After: 0` can't spin. */
const MIN_BACKOFF_MS = 500;
/**
 * Ceiling for one backoff wait. Mirrors the server's `OutboundHttp` default, and exists for the same
 * reason: `Retry-After` is a request, not an obligation, and one batch must not be able to pin a
 * 53,000-row run. Past it the batch is reported unavailable and retried on the next run instead.
 */
const MAX_BACKOFF_MS = 30_000;

export interface WikimediaOptions {
  /** Descriptive UA with contact info — required by Wikimedia's policy for anonymous API clients. */
  userAgent: string;
  /** Pause between requests, in ms. Serial by design; this is the whole rate control. */
  minIntervalMs: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** What an article yielded: its intro extract and the file name of its lead image, if any. */
export interface Article {
  title: string;
  extract?: string;
  imageFile?: string;
}

/**
 * A Commons file that exists, with the credit needed to republish it and the URL to fetch it from.
 *
 * **This used to be `{ license?: string }` — a yes/no — on the stated grounds that "the server's
 * ingestor does its own `extmetadata` lookup when it fetches the bytes, so duplicating it here
 * would be a second copy to keep in sync for no gain." That reasoning inverted when the crawl moved
 * offline** (`apps/atlas/doc/spec/cartographer.md` §1.4): Cartographer now fetches the bytes, so
 * this *is* the authoritative lookup, and `extmetadata` was being fetched twice across two programs
 * to answer one question — the other being `apps/atlas/osm-enrich`, since deleted, whose article
 * work Cartographer's own `wikipedia` stage absorbed.
 */
export interface CommonsFile {
  /** `LicenseShortName` — its presence is still the redistribution gate. */
  license?: string;
  /** `Artist`, with the markup stripped: Commons returns it as HTML. */
  author?: string;
  licenseUrl?: string;
  /** The file's own Commons page — where a credit points a reader, not where the bytes are. */
  sourceUrl?: string;
  /** The original's pixel width, and the reason {@link byteUrl} is not simply `thumbUrl`. */
  width?: number;
  height?: number;
  /** The original file's URL. */
  url?: string;
  /** A width-scaled rendering, when one was asked for — **may be an upscale**, see {@link byteUrl}. */
  thumbUrl?: string;
  mime?: string;
}

/**
 * The outcome of a byte fetch — three states, not two, for the same reason {@link Batch} exists.
 *
 * `refused` is an **answer** (a 404, an oversize file): terminal, record it and never ask again. `unanswered`
 * is a throttle we could not wait out: nothing is known, so a caller must leave it retryable. Collapsing
 * them is the bug that cost a snapshot 97% of its images.
 */
export type BytesResult =
  | { kind: "ok"; bytes: Buffer; type?: string }
  | { kind: "refused"; reason: string }
  | { kind: "unanswered" };

/**
 * Which URL to actually download, given the widest variant we want.
 *
 * **MediaWiki will upscale.** Asked for `iiurlwidth=1024`, `File:HPMS.jpg` (662×240) comes back
 * reporting a 1024-wide thumbnail. Fetching that and re-encoding it makes us an upscaler — the one
 * thing `apps/atlas/doc/spec/sources.md` §3 rules out by name — and `withoutEnlargement` on the
 * re-encode cannot help, because the enlargement already happened upstream. So the original is used
 * whenever it is no larger than we want.
 */
export function byteUrl(file: CommonsFile, maxPx: number): string | undefined {
  if (file.width !== undefined && file.width <= maxPx) return file.url;
  return file.thumbUrl ?? file.url;
}

/**
 * Carried on every batched read: **Wikimedia never answered this batch** — throttled past the retry
 * budget, or a lagging replica — as opposed to answering that there is nothing there.
 *
 * Those used to be the same empty result, which is a costly conflation in a job whose whole output is
 * negative knowledge. A given-up batch of 20 became 20 places recorded as having no article, stamped,
 * and never asked about again. A caller must be able to tell the two apart and leave those rows alone.
 */
export interface Batch {
  unavailable: boolean;
}

/**
 * One value of one Wikidata claim, flattened out of its snak.
 *
 * A discriminated union rather than a bare string because Wikidata's datatypes genuinely differ and
 * the difference is load-bearing for us: an `external-id` is a join key, a `globe-coordinate` says the
 * entity *is somewhere* (which is how we tell a place from the company that operates 54 of them), and
 * a `wikibase-item` is another QID. Flattening them all to strings would make "this entity has
 * coordinates" indistinguishable from "this entity's coordinates are the string `[object Object]`".
 *
 * Snaks with no value (`somevalue` / `novalue`) yield nothing at all — Wikidata saying "there is a
 * value but we don't know it" is not a value, and a caller counting claims must not count it as one.
 */
export type WikidataValue =
  | { kind: "string"; value: string }
  | { kind: "item"; id: string }
  | { kind: "coordinate"; lat: number; lng: number };

/** One Wikidata entity, narrowed to what the concordance and the media stage read. */
export interface WikidataEntity {
  /** Claim values by property id, in the order Wikidata listed them. */
  claims: Record<string, WikidataValue[]>;
  /** The `enwiki` sitelink, when asked for and present. */
  enwikiTitle?: string;
}

/** One Wikidata property, as the preflight checks it. */
export interface WikidataProperty {
  /** `external-id`, `globe-coordinate`, `commonsMedia`, … */
  datatype: string;
  /** English label — the half of the check that catches a *reused* id, not just a missing one. */
  label?: string;
}

const sleepDefault = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Default pacing between requests, in ms. Serial by design; this is the whole rate control. */
export const DEFAULT_INTERVAL_MS = 200;

/**
 * A client configured from the environment, refusing to run anonymously-and-namelessly.
 *
 * Wikimedia's policy requires a descriptive User-Agent with a way to be contacted, and an operator asking
 * about tens of thousands of entities is a heavy anonymous client. This is a **hard failure with the fix
 * in the message**, and it lives here because the two callers had drifted into two different policies —
 * one of them warning and then substituting an invented agent, which is this package breaking the rule its
 * own README states on the caller's behalf.
 */
export function clientFromEnv(
  env: Record<string, string | undefined>,
  prefix: string,
  /**
   * Which interval variable to read, when a caller needs **two clients with separate budgets**.
   *
   * `nextAllowedAt` is per-instance, so per-host pacing is two instances rather than a mechanism —
   * and the media crawl needs exactly that: its metadata pass talks to `commons.wikimedia.org` and
   * its byte pass to `upload.wikimedia.org`, which throttle independently. One shared interval
   * would make the slower host's budget bind on both for no benefit
   * (`apps/atlas/doc/spec/cartographer.md` §4).
   */
  intervalVar?: string,
): WikimediaClient {
  const userAgent = userAgentFromEnv(env, prefix);
  const suffix = intervalVar ?? "_INTERVAL_MS";
  const raw = env[`${prefix}${suffix}`];
  const minIntervalMs = raw === undefined || raw.trim() === "" ? DEFAULT_INTERVAL_MS : Number(raw);
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) {
    throw new Error(`${prefix}${suffix} must be a non-negative number of milliseconds`);
  }
  return new WikimediaClient({ userAgent, minIntervalMs });
}

/**
 * The operator's User-Agent, or the hard failure with the fix in the message — **the one validator** of
 * this variable. It lived only inside {@link clientFromEnv} until a stage that talks to a non-Wikimedia
 * API (NPS) needed the same contact-carrying identity without a Wikimedia client; a third inline check
 * with a third message is exactly the drift the docblock above describes.
 */
export function userAgentFromEnv(env: Record<string, string | undefined>, prefix: string): string {
  const userAgent = env[`${prefix}_USER_AGENT`]?.trim();
  if (!userAgent) {
    throw new Error(
      `${prefix}_USER_AGENT is not set. Wikimedia's policy requires a descriptive agent with a way ` +
        'to contact you, e.g. "beacon-atlas/1.0 (ops@example.com)".',
    );
  }
  return userAgent;
}

export class WikimediaClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private nextAllowedAt = 0;

  constructor(private readonly opts: WikimediaOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? sleepDefault;
  }

  /**
   * Map Wikidata QIDs to English article titles via their `enwiki` sitelink. This is what lets a job
   * reach the large share of OSM objects that carry `wikidata=Q…` but no `wikipedia=` tag.
   *
   * A projection of {@link entities}, asking only for sitelinks, rather than a second request builder:
   * the two were the same `wbgetentities` call with the same three-valued contract, and the duplicate
   * would have been the place where one of them forgot `maxlag`.
   */
  async enwikiTitlesForQids(
    qids: readonly string[],
  ): Promise<Batch & { titles: Map<string, string> }> {
    const { entities, unavailable } = await this.entities(qids, { props: ["sitelinks"] });
    const titles = new Map<string, string>();
    for (const [qid, entity] of entities) {
      if (entity.enwikiTitle) titles.set(qid, entity.enwikiTitle);
    }
    return { titles, unavailable };
  }

  /**
   * Wikidata entities — claims and the `enwiki` sitelink — for up to 50 QIDs at a time.
   *
   * **`absent` is not `unavailable`.** Wikidata answering "there is no such entity" is a *fact* worth
   * recording, so the caller never asks again; Wikidata never answering is not, and those QIDs must be
   * left unrecorded for the next run. They arrive here as two separate outputs because a caller that
   * cannot tell them apart eventually stamps a throttle as knowledge — the mistake this whole
   * `Batch` contract exists to prevent, which has cost us a snapshot's images once already.
   *
   * QIDs the batch simply did not mention are neither: the caller sees them in neither map and leaves
   * them alone.
   */
  async entities(
    qids: readonly string[],
    opts: { props?: readonly ("claims" | "sitelinks")[] } = {},
  ): Promise<Batch & { entities: Map<string, WikidataEntity>; absent: Set<string> }> {
    const entities = new Map<string, WikidataEntity>();
    const absent = new Set<string>();
    if (qids.length === 0) return { entities, absent, unavailable: false };
    const props = opts.props ?? ["claims", "sitelinks"];
    const { body, unavailable = false } = await this.get<WbGetEntities>(
      "https://www.wikidata.org/w/api.php",
      {
        action: "wbgetentities",
        ids: qids.join("|"),
        props: props.join("|"),
        // Harmless when sitelinks weren't asked for, and it keeps a 400-sitelink entity from being
        // shipped across the wire to have 399 of them thrown away here.
        sitefilter: "enwiki",
      },
    );

    for (const [qid, entity] of Object.entries(body?.entities ?? {})) {
      if (entity.missing !== undefined) {
        absent.add(qid);
        continue;
      }
      const title = entity.sitelinks?.enwiki?.title?.trim();
      entities.set(qid, {
        claims: flattenClaims(entity.claims),
        ...(title ? { enwikiTitle: title } : {}),
      });
    }
    return { entities, absent, unavailable };
  }

  /**
   * Datatype + English label for Wikidata *property* ids — the preflight a concordance runs first.
   *
   * `apps/atlas/doc/spec/place-identity.md` §2 asks for this by name: property ids get deprecated,
   * split and reused, and a property that quietly changed meaning resolves nothing while looking
   * exactly like a region with no cross-references. Checking existence alone is not enough — P8460
   * and P2528 are both live ids that mean "applies if regular expression matches" and "earthquake
   * magnitude" — so the label and the datatype are what a caller should assert against.
   */
  async properties(
    pids: readonly string[],
  ): Promise<Batch & { properties: Map<string, WikidataProperty>; absent: Set<string> }> {
    const properties = new Map<string, WikidataProperty>();
    const absent = new Set<string>();
    if (pids.length === 0) return { properties, absent, unavailable: false };
    const { body, unavailable = false } = await this.get<WbGetEntities>(
      "https://www.wikidata.org/w/api.php",
      { action: "wbgetentities", ids: pids.join("|"), props: "datatype|labels", languages: "en" },
    );
    for (const [pid, entity] of Object.entries(body?.entities ?? {})) {
      if (entity.missing !== undefined || !entity.datatype) {
        absent.add(pid);
        continue;
      }
      const label = entity.labels?.en?.value?.trim();
      properties.set(pid, { datatype: entity.datatype, ...(label ? { label } : {}) });
    }
    return { properties, absent, unavailable };
  }

  /**
   * Intro extracts + lead-image file names for a batch of article titles.
   *
   * `redirects=1` matters: OSM tags routinely name a redirect, and without it those pages come back
   * as misses. The response is keyed by the *resolved* title, so the caller is handed both — the
   * `normalized`/`redirects` maps let it match what it asked for to what it got.
   */
  async articles(
    titles: readonly string[],
  ): Promise<Batch & { articles: Article[]; resolved: Map<string, string> }> {
    if (titles.length === 0) return { articles: [], resolved: new Map(), unavailable: false };
    const { body, unavailable = false } = await this.get<QueryPages>(
      "https://en.wikipedia.org/w/api.php",
      {
        action: "query",
        prop: "extracts|pageimages",
        exintro: "1",
        explaintext: "1",
        piprop: "name",
        redirects: "1",
        titles: titles.join("|"),
      },
    );

    // `from → to` for both rewrites the API may apply, so the caller can find its original ask.
    const resolved = new Map<string, string>();
    for (const hop of [...(body?.query?.normalized ?? []), ...(body?.query?.redirects ?? [])]) {
      if (hop.from && hop.to) resolved.set(hop.from, hop.to);
    }

    const articles: Article[] = [];
    for (const page of Object.values(body?.query?.pages ?? {})) {
      if (page.missing !== undefined || !page.title) continue;
      articles.push({
        title: page.title,
        ...(page.extract ? { extract: page.extract } : {}),
        ...(page.pageimage ? { imageFile: page.pageimage } : {}),
      });
    }
    return { articles, resolved, unavailable };
  }

  /**
   * The files a Commons category directly contains — the listing behind a mapper's
   * `wikimedia_commons=Category:…` tag, one category per request.
   *
   * One page only, no continuation, and that is a decision rather than a shortcut: the caller wants a
   * *lead* from a set a human curated, and a category whose first 500 files contain no usable lead is not
   * going to yield one at file 501. `exists` is separate from `files` because a category page can be a
   * redlink and still contain files (the category exists as a collection the moment anything is filed
   * under it) — so "absent" is only the pair *no page and no members*, never an empty-but-real category.
   */
  async categoryFiles(category: string): Promise<Batch & { exists: boolean; files: string[] }> {
    const { body, unavailable = false } = await this.get<QueryPages & CategoryMembers>(
      "https://commons.wikimedia.org/w/api.php",
      {
        action: "query",
        list: "categorymembers",
        cmtitle: category,
        cmtype: "file",
        cmlimit: "500",
        // The same request also asks about the category *page*, so existence and membership arrive
        // together — two facts, one paced call.
        titles: category,
        prop: "info",
      },
    );
    if (unavailable) return { exists: false, files: [], unavailable: true };
    const files = (body?.query?.categorymembers ?? [])
      .map((member) => member.title)
      .filter((title): title is string => Boolean(title));
    const page = Object.values(body?.query?.pages ?? {})[0];
    const exists = files.length > 0 || (page !== undefined && page.missing === undefined);
    return { exists, files, unavailable: false };
  }

  /**
   * Resolve Commons **page ids to `File:` titles** — how a `geo_tags` dump row becomes a fetchable name.
   *
   * `missing` collects two answers that are the same to the caller: a page id that no longer exists
   * (dump lag — the file was deleted) and a page that exists but is not in the File namespace (galleries
   * and category pages carry coordinates too, and the dump does not say which namespace a row is). Both
   * are terminal facts about the id, never worth asking about again.
   */
  async titlesForPageIds(
    pageIds: readonly number[],
  ): Promise<Batch & { titles: Map<number, string>; missing: Set<number> }> {
    const titles = new Map<number, string>();
    const missing = new Set<number>();
    if (pageIds.length === 0) return { titles, missing, unavailable: false };
    const { body, unavailable = false } = await this.get<QueryPages>(
      "https://commons.wikimedia.org/w/api.php",
      { action: "query", pageids: pageIds.join("|") },
    );
    if (unavailable) return { titles, missing, unavailable: true };
    for (const page of Object.values(body?.query?.pages ?? {})) {
      if (typeof page.pageid !== "number") continue;
      if (page.missing !== undefined || page.ns !== 6 || !page.title) missing.add(page.pageid);
      else titles.set(page.pageid, page.title);
    }
    // Ids the reply did not mention at all are still unanswered — leave them out of both, the caller's
    // three-state contract (`entities` sets the precedent).
    return { titles, missing, unavailable: false };
  }

  /**
   * Which of these file titles actually exist **on Commons**, with their license metadata.
   *
   * This is the licensing gate, and it is why the check happens here rather than being left to the
   * server. An article's lead image is sometimes a *local* English-Wikipedia upload under fair use,
   * which we may not redistribute; those files are absent from Commons and get dropped.
   */
  async commonsFiles(
    fileTitles: readonly string[],
    /**
     * Ask for a rendering this wide as well as the original. One request then answers everything the crawl
     * needs about a file — licence, credit, dimensions and where the bytes are — where the previous split
     * between this call and the server's own `extmetadata` lookup asked Commons twice.
     */
    urlWidth?: number,
  ): Promise<Batch & { files: Map<string, CommonsFile> }> {
    const files = new Map<string, CommonsFile>();
    if (fileTitles.length === 0) return { files, unavailable: false };
    // Verified against Commons: 50 titles in one request with `iiurlwidth` returns a per-title `thumburl`
    // and full `extmetadata`, no API warnings.
    const { body, unavailable = false } = await this.get<QueryPages>(
      "https://commons.wikimedia.org/w/api.php",
      {
        action: "query",
        prop: "imageinfo",
        iiprop: "extmetadata|url|size|mime",
        titles: fileTitles.join("|"),
        ...(urlWidth !== undefined ? { iiurlwidth: String(urlWidth) } : {}),
      },
    );
    for (const page of Object.values(body?.query?.pages ?? {})) {
      if (page.missing !== undefined || !page.title) continue;
      const info = page.imageinfo?.[0];
      const meta = info?.extmetadata;
      // Keyed through the same canonicalizer the caller asked with — MediaWiki replies in the space
      // form of a title whatever form it was given, so a raw `page.title` key would miss.
      files.set(commonsFileTitle(page.title), {
        ...text(meta?.["LicenseShortName"]?.value, "license"),
        ...text(stripHtml(meta?.["Artist"]?.value), "author"),
        ...text(meta?.["LicenseUrl"]?.value, "licenseUrl"),
        ...text(info?.descriptionurl, "sourceUrl"),
        ...text(info?.url, "url"),
        ...text(info?.thumburl, "thumbUrl"),
        ...text(info?.mime, "mime"),
        ...(typeof info?.width === "number" ? { width: info.width } : {}),
        ...(typeof info?.height === "number" ? { height: info.height } : {}),
      });
    }
    return { files, unavailable };
  }

  /**
   * One paced, retried GET for **bytes**, under a size cap.
   *
   * Here rather than in a caller because it must share this client's pacing and `Retry-After`
   * handling — that is the whole lesson of the throttled snapshot
   * (`apps/atlas/doc/spec/cartographer.md` §1.4): asking more slowly does not help, waiting does.
   * Callers give byte fetches their **own client instance**, because `nextAllowedAt` is
   * per-instance and `upload.wikimedia.org` has a budget independent of the API host's.
   */
  async bytes(url: string, maxBytes: number): Promise<BytesResult> {
    const res = await this.paced(new URL(url), "image/*");
    if (res === undefined) return { kind: "unanswered" };
    if (!res.ok) return { kind: "refused", reason: `http-${res.status}` };
    // Checked twice on purpose: the declared length avoids pulling a body we would only discard, and the
    // measured length is what actually binds, since `content-length` may be absent or lie.
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { kind: "refused", reason: "too-large" };
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > maxBytes) return { kind: "refused", reason: "too-large" };
    const type = res.headers.get("content-type") ?? undefined;
    return { kind: "ok", bytes, ...(type ? { type } : {}) };
  }

  /**
   * One paced, retried, JSON GET. `format=json` + `maxlag` are added to every call.
   *
   * Returns `{ body }` on success, `{ unavailable: true }` when Wikimedia never answered (throttled
   * past the budget, or a wait longer than we may take), and `{}` when it answered with a refusal.
   * **The last two must not be confused**: a caller leaves unanswered rows unstamped so a re-run
   * retries them, and doing that for a permanently-malformed batch would re-ask about it forever and
   * pin the candidate window the stamp exists to advance.
   */
  private async get<T>(
    endpoint: string,
    params: Record<string, string>,
  ): Promise<{ body?: T; unavailable?: boolean }> {
    const url = new URL(endpoint);
    for (const [k, v] of Object.entries({
      ...params,
      format: "json",
      formatversion: "2",
      maxlag: "5",
    })) {
      url.searchParams.set(k, v);
    }

    const res = await this.paced(url, "application/json");
    // Gave up politely (throttled past the cap, or out of attempts) — these rows stay unstamped for the
    // next run rather than being recorded as answered.
    if (res === undefined) return { unavailable: true };
    // A 4xx that isn't throttling is an answer: a malformed batch, not worth retrying and not worth
    // re-asking about next run either. Deliberately NOT `unavailable`.
    if (!res.ok) return {};
    return { body: (await res.json()) as T };
  }

  /**
   * One paced, throttle-aware request. `undefined` means Wikimedia never answered.
   *
   * The single owner of the pacing / `Retry-After` / backoff-cap policy this package exists to hold. It was
   * briefly spelled twice — once for JSON, once for bytes — and `retryAfterMs`'s own docblock records what
   * happened the last time a copy of exactly this logic drifted from its sibling.
   */
  private async paced(url: URL, accept: string): Promise<Response | undefined> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await this.pace();
      // A **thrown** fetch is not an answer either. `fetchImpl` rejects for a socket that never opened — a
      // DNS blip, a reset, a TLS hiccup — and that is the same "we learned nothing" this method already
      // reports for a throttle. Handled here rather than at each call site because two callers had grown
      // their own `.catch()` wrapper while the third had none, so one reset connection meant three
      // behaviours in one run: the concordance crashed while the other two deferred politely.
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          headers: { "user-agent": this.opts.userAgent, accept },
        });
      } catch {
        return undefined;
      }
      // 429 is the rate limiter; 503 with maxlag set is "replica is behind, come back". Both are
      // asking for the same thing, so both back off rather than count as a failure.
      if (res.status === 429 || res.status === 503) {
        const asked = retryAfterMs(res.headers.get("retry-after"));
        const wait = asked !== undefined && asked > 0 ? asked : this.opts.minIntervalMs * attempt;
        // Capped: an upstream may ask for an hour, and a 53k-row job pinned for an hour on one batch
        // is worse than coming back next run. Past the cap, stop rather than wait it out.
        if (wait > MAX_BACKOFF_MS) return undefined;
        await this.sleep(Math.max(wait, MIN_BACKOFF_MS));
        continue;
      }
      return res;
    }
    return undefined;
  }

  /** Serial pacing: never issue a request less than `minIntervalMs` after the previous one started. */
  private async pace(): Promise<void> {
    const now = Date.now();
    const wait = this.nextAllowedAt - now;
    if (wait > 0) await this.sleep(wait);
    this.nextAllowedAt = Math.max(now, this.nextAllowedAt) + this.opts.minIntervalMs;
  }
}

/**
 * A `Retry-After` in ms — **delta-seconds or an HTTP-date**; `undefined` when neither parses.
 *
 * The date form occurs in the wild, and reading the header as a bare `Number` turned it into `NaN`, which
 * fell through to the local backoff and retried instead of waiting as asked. `apps/server`'s
 * `outbound-http.ts` has parsed both forms all along — this copy had silently drifted from it.
 */
function retryAfterMs(header: string | null): number | undefined {
  const raw = header?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/**
 * Wikidata's claim structure → {@link WikidataValue} lists, one property at a time.
 *
 * Two things are dropped deliberately. A snak whose `snaktype` is not `value` carries no value —
 * `somevalue` means "there is one and it is unknown" and `novalue` means "there is provably none" —
 * and counting either as a value would make "this entity has coordinates" true for an entity whose
 * coordinates are explicitly unknown. A datatype we don't model is skipped rather than coerced, so a
 * caller asking for string values never receives a stringified object.
 */
function flattenClaims(
  claims: Record<string, WbClaim[]> | undefined,
): Record<string, WikidataValue[]> {
  const out: Record<string, WikidataValue[]> = {};
  for (const [pid, statements] of Object.entries(claims ?? {})) {
    const values = statements
      .filter((statement) => statement.mainsnak?.snaktype === "value")
      .map((statement) => snakValue(statement.mainsnak?.datavalue?.value))
      .filter((value): value is WikidataValue => value !== undefined);
    if (values.length > 0) out[pid] = values;
  }
  return out;
}

/** One `datavalue.value`, as whichever of the three modelled shapes it turns out to be. */
function snakValue(value: unknown): WikidataValue | undefined {
  if (typeof value === "string") return { kind: "string", value };
  if (!value || typeof value !== "object") return undefined;
  const { id, latitude, longitude } = value as {
    id?: unknown;
    latitude?: unknown;
    longitude?: unknown;
  };
  if (typeof id === "string") return { kind: "item", id };
  if (typeof latitude === "number" && typeof longitude === "number") {
    return { kind: "coordinate", lat: latitude, lng: longitude };
  }
  return undefined;
}

// ── response shapes, narrowed to the fields read above ──────────────────────────────────────────

interface WbGetEntities {
  entities?: Record<string, WbEntity>;
}

interface WbEntity {
  missing?: boolean | string;
  sitelinks?: { enwiki?: { title?: string } };
  claims?: Record<string, WbClaim[]>;
  /** Present on properties, never on items — which is what makes it a usable existence check. */
  datatype?: string;
  labels?: Record<string, { value?: string }>;
}

interface WbClaim {
  mainsnak?: {
    snaktype?: string;
    datavalue?: { value?: unknown };
  };
}

interface QueryPages {
  query?: {
    pages?: Record<string, QueryPage> | QueryPage[];
    normalized?: { from?: string; to?: string }[];
    redirects?: { from?: string; to?: string }[];
  };
}

interface CategoryMembers {
  query?: {
    categorymembers?: { title?: string }[];
  };
}

interface QueryPage {
  pageid?: number;
  ns?: number;
  title?: string;
  missing?: boolean | string;
  extract?: string;
  pageimage?: string;
  imageinfo?: {
    extmetadata?: Record<string, { value?: string }>;
    url?: string;
    descriptionurl?: string;
    thumburl?: string;
    width?: number;
    height?: number;
    mime?: string;
  }[];
}

/**
 * One optional string field, present only when there is something in it.
 *
 * `exactOptionalPropertyTypes` means `{ license: undefined }` is not the same as `{}`, and the difference
 * reaches the wire: an interned credit built from the former carries explicit `undefined` keys that JCS then
 * canonicalizes differently. Spread-a-conditional-object is the house idiom; this names it once because
 * `commonsFiles` now builds seven of them.
 */
function text<K extends string>(value: string | undefined, key: K): { [P in K]?: string } {
  const trimmed = value?.trim();
  return (trimmed ? { [key]: trimmed } : {}) as { [P in K]?: string };
}

/**
 * Commons returns `Artist` as HTML — measured, e.g. `<a href="//commons.wikimedia.org/wiki/User:Msact">M…`.
 * Unstripped it would ride into a published credit as markup, and from there onto a place card.
 */
function stripHtml(value: string | undefined): string | undefined {
  // Whitespace collapsed as well as tags dropped, matching the server's own `stripHtml`: Commons `Artist`
  // markup routinely spans lines, so tag-stripping alone would give the same file two different author
  // strings depending on which program read it.
  return value
    ?.replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
