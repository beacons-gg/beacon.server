import {
  geohashCellSchema,
  placeCategorySchema,
  ulidSchema,
  type PlaceTaxonomy,
} from "@beaconsgg/protocol-types";
import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { badRequest, missing, notFound } from "../common/capability-http";
import { validatedCsvParam } from "../common/query";
import { ReadRateLimitGuard } from "../common/read-rate-limit.guard";
import { PlacesService, type PlacesQueryOptions } from "./places.service";

/** Parse-volume guard on the `categories` CSV (the list is deduped below; the enum is the real bound). */
const MAX_QUERY_CATEGORIES = 16;

/**
 * The places read endpoints (`doc/spec/places.md` §5): `GET /places?cells=&categories=`
 * (multi-cell, the discovery shape) and `GET /places/:unique` (detail with geometry + provenance).
 * Public + unsigned + IP read-rate-limited — the dataset is served from the server's own store, so
 * there is no upstream to protect and no cache-busting surface: query params are charset-validated
 * and count-capped before they reach the store (the geo cost trap). Disabled ⇒ `404`.
 */
@Controller()
export class PlacesController {
  constructor(private readonly places: PlacesService) {}

  @Get("places")
  @UseGuards(ReadRateLimitGuard)
  async query(
    @Query("cells") cells?: string | string[],
    @Query("categories") categories?: string | string[],
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
    @Query("spread") spread?: string,
  ) {
    if (!this.places.enabled) notFound();
    const cellList = validatedCsvParam(cells, geohashCellSchema, {
      label: "cells",
      min: 1,
      max: this.places.queryMaxCells,
    });
    // The coarseness floor: a near-world prefix would scan the whole cell index (the geo cost trap).
    if (cellList.some((c) => c.length < this.places.minCellPrecision)) {
      badRequest(`\`cells\` must be at least precision ${this.places.minCellPrecision}`);
    }
    // validatedCsvParam(undefined) is [], and the store treats [] as "no filter" — no branch needed.
    const categoryList = [
      ...new Set(
        validatedCsvParam(categories, placeCategorySchema, {
          label: "categories",
          max: MAX_QUERY_CATEGORIES,
        }),
      ),
    ];
    // Keyset paging (opt-in): `cursor` is a prior page's result `cursor` (a place unique); `limit`
    // requests a smaller page (clamped to the server's page size in the service).
    const opts: PlacesQueryOptions = {};
    if (cursor !== undefined) {
      const parsed = ulidSchema.safeParse(cursor);
      if (!parsed.success) badRequest("`cursor` must be a ULID (a prior page's `cursor`)");
      opts.cursor = parsed.data;
    }
    if (limit !== undefined) {
      const n = Number(limit);
      if (!Number.isInteger(n) || n < 1) badRequest("`limit` must be a positive integer");
      opts.limit = n;
    }
    // `spread=1`: one page sampled evenly across the cells instead of the lowest ids, which after a
    // bulk import sit in one corner. A map showing a capped page wants this; it has no next page.
    if (spread !== undefined) {
      if (spread !== "1") badRequest("`spread` must be 1");
      if (opts.cursor !== undefined) badRequest("a `spread` page has no `cursor`");
      opts.spread = true;
    }
    return this.places.query(cellList, categoryList, opts);
  }

  /**
   * The curated category → subcategory vocabulary (`doc/spec/place-proposals.md` §4.2) — what a
   * contribution UI renders its pickers from, and what the propose validator fences submissions to.
   * Public + unsigned; changes only when an operator edits the tag map, so it's freely cacheable.
   *
   * **Declared before `places/:unique` on purpose:** Nest matches in declaration order, and the
   * param route would otherwise swallow this path (`"taxonomy"` fails the ULID parse → a 400).
   */
  @Get("places/taxonomy")
  @UseGuards(ReadRateLimitGuard)
  taxonomy(): PlaceTaxonomy {
    if (!this.places.enabled) notFound();
    return this.places.taxonomy();
  }

  @Get("places/:unique")
  @UseGuards(ReadRateLimitGuard)
  async detail(@Param("unique") unique: string, @Query("contributors") contributors?: string) {
    if (!this.places.enabled) notFound();
    const parsed = ulidSchema.safeParse(unique);
    if (!parsed.success) badRequest("`unique` must be a ULID");
    // Opt-in, because the response schema is `.strict()`: a client that doesn't ask never receives
    // the key, so adding it can't break an app already in a player's hands.
    const place = await this.places.detail(parsed.data, contributors === "1");
    if (!place) missing("unknownPlace", "no active place has that `unique`");
    return place;
  }
}
