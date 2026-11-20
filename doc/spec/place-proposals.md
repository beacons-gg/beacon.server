# Place proposals

Players propose places and improvements, and an operator reviews each one before anything is
published. This spec covers the proposal model and the routes for players and reviewers. The spec
also covers attribution and the license a contributor grants. The dataset itself is in the
[places](places.md) spec.

Checked against Beacon 0.3.

Proposals are platform data. The server accepts a proposed place from a signed DID and an operator
reviews it. The server never learns what in the game led to the submission.

## 0. Overview

A place dataset built from open data is thin on descriptions and photos, and often for the places a
game most wants to send players to. Players can fill those gaps, with an operator's review before
anything is published.

| Action                 | Who                                       | Result                                                          |
| ---------------------- | ----------------------------------------- | --------------------------------------------------------------- |
| Propose a new place    | any player with a signed `places.propose` | a pending proposal; no read shows it until an operator approves |
| Improve a place        | any player, with descriptive fields only  | a pending proposal on that place                                |
| Approve a proposal     | an operator                               | a `contrib` source record, merged like any other source         |
| Create a place by hand | an operator, with `places.create`         | an `admin` source record (§7)                                   |

Three parts of the server carry most of the load:

1. **Approval reuses the write path.** An approved proposal lands as a source record through the
   same merge and cell index that imports and operator edits use. The new piece is the queue.
2. **Photos reuse media.** The client uploads a photo with `media.put`, and the proposal carries the
   hashes. The upload checks the hash and refuses EXIF or GPS metadata.
3. **Abuse controls apply unchanged.** The actor is cryptographic. The blocklist, a per-DID budget
   and the nonce log all apply.

## 1. Principles

- **Review before publish.** A contribution is untrusted content that other games, servers and
  export files inherit. Nothing a player submits reaches a read until an operator approves it. The
  server never checks a gameplay claim, and this review is about the shared dataset.
- **Improvements only add.** An improvement may set `name`, `description`, `website` and `media`.
  Only an operator moves a place or changes its category, subcategory or geometry. A player has no
  legitimate reason to make those changes, and vandals do. A player who thinks a place is in the
  wrong spot writes a `note`.
- **The dataset's curation rule covers submissions.** The dataset holds no sensitive locations.
  Homes, schools, hospitals and places of worship are sensitive locations. A reviewer applies that
  rule, and a client should steer players away from homes before they submit. Review is the
  backstop.
- **Attribution stays per source.** A contributed place isn't derived from OpenStreetMap, so its
  record carries its own terms. Per-source provenance keeps the lineages apart through merge, export
  and import.
- **The capability is opt-in.** An operator turns proposals on separately from places. The
  descriptor advertises `places-proposals`, and the player routes answer `404` while proposals are
  off.

## 3. Data model

The `place_proposals` table lives beside the other places tables:

```sql
place_proposals (
  id            TEXT PRIMARY KEY, -- ULID; a new place, once approved, takes this as its unique
  place_unique  TEXT,             -- NULL for a new place; set for an improvement
  proposed_by   TEXT NOT NULL,    -- the contributor's verified DID
  credit        INTEGER NOT NULL, -- 1: name the contributor with the place
  license       TEXT,             -- 'CC0-1.0' | 'CC-BY-4.0': the grant (§9a)
  fields        TEXT NOT NULL,    -- JSON: the proposed fields (§4 bounds them)
  note          TEXT,             -- from the contributor to the reviewer
  status        TEXT NOT NULL,    -- 'pending' | 'approved' | 'rejected'
  reviewed_by   TEXT, reviewed_at TEXT, review_reason TEXT,
  applied_place TEXT,             -- the place the approval landed on
  created_at    TEXT NOT NULL
);
```

Both listings page by `id` in descending order. ULIDs sort by time, so id order is recency order.
The listings use indexes on `(status, id)` and `(proposed_by, id)`. A partial index on pending rows
per DID serves the pending cap. A partial index on approved and credited rows per `applied_place`
serves the contributor list.

