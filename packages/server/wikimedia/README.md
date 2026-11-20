# @beaconsgg/wikimedia

`[S]` server-only. One paced client for the Wikimedia read APIs, with three possible outcomes for
every question.

## Why this is a package

Three of Cartographer's stages read Wikimedia from two hosts, and they must behave the same way:

- `concordance` reads the Wikidata concordance and the P18 image claims that stage 4 later uses.
- `wikipedia` reads article intro extracts and lead-image names.
- `media` reads Commons license metadata and the image bytes themselves.

The package keeps one contract about outcomes for all three. The client is the one thing between a
throttle and a permanent record of "there is nothing there". The client tells three outcomes apart,
and mixing up any two of them has lost data before:

| Outcome       | Meaning                                         | What a caller must do                       |
| ------------- | ----------------------------------------------- | ------------------------------------------- |
| a result      | Wikimedia answered with this                    | record the result                           |
| `absent`      | Wikimedia answered that there is no such thing  | record the absence, which is a fact         |
| `unavailable` | Wikimedia never answered (throttled or lagging) | record **nothing** and retry on the next run |

The third row is the costly one. A snapshot once lost 97% of its images because a throttled fetch
was stored as "this place has no photo". A batch of 20 articles that was given up on became 20
places marked for good as having no article. No method here returns an empty result for a question
it failed to ask.

## Etiquette

Wikimedia's policies require these, and the client follows them on every request:

- **User-Agent.** Wikimedia requires anonymous clients to send a descriptive agent with contact
  details. `userAgent` has no default, so a caller must supply a real one.
- **`maxlag=5`.** The client yields to a lagging replica instead of adding load to it.
- **`Retry-After`.** The client waits as told, up to 30 seconds per wait. Past that cap the batch is
  reported `unavailable` and retried on a later run. One page can't hold up a job of 53,000 rows.
- **Serial pacing** through `minIntervalMs`. Pacing is the whole rate control, and the client runs
  no requests in parallel.

The client never retries a plain 4xx. A malformed batch is an *answer*. Asking about it forever
would pin the cursor that the caller's progress depends on.

## Methods

| Method                    | API                                        | Used for                                                    |
| ------------------------- | ------------------------------------------ | ----------------------------------------------------------- |
| `articles(titles)`        | en.wikipedia `query` with `extracts`       | descriptions and lead-image names                           |
| `commonsFiles(t, width?)` | Commons `query` with `imageinfo`           | the license gate and the full credit, and where the bytes are |
| `bytes(url, maxBytes)`    | a paced GET for image bytes                | the media crawl's byte pass                                 |
| `entities(qids)`          | Wikidata `wbgetentities`                   | the concordance and P18 claims                              |
| `enwikiTitlesForQids(…)`  | a projection of `entities`                 | the article for an object with no `wikipedia=` tag          |
| `properties(pids)`        | Wikidata `wbgetentities` (datatype and label) | the concordance's preflight                              |

`entities` returns claim values as a discriminated union of `string`, `item` and `coordinate`. The
values aren't flattened to text. The distinction pays off at once. Cartographer tells a *place*
from the company that operates 54 of them by whether the entity has a `globe-coordinate`.

`commonsFiles` returns the whole credit for a file:

- the license and its URL;
- the author, with the HTML tags that Commons puts in `Artist` stripped;
- the file's own page;
- the original's dimensions and URL;
- a rendering scaled to a width, when the caller asks for one.

Cartographer fetches the image bytes, so this lookup is the authoritative one. No other program
asks Commons for the same metadata.

`byteUrl(file, maxPx)` picks *which* URL to download. The choice is a licensing decision and not an
efficiency one, because **MediaWiki will upscale.** Asked for a 1024-pixel rendering of a 662×240
original, MediaWiki answers with a thumbnail 1024 pixels wide. The re-encode's
`withoutEnlargement` can't undo an enlargement that already happened upstream. So the client uses
the original whenever the original is no larger than wanted.

`bytes` returns the same three states as the batched reads: `ok`, `refused` and `unanswered`. The
reason is the same too. A 404 is knowledge, and a throttle the client couldn't wait out isn't.
Wikimedia throttles image bytes per IP address. The snapshot that lost 97% of its images recorded
each deferral on the byte path as "this place has no photo".

`properties` exists because property ids get deprecated, split and reused. A check that an id still
exists proves nothing. P8460 and P2528 are both live ids, and they mean "applies if regular
expression matches" and "earthquake magnitude". So a caller asserts the datatype and the English
label, and the check fails loudly instead of resolving nothing.

## Testing

`fetch` and `sleep` are injected, so the tests run the response shaping and the retry ladder with no
network. The bugs in a client like this live in its handling of a 429, a `missing` entity or a
claim with no value. The HTTP layer itself is rarely the problem.
