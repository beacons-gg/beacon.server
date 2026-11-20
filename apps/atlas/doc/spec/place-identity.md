# Atlas place identity

This spec covers how Atlas decides that records from several sources describe one place, and which
id that place keeps. The rules live in Cartographer's stage 2 (`identity.ts`, `upstream.ts`) and in
the consumer's id derivation in `@beaconsgg/atlas-volume`. The fields they fill are `id`, `upstream`
and `aliases` in a volume's tiles ([volume format](volume-format.md) §4). What a Beacon server does
with those fields is in [Beacon integration](beacon-integration.md) §4.

Checked against Beacon 0.3.

## 0. Two problems that look like one

**Duplicates inside a volume are Atlas's problem.** Cartographer may stage OpenStreetMap, Wikipedia
and the Park Service. Three of their records may describe one lighthouse. A Beacon operator can't
fix that. The operator has no view of the source data and no matching tools, and no way to publish a
correction to anyone else. A duplicate queue on every server would have every operator repeat the
one job Atlas exists to do once, and do it badly.

**The same place in two volumes is the consumer's problem**, and the consumer's answer is
mechanical. Two volumes can overlap, or come from two publishers. The consumer derives a key from
each place's ids, follows aliases and stops (§6). The consumer makes no judgement and asks the
operator nothing.

## 1. Upstream identifiers

Every Atlas place carries the source identifiers it was built from, in a flat namespaced form. These
identifiers are the matching mechanism.

| Prefix     | Form                              | Merge key | Notes                                                                          |
| ---------- | --------------------------------- | --------- | ------------------------------------------------------------------------------ |
| `osm:`     | `osm:w/456`                       | yes       | an OpenStreetMap object; the letter is `n` (node), `w` (way) or `r` (relation) |
| `wd:`      | `wd:Q2680081`                     | yes       | a Wikidata entity, which links the other systems (§2); needs evidence          |
| `nrhp:`    | `nrhp:77001360`                   | yes       | a US National Register of Historic Places reference number, 8 digits           |
| `gnis:`    | `gnis:1531329`                    | yes       | a USGS GNIS feature id, used to match and never as content                     |
| `commons:` | `commons:Category:Mukilteo Light` | no        | a Wikimedia Commons category: a set of photos and never an identity claim      |
| `contrib:` | `contrib:<host>/<unique>`         | yes       | a place a player contributed on a Beacon server (§7)                           |

The rules:

- **An identifier is never invented.** An identifier appears only when a source asserted it. A
  guessed id is worse than a missing one, because a guessed id matches something: a missing id costs
  one unmatched record and a wrong one corrupts a place. Each namespace has a form, and the form is
  checked whenever an id is read back from staging. An `nrhp:` value that holds a URL is refused.
- **An identifier stays a member of its place forever**, even after the source drops the record. An
  OpenStreetMap way that is deleted and mapped again under a new id gives the place a second `osm:`
  entry, and the old one stays. Consumers and other volumes may still hold the old one.
- **Only merge keys are exclusive.** An identifier that established a place belongs to that place
  alone. A carried identifier can sit on many places at once. One Wikidata id for a surveillance
  company sits on every camera that company operates, and each camera is its own place.
- **A namespace can hold more than one id.** Two OpenStreetMap objects can merge into one place.
- **A record built out of another record asserts nothing.** The record names its parent instead (§3,
  derivation).

A Commons category isn't a merge key because mappers often tag a parent category. A category for a
city's churches tagged on each church would fuse every church in the city into one place.

## 2. Wikidata is the concordance

Most of the cross-source linking has already been done by someone else. Wikidata carries
external-identifier properties for the datasets Atlas uses:

| Property | Links                        |
| -------- | ---------------------------- |
| P402     | an OpenStreetMap relation id |
| P10689   | an OpenStreetMap way id      |
| P11693   | an OpenStreetMap node id     |
| P649     | an NRHP reference number     |
| P590     | a USGS GNIS id               |
| P373     | a Commons category           |
| P625     | coordinates                  |

