# Atlas sources

This spec lists the sources Cartographer reads, what each one contributes and under what license.
The spec also covers how the build ranks sources against each other and what a redistributor of a
volume inherits. How each source enters the build is in [Cartographer](cartographer.md) §1.

Checked against Beacon 0.3.

The license notes in this spec describe how Atlas handles each source's terms. They are not legal
advice. Read each source's terms before you distribute a volume built from it.

## 1. Base layer

### OpenStreetMap

OpenStreetMap is the base of every volume. The import gives each place its point, its category, its
name and website and its polygon. The import also carries the tags that hold every other source's
join key: `wikidata=`, `wikipedia=`, `wikimedia_commons=`, `brand:wikidata=` and `website=`. No
other source covers ordinary places as fully. OpenStreetMap descriptions are sparse, and photos are
almost absent.

- **License:** ODbL 1.0. A volume is a database derived from OpenStreetMap (§7).
- **Input:** a regional `.osm.pbf` extract (from Geofabrik, for example) imported with `osm2pgsql`.

### Wikidata

Wikidata contributes no places. Wikidata is the concordance that links OpenStreetMap ids, NRHP
reference numbers and GNIS ids to each other ([place identity](place-identity.md) §2). Wikidata also
supplies image claims (P18), brand logo claims (P154) and English Wikipedia sitelinks.

- **License:** CC0. Wikidata carries no attribution obligation.
- **Input:** the Wikidata API, asked about the entity ids the extract asserts in batches of 50. At
  regional scale this costs a few hundred paced requests. A full dump is tens of gigabytes and pays
  off only for a continental build.

## 2. Descriptions

### English Wikipedia

The `wikipedia` stage reads the article a place's `wikipedia=` tag or Wikidata sitelink names. The
stage stages the article's introduction and lead image. Only English articles are read.

- **License:** CC BY-SA 4.0. Every Wikipedia description is a share-alike obligation for every
  reader downstream, which is why public-domain text of similar quality ranks above it (§5).
- **Lead images** are kept only when the file is on Wikimedia Commons. An article's lead image is
  sometimes a local fair-use upload, which may not be redistributed.

### US National Park Service

The Park Service describes its own parks, monuments, historic sites and trails with photos. The
`nps` stage fetches the whole unit list in one request with an API key.

- **License:** US federal works are in the public domain, with no attribution obligation. The volume
  still credits the Park Service.
- **Join:** the Park Alpha Code claim (P4083) on the place's Wikidata entity.
- **Gate:** the API states no license per image. A photo is claimed only when its credit line starts
  with "NPS". A photo credited to anyone else or to no one is counted and never published.

### Recreation.gov (RIDB)

RIDB lists federal recreation facilities such as campgrounds and trailheads, with descriptions and
photos. RIDB states no license of its own and names federal agencies and third parties alike in its
photo credits. The gate is therefore the license:

- **Text** stages only for a facility managed by one of six federal agencies:

  | RIDB `OrgID` | Agency                       |
  | ------------ | ---------------------------- |
  | 126          | Bureau of Land Management    |
  | 127          | US Fish and Wildlife Service |
  | 128          | National Park Service        |
  | 129          | Bureau of Reclamation        |
  | 130          | US Army Corps of Engineers   |
  | 131          | USDA Forest Service          |

- **Photos** stage only under a credit line that names a federal agency or Recreation.gov itself.

What passes is a US government work, and the volume declares it public domain. Everything else is
counted and never published.

- **Join:** an OpenStreetMap `website=` tag that names a recreation.gov campground page, or the RIDB
  facility claim (P6747) on a place's Wikidata entity. RIDB carries no ids that OpenStreetMap or
  GNIS share, so the source reaches only the places those two joins find.

### National Register of Historic Places

The register contributes merge keys only. The register's reference numbers reach Atlas through
OpenStreetMap tags and Wikidata's P649 claims ([place identity](place-identity.md) §3). The
register's narratives and photos live in scanned nomination documents with no machine-readable text,
and many of them are third-party works under copyright. Atlas therefore stages no register content.

### Player contributions

Approved contributions exported from a Beacon server are a source of their own ([Beacon
integration](beacon-integration.md) §9). They reach the places no institution describes.