**A new-place proposal's `id` becomes the place's `unique`.** Reusing the ULID minted at submit
makes approval idempotent: a retry writes the same place again instead of a second one. Approval
therefore needs no transaction across the two tables. The server commits the place first and stamps
the proposal second, and a crash between the two leaves a pending row that a second approval
completes.

### 3.1 The `contrib` source

Approval writes a source record named `contrib`, with `source_id` set to the place's `unique`. A
place has one `contrib` record in the shape of its `admin` record. Each approved improvement folds
into that record. The merge ranks `contrib` below `admin` and `list:` and above `atlas:`
([places](places.md) §3.1). Reviewed human input beats the bulk dataset, and a direct operator edit
or an operator's list still wins. In the common case nothing competes: the merge is per field, so a
player's description on a place that had none fills a gap.

The source is named `contrib` because `community` is a place category, and a source that shares a
category's name would make provenance ambiguous.

An import value that collides with a field `contrib` holds resolves by rank, with no conflict row.
The conflict queue protects the operator's own work, and widening it to contributions would flood it
on every re-import. An operator who wants a contributed value held against imports and later
contributions copies it into the `admin` record with `places.edit`. A later approved contribution to
the same field replaces an earlier one, a reviewer's amendment included.

### 3.2 Credit comes from the proposals

One `contrib` record per place can hold one `editedBy`, and several players may improve one place.
The source record therefore holds the merged data, and the proposals table is the attribution log. A
place's credited contributors are its approved proposals with `credit = 1`. The lookup keys on
`applied_place`, which covers new places and improvements alike. An uncredited proposal still
records `proposed_by` for moderation and budgets. The server never displays that DID.

## 4. Wire

The shapes are in `@beaconsgg/protocol-types` (`places.ts`).

```ts
// op:"places.propose", signed by any player
{
  target:
    | { kind: "new", category, subcategory, point, name?, description?, website?, media?, license }
    | { kind: "existing", unique, name?, description?, website?, media?, license },
  credit: boolean, // default false: name the contributor with the place
  note?: string,   // up to 500 characters, for the reviewer
}
```

- A new place needs a `category`, a `subcategory` and a `point`.
- An improvement names its place by `unique` and must propose at least one field. The improvement
  schema has no `point` or `category`, so a submission that carries one answers `400`.
- `license` is required: `CC0-1.0` or `CC-BY-4.0` (§9a). A submission without credit may only be
  `CC0-1.0`, because CC BY promises attribution to a named author.
- The field limits are the places limits. A name holds up to 256 characters and a description up
  to 500. A URL holds up to 300, and a proposal carries up to 8 media entries.

A stored proposal reads as `placeProposalSchema`, which mirrors the table above with camel-case
names.

### 4.1 Contributors on the detail read

`placeDetailSchema` is strict, so an unexpected key fails the parse in a client that predates it.
`GET /places/:unique?contributors=1` therefore adds `contributors` only for a client that asks. The
field is a list of credited DIDs, sorted and without repeats. The server holds no display names, and
a client resolves each DID through `GET /profiles/:id`.

### 4.2 The taxonomy is discoverable

A contributor picks a category and a subcategory for a new place. `placeSubcategorySchema` is a
bounded slug and not an enum, so the vocabulary can grow on the server without a wire change. A
client reads the vocabulary from a public route:

| Route                  | Answers                                                   | Notes                                                               |
| ---------------------- | --------------------------------------------------------- | ------------------------------------------------------------------- |
| `GET /places/taxonomy` | `{ categories: [{ category, subcategories: string[] }] }` | public and unsigned; changes only when the server's tag map changes |

`PLACE_VOCABULARY` in `@beaconsgg/place-taxonomy` is derived from the tag map that classifies every
import, so the route can't list a slug that nothing produces. The route and the submit check read
the same vocabulary.

- **The pair is checked.** A proposal carrying `park` with `gallery` answers `400` `invalidPair`.
  Operator writes (`places.create` and `places.edit`) aren't held to the vocabulary, because an
  operator may add a slug before the tag map has it.
