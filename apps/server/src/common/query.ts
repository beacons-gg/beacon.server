import { gamesFilterSchema } from "@beaconsgg/protocol-types";
import { badRequest } from "./capability-http";
import type { ZodType } from "zod";

/**
 * Shared validation for untrusted comma-separated **query params** (discovery `cells` / `types`).
 *
 * Queries themselves are always parameterized ($1/?), so classic SQL injection isn't possible — but a
 * raw CSV param can still carry (a) an unbounded number of values (a giant `OR …` query / cost trap)
 * and (b) `LIKE`/`GLOB` metacharacters that change query meaning on some backends. This is the single
 * choke point that rejects both before the value reaches a store, using an **allowlist** element
 * schema (e.g. the geohash charset) rather than escaping a denylist.
 */

/*
 * Discovery's counts (cells, types, games) are also in core's `discoveryQuerySchema` since 1.0. The
 * server applies its own, for the per-param message and to refuse a long list before parsing any
 * token; discovery.test.ts fails when the two disagree.
 */

/**
 * The shared per-request cell-list cap (the geo cost trap): discovery, the WS subscribe bound, and
 * the places read default all agree on this number by construction, not by comment.
 */
export const MAX_QUERY_CELLS = 256;

/**
 * Split a comma-separated query param into trimmed, non-empty tokens. A repeated key
 * (`?games=a&games=b`) arrives from Express as an array, and reads as the same list joined.
 */
export function csvParam(value: string | string[] | undefined): string[] {
  return (Array.isArray(value) ? value.join(",") : (value ?? ""))
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse a CSV query param into a bounded, element-validated list. Throws `400 invalid` when the count
 * is below `min` / above `max`, or when any token fails `element` (the allowlist). `label` names the
 * param in the error message.
 */
export function validatedCsvParam<T>(
  value: string | string[] | undefined,
  element: ZodType<T>,
  opts: { label: string; min?: number; max: number },
): T[] {
  const tokens = csvParam(value);
  const min = opts.min ?? 0;
  if (tokens.length < min) {
    badRequest(`\`${opts.label}\` requires at least ${min} value${min === 1 ? "" : "s"}`);
  }
  if (tokens.length > opts.max) {
    badRequest(`\`${opts.label}\` accepts at most ${opts.max} values (got ${tokens.length})`);
  }
  const out: T[] = [];
  for (const token of tokens) {
    const parsed = element.safeParse(token);
    if (!parsed.success) badRequest(`invalid \`${opts.label}\` value: ${JSON.stringify(token)}`);
    out.push(parsed.data);
  }
  return out;
}

/** Max games in one read's `games` filter. */
export const MAX_QUERY_GAMES = 16;

/** Max `types` filters in one discovery read (jar/capsule/scout + headroom). */
export const MAX_QUERY_TYPES = 16;

/**
 * A read's `games` filter (beacon.core `doc/spec/discovery.md` §4.1): absent is every game's
 * content, present is one or more slugs. A present but empty `games=` is a 400 rather than "every
 * game", because the filter's absence already says that.
 */
export function gamesQueryParam(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  // The wire's own rule for the filter (`gamesFilterSchema`: one or more slugs), applied per token.
  return validatedCsvParam(value, gamesFilterSchema.element, {
    label: "games",
    min: 1,
    max: MAX_QUERY_GAMES,
  });
}