- **License:** chosen per submission: CC0 1.0, or CC BY 4.0 when the contributor asked to be
  credited. Each description and photo carries its own credit. The strictest case is CC BY 4.0, so
  attributing every contributed field that way always meets the terms.

## 3. Photos

**A photo publishes only when its license can be verified per file.** A source that mixes licenses
and states which one applies to each file is safe to redistribute. A source that mixes them without
saying is not. A photo URL on a host that states no license per file is refused, and the media
report counts the refused references.

**A photo is never enlarged.** A source image narrower than the published size is published at its
own size. An upscaled image would claim detail the photo never had.

### Wikimedia Commons

Commons is a repository of files, each with its own license. The media stage reads each file's
license and author from Commons metadata when the stage fetches the file. A file whose license can't
be read is refused. A volume publishes each license pair as an interned credit, and each author and
file page per file. Atlas reaches Commons files five ways:

- **a mapper's own file**, named in a `wikimedia_commons=File:` tag;
- **a category lead** that a fixed rule picks from the category a mapper tagged. The rule takes
  photo files only, because a category also holds maps and scans;
- **the Wikidata image claim** (P18) of the place's entity;
- **a Wikipedia lead image** that lives on Commons;
- **containment**: a geotagged Commons photo whose coordinates lie inside the place's own area. The
  `commons-geo` stage loads the Commons `geo_tags` dump and joins it against staged areas under 2
  km². Past that size a photo inside the area is no longer a photo of the place. Aerial-survey
  images are geotagged on a grid and are dropped.

Search by distance alone finds photos of the town and not of the place, and Atlas doesn't use it.
Point places get no containment photos, because no honest gate exists for them.

**Brand logos** reach a chain store through its `brand:wikidata=` tag. The tag names the brand's
Wikidata entity, whose logo claim (P154) names a file on Commons. A brand's P18 is never used as a
fallback, because that image usually shows the company's headquarters. `brand:wikidata=` is never an
identifier of the place, since the tag names the chain.

### KartaView

KartaView is a street-level photo archive. Atlas uses KartaView as the floor of the photo ranking,
for places nothing else covers.

- **License:** CC BY-SA 4.0 across the whole archive, granted by KartaView. The API needs no key, so
  no platform terms attach to the build.
- **Attribution:** the API exposes no author per photo. Credits name "KartaView contributors" and
  link each photo's own KartaView page, which shows the uploader.
- **Gate:** the camera must stand within 35 m of the place and point within 50° of the bearing from
  the camera to the place. A frame with no recorded heading is never picked. Distance alone would
  pick frames that point down the street.

### The surveillance category gets no imagery search

Places in the `surveillance` category are left out of every imagery search: containment, KartaView
and brand logos. A picture of a pole-mounted camera wastes the volume's bytes and a server's media
store. The category's value is the location. The rule is by category and never by name. A photo a
mapper tagged on such a place by hand still resolves like any other.

## 4. Deliberately not included

| Source                                | Why not                                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| Google Places, Foursquare and Yelp    | their terms don't allow storing and redistributing the data, which a volume exists to do |
| Mapillary                             | its terms for registered apps don't fit a dataset made to be redistributed               |
| scraped point-of-interest sites       | neither licensable nor maintainable                                                      |
| USGS GNIS as content                  | names and coordinates only; kept as a merge key                                          |
| Commons search by distance or depicts | finds photos of the town and rarely of the place                                         |
| Wikivoyage as a photo corpus          | its images are Commons files, which Atlas already reads                                  |

## 5. Per-field priority inside Atlas

This order ranks sources against each other inside one build. The Beacon server ranks a volume as a
whole against an operator's edits and players' contributions ([Beacon
integration](beacon-integration.md) §6). The build ranks per field, and a lower-ranked source fills
only a field the winner left empty ([Cartographer](cartographer.md) §1.3).

**Name, category, subcategory, alternative names, point, polygon, website and Wikipedia link:** the
mapper first.

```text
OpenStreetMap  >  contributions  >  Park Service  >  RIDB  >  Wikipedia
```

A mapper's judgement about what a place is called locally and what kind of place it is beats a
national dataset. The taxonomy itself derives from OpenStreetMap tags. A contribution ranks second.
An improvement can't rename or move another place at all, so a contributed name reaches only a place
no other source knows.

**Description:** the owner first.