Cartographer's `concordance` stage asks Wikidata about every entity id that staging asserts, and
keeps the answers in a table of its own. Before the stage asks about any entity, the stage checks
each property's datatype and English label against what the code expects. A property id that changed
meaning fails the whole stage by name. Resolving nothing would look like a dataset with no
cross-references.

Wikidata is CC0, so the links carry no attribution obligation. The concordance relates identifier
systems with human review at a scale no single project could fund, and Atlas needs no fuzzy matching
to use it.

## 3. The resolution ladder

Atlas resolves identity as a graph. Each staged record is a node, and each identifier is a node. A
record links to the identifiers it asserts. A Wikidata entity links to the identifiers the
concordance says are the same thing. The places are the connected components.

### Tier 1: a shared identifier, behind a gate

Two staged records that assert the same merge key are the same place. The evidence is strong, and
the rule needs no score and no review.

The rule needs a gate, because a mapper's tag doesn't always mean identity. A mapper who tags a
surveillance camera with the Wikidata id of the company that operates the camera means the company.
Taken literally, tier 1 would collapse every one of that company's cameras across a region into one
place. **Tier 1 is deterministic about the claim and gated on the merge.** Two gates apply, and
neither is enough alone:

1. **Not a place.** A `wd:` id whose entity has no coordinates (P625) is not an identity claim.
2. **Not one place.** An identifier whose asserting records lie more than 500 m apart
   (`MERGE_SPAN_M`) is not merged on. PostGIS measures the span.

A refused identifier is still carried in `upstream`, because the source did say it. The refusal only
stops the merge. Every refusal lands in an `ambiguous_ids` table with its record count, its span and
its reason. Without the table, "these records are separate places" and "nothing shared an
identifier" would look the same.

A `wd:` id with no concordance answer yet is a third state. Nothing is known about it, so the id
can't establish identity in this run. The stage reports these ids apart from the refusals, so "the
concordance hasn't run" never reads as "these places don't cross-reference".

The gate has no exception for large features. Two ways of one large park can lie more than 500 m
apart, and the gate then keeps them as two places. A wrong split costs two pins near each other. The
table names each refusal, so a reviewer can join them (§4).

### Tier 2: Wikidata as a bridge

Record A asserts `wd:Q2680081`. Record B asserts `nrhp:77001360` and no Wikidata id. Wikidata says
Q2680081 has P649 = 77001360. A and B are therefore the same place, and the place gains both ids.

Tier 2 is deterministic and free. Tier 2 is also what joins sources that don't know about each
other. The National Register doesn't know OpenStreetMap, and OpenStreetMap mostly doesn't know the
Park Service. Wikidata knows both.

### No fuzzy tier

Atlas doesn't match records by distance and name. Two records that share no identifier directly or
through the concordance publish as two places.

The bias toward splitting is deliberate. A wrong split is two pins a few meters apart: visibly odd,
harmless and fixable. A wrong merge is a parking lot wearing a lighthouse's description and a
museum's photo, which is confidently wrong data that nobody notices.

### Derivation is not evidence

Some records are built out of another record. A Wikipedia article staged for the OpenStreetMap
record that cited it is one. The Park Service, RIDB and contribution improvements are others. Such a
record belongs to its parent's place and says so directly: `source_records.derived_from` names the
parent, and the resolver links the two record nodes.

A derived record asserts no identifiers of its own. The tiers answer which **independent** records
describe one place. A derived record is the same source read a second way, so counting it as
agreement would be circular. Copying the parent's identifiers onto it would also break two things:

- **The first rule of §1.** Wikipedia never asserted the parent's `osm:` id.
- **The gate's measurement.** The span check measures the identifiers that more than one record
  asserts. Copies would make every parent identifier look shared, and the population the gate is
  tuned on would stop describing real sources.