- **Labels belong to the game.** The server serves slugs, and the client owns the display strings. A
  client shows a slug it has no label for as the slug itself.

## 5. The player routes

| Route                          | Op                       | Notes                                                                                        |
| ------------------------------ | ------------------------ | -------------------------------------------------------------------------------------------- |
| `POST /places/propose`         | `places.propose`         | signed by the contributor; answers the stored proposal; a retried nonce returns the same one |
| `POST /places/proposals/fetch` | `places.proposals.fetch` | a signed read of the verified actor's own proposals and their outcomes                       |

Both answer `404` `unknownRoute` while places or proposals are off. A submit passes the IP write
limit first, and a fetch the signed-read limit ([mailbox and media](mailbox-and-media.md) §3.4). The
signed-request gate and game admission follow. A fetch needs no game admission, so a player still
sees their own pending proposals on a server that stopped admitting their game. No route lists
another player's proposals. A proposal ties a DID to a point in the world, and an open listing would
disclose where players go.

The server checks a submit in this order and stores nothing until every check passes:

| Check                                                                | Failure                |
| -------------------------------------------------------------------- | ---------------------- |
| the shape (§4)                                                       | `400` `invalid`        |
| a new place's category and subcategory form a vocabulary pair        | `400` `invalidPair`    |
| an improvement's place exists and is active                          | `400` `unknownPlace`   |
| every media hash is stored on this server                            | `400` `unknownMedia`   |
| the DID is within `BEACON_PLACES_PROPOSAL_RATE_LIMIT_MAX` per window | `429` `rateLimited`    |
| the DID has fewer than `BEACON_PLACES_PROPOSAL_MAX_PENDING` pending  | `409` `tooManyPending` |

An unknown place answers `400` because the route exists and the body is wrong. A full pending queue
answers `409` as a refusal of the server's state. Waiting doesn't clear it, and an operator's review
does. A client that retries every `429` would otherwise retry it forever. Media must be on this
server so the reviewer sees the bytes that will be published. With media off, a proposal that
carries photos is refused. The server rewrites each media entry's address to its own copy, and the
server builds each entry's `credit` from the grant (§9a). A client's own credit line is ignored,
since it would be published and could name anyone.

The budgets come last, so a submission refused for its shape costs nothing. The pending cap bounds
the queue one player can build, which a rate limit alone doesn't.

A proposal never writes to `places`, `place_sources` or `place_cells`. A pending proposal is
invisible to `GET /places` and `GET /places/:unique`.

## 6. Review

| Route                                 | Op                        | Notes                                                                                        |
| ------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------- |
| `POST /places/admin/proposals/fetch`  | `places.proposals.fetch`  | the whole queue, newest first, filtered by `status` and paged by `cursor` (up to 200 a page) |
| `POST /places/admin/proposals/review` | `places.proposals.review` | `{ id, decision, reason?, edits? }`: approve or reject                                       |

Both routes pass the admin gate ([admin API](admin-api.md) §2). The admin fetch uses the same op
name as the player's fetch, and the route decides the scope. The review routes need places on and
don't need proposals on, so an operator who closes submissions can still clear the backlog.

**Approve** applies the proposal, then stamps it:

- A new place gets a `contrib` record under the proposal's own `id`, and the place is merged and
  indexed.
- An improvement folds its fields into the place's `contrib` record, and the place is merged again.
- `edits` amends the proposal before it lands, so a submission that is nearly right takes one
  approval with a fix.
- A contributed `description` gets a `descriptionCredit` built from the grant (§9a).

An approval that can't produce a servable place answers `400` `unknownPlace` and leaves the
proposal pending, so the operator can reject the proposal instead. That happens when the target
place has retired since the submission.

**Reject** stamps the proposal with its reason and writes nothing to the dataset. The rejected
photos stay in the media store, and the operator removes them through the media review queue
([admin API](admin-api.md) §3).

The first decision stands. The stamp is conditional on `pending`. A second reviewer gets the first
decision back, and so does a retry after the nonce window.

## 7. `places.create`