```text
Park Service  >  RIDB  >  contributions  >  OpenStreetMap  >  Wikipedia
```

The Park Service on its own park beats both a contributor and a mapper. A person who walked to a
place and wrote about it beats a mapper's one-line `description=` tag. Wikipedia comes last, so
public-domain text of similar quality wins.

A source the order doesn't name ranks after every named source, so it still fills an empty field.

**Photos:** a photo a person chose of the place first, then the freer license.

| Rank | Photo                                             |
| ---- | ------------------------------------------------- |
| 1    | a Park Service photo                              |
| 2    | a RIDB photo                                      |
| 3    | a contributor's own photo                         |
| 4    | a mapper's own Commons file                       |
| 5    | a Commons category lead                           |
| 6    | the Wikidata image claim (P18)                    |
| 7    | a Wikipedia lead image                            |
| 8    | a mapper's `image=` URL that names a Commons file |
| 9    | a Commons photo taken inside the place's area     |
| 10   | a brand logo                                      |
| 11   | a KartaView frame aimed at the place              |

A place publishes up to 4 photos in that order. Two principles shape both orders:

1. **An owner describing its own place beats a generalist.** The Park Service on a national park is
   better than an encyclopedia on the same park.
2. **The freer license wins when quality is comparable.** Every CC BY-SA field is a permanent
   obligation for every consumer. A public-domain field of similar quality is better for everyone
   downstream.

## 6. Coverage

**A volume aims for the largest and most complete set of places Atlas can produce.** A Beacon server
is platform infrastructure and doesn't judge which places matter. The game decides what to use.

**Remote areas and cities need different sources.** Remote areas live on parks, mountains and water.
Government data and OpenStreetMap's `natural=*` tags describe those. Cities live on public art,
landmarks and shops. Commons, brand logos and street imagery cover those. Neither half is a fallback
for the other.

**A mediocre photo beats no photo.** The target is a photo for every place, which is why street
imagery has a slot at all. Descriptions matter as much as photos.

**Coverage is measured per category.** Cartographer's report prints coverage per category and per
field, because one global percentage hides a park pipeline that works beside a `community` pipeline
that doesn't. The per-category number says which source to add next. Coverage in a volume is a
floor: a Beacon server adds its own photos, its operator's edits and its players' contributions on
top.

## 7. Licenses and attribution

A volume carries the terms of every source it holds: `dict.sources` and `manifest.licenses` for each
corpus, and a credit on each description and photo ([volume format](volume-format.md) §7). Anyone
who distributes a volume or shows its data inherits these obligations:

| Source             | License              | What a redistributor owes                                               |
| ------------------ | -------------------- | ----------------------------------------------------------------------- |
| OpenStreetMap      | ODbL 1.0             | attribution to OpenStreetMap contributors; share-alike for the database |
| English Wikipedia  | CC BY-SA 4.0         | attribution and share-alike for each Wikipedia description              |
| Wikimedia Commons  | per file             | what each file's own license asks, as its credit states                 |
| KartaView          | CC BY-SA 4.0         | attribution and share-alike for each KartaView photo                    |
| Park Service, RIDB | public domain        | nothing; the credit is a courtesy                                       |
| contributions      | CC0 1.0 or CC BY 4.0 | attribution for each CC BY field, as its credit states                  |
| Wikidata           | CC0                  | nothing; Wikidata adds links and no published fields                    |

**OpenStreetMap's license reaches the whole volume.** A volume is a database derived from
OpenStreetMap, and the ODbL applies to it. When you distribute a volume publicly, offer the database
under the ODbL (ODbL §4.4) and keep the OpenStreetMap attribution and license notice with it (§4.2).
A game that shows places from a volume is a produced work, and shows the OpenStreetMap attribution
(§4.3). Publicly using a volume or a produced work from one also obliges you to offer its recipients
the derived database in machine-readable form, or the method that made it (§4.6). The Beacon
server's place reads carry each source's attribution line for that purpose. Atlas publishes the
inputs, the per-field provenance and the per-source terms that make these obligations possible to
meet.

Two rules keep the credits true:

- **A description's credit travels with the description**, so a Park Service text never ships under
  Wikipedia's license.
- **A photo's credit travels with the photo.** The license pair is interned. The author and the
  file's page are per file.