A derivation is still a build-time judgement and can be wrong. The article a mapper's tag pointed at
can turn out to describe something else. A `distinct` decision vetoes a derivation like any other
claim (§4).

## 4. Decisions persist, the negative ones too

A reviewer's verdicts live in a `decisions` table that no build rewrites. Each row is one verdict:

- **`distinct`** names one claim: the asserter and the node it claimed. The asserter is usually a
  record and the node an identifier, so the row reads "this record doesn't assert that identifier".
  The asserter can also be a Wikidata entity's bridge or a derived record's parent. The resolver
  drops that one link. A verdict naming two identifiers instead could not separate two records that
  a third claim still links.
- **`same`** names two records and joins them. The join outranks the gate, so a reviewer can join
  the two ways of a large park that the span check kept apart.

The schema keeps one row per unordered pair. Two orientations could otherwise hold a `same` and a
`distinct` at once. A verdict records who decided and the evidence the gate showed. Verdicts apply
at the next `resolve` run. The review console edits this input and never the graph
([Cartographer](cartographer.md) §5).

A vetoed claim's identifier becomes carried and not established. Merge keys are derived from the
graph, where each identifier node has exactly one root. One merge key therefore belongs to only one
place by construction.

**The negative verdict matters as much as the positive one.** Without it every build would propose
again the pair a reviewer rejected, and the queue would never drain.

The consequences:

- A rebuild from the same inputs and the same decisions produces the same places. Identity is
  reproducible, which makes a volume auditable.
- A better matcher doesn't quietly re-partition the dataset. Existing verdicts stand until a person
  changes them.
- A reviewer's work is permanent and reaches every consumer of every later volume.

## 5. Atlas place ids, and why they never move

An Atlas place id is a ULID, assigned once and stable for the life of the place across every version
of every volume. A consumer's stored state rests on this guarantee. Ids are the one
non-deterministic input to a build: `mintId()` allocates a new ULID only for a place that never
existed before (see [Cartographer](cartographer.md) §4).

At each rebuild a place keeps the id of the earlier place whose merge keys it holds. Carried
identifiers don't count. Carried identifiers accumulate on many places, and looking places up by
them would glue back together what the gate separated.

### Merges ship as aliases

When a rebuild finds that two earlier places are one, one id survives and the other becomes an
**alias**. The alias is listed in the survivor's `aliases` and resolves forever. The survivor is the
earlier place with more member records, and a tie goes to the older ULID.

Consider the alternative. A server imported the losing id, and the next volume no longer contains
it. The server's scoped retirement does what it should and retires the place. The surviving id then
arrives as a new place with a new `unique`, and the operator's edits and the players' contributions
go with the old one. With aliases the consumer maps the old id forward, and the merge lands on the
same place.

- **An alias never expires.** A mirror or a server may be years behind.
- **Aliases are flattened at publish.** If A merged into B and later B into C, C lists both A and B.
  A consumer resolves in one step and never follows a chain.
- **Aliases only accumulate.** They are never rewritten or pruned.

### Splits

When a rebuild finds that one earlier place is two, the part that holds more of the earlier place's
merge keys keeps the id and the other part gets a new one. A consumer sees one place change and one
place appear, which loses nothing. An id that became an alias is never brought back as a separate
place.

### Withdrawals

A place that no longer exists in any source is absent from the next volume. The consumer's
cell-scoped retirement handles the absence. Absence is not an alias, and the build reports withdrawn
ids apart from merged ones. A withdrawn id is never reused. A place a reviewer removed is also named
in the manifest's `retired` list ([volume format](volume-format.md) §2).

## 6. What a consumer does

The consumer's whole algorithm:

1. **Derive a `sourceId`** from `upstream` by a fixed order. The first namespace present wins:
   1. `contrib:` rendered as the consumer's own place `unique`, only for an id the consumer issued
      itself (§7);
   2. `osm:`, rendered as `<type>/<id>` such as `way/586464226`;
   3. `wd:` then `nrhp:` then `gnis:` then `nps:`, each kept with its prefix;
   4. the Atlas `id` when none of these is present.

   The order is fixed so two volumes that describe one place derive the same key on their own. The
   OpenStreetMap form matches the records the server's older OSM connector wrote, because the match
   is string equality. The other namespaces keep their prefix and can't collide with that form.

2. **Find a place a live record of any source already holds** under that `sourceId`, and reuse its
   `unique`.
3. **Otherwise try each alias** the same way. A place with no upstream id is keyed by its Atlas id,
   so an alias is a `sourceId` too.
4. **Upsert** through the server's ordinary pipeline. The merge, the conflicts and the retirement
   are unchanged.

What the consumer never does is ask an operator whether two places are duplicates. The conflict
queue is for an import that disagrees with an operator's own edit. Dataset hygiene isn't the
operator's job.

Mechanical matching has an honest limit. Two volumes built from OpenStreetMap agree, because both
carry `osm:` ids. Two volumes may each build a place from a different source other than
OpenStreetMap with no shared Wikidata link. They then derive different keys, and a server importing
both shows two places. That failure is two pins and never corrupted data.

## 7. The contribution loop

Player contributions exported from a Beacon server come back into Atlas as a source ([Beacon
integration](beacon-integration.md) §9). A contribution's text then returns to the server inside a
volume. Two things must hold.

**Atlas must not count its own output as corroboration.** An improvement to a known place joins that
place by naming one of its records. The improvement asserts no identifiers (§3, derivation). The
improvement adds no identifier node, no asserter to the gate's span and nothing to either tier's
count. A record that restated the place's identifiers would count as a second source agreeing with
the volume Atlas published earlier.

**The originating server must recognize its own contribution coming home.** A contributed new place
asserts `contrib:<host>/<unique>` and nothing else, and becomes a place of its own. The id stays in
`upstream` forever. The server named by `<host>` renders the id back to its own place `unique` (§6,
step 1), so the volume's copy lands on the original place and doesn't duplicate it. Every other
server falls through to the next namespace or the Atlas id, because a ULID minted on another server
belongs to an id space it doesn't share.

A contribution can't outrank itself on the way back. The server ranks `contrib` above `atlas:`, so
the volume's copy of a player's words never replaces the player's own record. Provenance also stays
honest: the volume can say a description came from a player on a Beacon server, which is a different
claim from a park service describing its own park.

## 8. Worked example

Two staged records describe one lighthouse:

```text
staging:
  A  osm        w/586464226      name "Mukilteo Lighthouse"
                                 tags { wikidata=Q2680081, source_ref=https://catalog.archives… }
  B  wikipedia  (derived from A) the article "Mukilteo Light": intro and lead image

concordance, for wd:Q2680081:
  P649 (NRHP)  77001360
  P590 (GNIS)  1531329
  P625         present, so the id may establish identity

resolve:
  A asserts osm:w/586464226 and wd:Q2680081
  wd:Q2680081 bridges to nrhp:77001360 and gnis:1531329        tier 2
  B joins A by derivation                                      no tier
  → one place

published:
  id        01KZACBCJFMHG7Q4CND9SJHWJN
  upstream  ["gnis:1531329", "nrhp:77001360", "osm:w/586464226", "wd:Q2680081"]
  name      "Mukilteo Lighthouse"     from OpenStreetMap, which wins names
  sources   [osm, wikipedia]
```

The example shows two rules at work. The OpenStreetMap way's own NRHP tag holds a URL, and the
register number appears only in a generic `source_ref` tag that doesn't say what it is. Stage 1
reads no identifier out of either, because a guessed id would corrupt a merge (§1). Tier 2 then
recovered the register number from Wikidata, plus a GNIS id no source in staging had asserted. The
identity was resolved entirely from identifiers, with no fuzzy matching and no review.