`POST /places/admin/create` (`places.create`) makes a place no import produced. The operator gives
at least a category and a point. The server mints a ULID and writes an `admin` record. The new place
therefore behaves like an edited one. The record wins every merge and the place never retires on its
own. A later `places.edit` adjusts it ([places](places.md) §6.3). A retried nonce returns the place
the first call created. The answer is `{ ok, place }`, with `place` in the `placeDetailSchema` shape
that `GET /places/:unique` answers.

## 8. Settings

| Setting                                       | Default               | Meaning                                                                    |
| --------------------------------------------- | --------------------- | -------------------------------------------------------------------------- |
| `BEACON_PLACES_PROPOSALS`                     | `off`                 | accepts proposals and advertises `places-proposals`; needs `BEACON_PLACES` |
| `BEACON_PLACES_PROPOSAL_RATE_LIMIT_MAX`       | `20`                  | submissions per DID per window                                             |
| `BEACON_PLACES_PROPOSAL_RATE_LIMIT_WINDOW_MS` | `86400000` (24 hours) | the submission window                                                      |
| `BEACON_PLACES_PROPOSAL_MAX_PENDING`          | `10`                  | unreviewed proposals per DID                                               |
| `BEACON_PLACES_PROPOSALS_EXPORT`              | `off`                 | allows `places.contrib.export` (§9a); needs `BEACON_PLACES`                |

A game reads `places-proposals` from the descriptor to decide whether to offer a "propose a place"
action on that server. The proposals setting can't be on while places is off. The
[runtime settings](runtime-settings.md) spec covers how the server enforces that (§4.1).

## 9a. The license grant and the export

A submission states the terms it may be published under, and the terms cover its text and its photos
alike:

- **`CC-BY-4.0`** asks for attribution, so a submission may use it only when the contributor chose
  to be credited.
- **`CC0-1.0`** asks for nothing, and is the only choice for an uncredited submission.

The server builds every contributed photo's `credit` and every contributed description's
`descriptionCredit` from the grant. The license is the one the contributor chose. The author is the
contributor's DID when they asked to be credited, and the server's own DID when they didn't. An
uncredited CC0 field needs no attribution, and the server's DID still records where the field came
from.

**Sharing contributions.** With `BEACON_PLACES_PROPOSALS_EXPORT` on the op `places.contrib.export`
(`POST /places/admin/contrib/export`) returns the server's approved contributions. The result is a
GeoJSON file with the `beacon-contrib/1` profile, for a dataset builder such as Atlas to take in.
The route answers `404` while the setting is off. Sharing is the one path where player-derived data
leaves the server for a central party, so it is off unless the operator turns it on.

- Each feature carries the `contrib` record's own fields. The place's merged record isn't exported,
  so another source's text never ships as a player's.
- A feature's point and category come from the merged place. An improvement contributes neither, and
  a feature can't exist without them.
- A `contrib` block carries the id `contrib:<host>/<unique>`, the license and the credited DIDs. The
  block also lists the ids of the place's other sources for a builder to join on. A volume that
  republishes the contribution keeps that id, so the server recognizes the place when the volume
  comes back ([places](places.md) §3.2).
- **A place travels only if every approved contribution to it carries a grant.** A proposal stored
  without a license never leaves the server.
- The feature's license is CC BY when any contribution to it is CC BY, so no field granted under
  attribution is published as CC0. Only a credited contribution can be CC BY, so the credited rows
  decide the answer.
- An uncredited contribution travels as content, with no DID. The reviewer's note never travels.
- An export holds up to 2000 features and sets `truncated` when the limit cuts it short.

## 10. What proposals don't do

- No contributor is trusted to skip review.
- The server pays no reward for a contribution.
- The server doesn't look for near-duplicates at submit. A client can offer nearby places with a
  places read before the player proposes a new one.
- A player can't propose geometry or move a point. The `note` carries such corrections to the
  reviewer.
- A rejected proposal can't be appealed or edited. The player submits a new one.
- Proposals don't sync between servers. Contributions travel by export, as `contrib` features or
  onward through a dataset builder.
