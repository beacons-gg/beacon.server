import { cellBounds } from "@beaconsgg/geo";
import type { ServerConfig } from "../config";
import type { DescriptorFacts } from "../server-identity";

/**
 * What the home page shows (`GET /` for a browser): this server as its signed descriptor states it,
 * plus how to add it to a game. Everything here is already public, through the descriptor or the
 * health probe, except the two room counts, which show on an open server unless the operator says
 * otherwise (`BEACON_HOME_STATS`).
 */
export interface HomeView {
  name: string;
  description: string | undefined;
  /**
   * Whether the operator gave a contact. The page does not print it: a visitor asks for it with a
   * click and the page's script reads it from the signed descriptor, so a scraper reading the HTML
   * finds no address. (The descriptor carries it by protocol, so it is public, only not handed out.)
   */
  hasContact: boolean;
  /** The address a game adds, and the QR code carries. */
  origin: string;
  /** The origin without its scheme, for the caption under the QR code. */
  hostLabel: string;
  key: string;
  version: string;
  startedAt: string;
  accessLevel: string;
  /** The admitted games by slug; empty means every game is welcome. */
  games: string[];
  /** The service capabilities, in a fixed order, each on or off. */
  capabilities: Array<{ id: string; label: string; on: boolean }>;
  /** The coverage prefixes; `[""]` is everywhere. */
  coverage: string[];
  /** Each covered cell's rectangle, for the map: `[west, south, east, north]`. */
  coverageBounds: Array<[number, number, number, number]>;
  ready: boolean;
  /** Absent when the operator turned the counts off. */
  rooms: { total: number; changedThisMonth: number } | undefined;
  /** Active places, the console's overview count. Absent with the counts off or places not served. */
  places: number | undefined;
  /** The QR code of {@link origin}, as an SVG document. */
  qrSvg: string;
  consoleLink: string | undefined;
  siteUrl: string | undefined;
  /** The network's own guide to Beacon servers, on the site: `<site>/docs`. */
  aboutUrl: string | undefined;
  mapTiles: string | undefined;
  /** Where the server's source code is: the AGPL's offer of the source (`BEACON_SOURCE_URL`). */
  sourceUrl: string | undefined;
  docsPath: string | undefined;
}

/**
 * The service capabilities a visitor can understand, in the order the page lists them, with what
 * each means for a player. Protocol markers (`game:<slug>`, `op:`, `policy:`, `rule:`)
 * are for clients, not people, and are not listed.
 */
export const CAPABILITIES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "mailbox", label: "Messages between players, held until they are read." },
  { id: "media", label: "Photos on places, rooms and challenges." },
  { id: "places", label: "A map of real places, curated by the operator." },
  { id: "places-proposals", label: "Players can suggest places for the operator to review." },
  { id: "geocode", label: "Looks up addresses and place names for games." },
];

/** The admitted games: the operator's allowlist, read from the `game:<slug>` markers. */
export function gamesOf(capabilities: readonly string[]): string[] {
  return capabilities.filter((c) => c.startsWith("game:")).map((c) => c.slice("game:".length));
}

/** Each coverage prefix as a map rectangle; the empty prefix (everywhere) is the whole world. */
export function boundsOf(coverage: readonly string[]): Array<[number, number, number, number]> {
  return coverage.map((prefix) => {
    if (prefix === "") return [-180, -85, 180, 85];
    const b = cellBounds(prefix);
    return [b.minLng, b.minLat, b.maxLng, b.maxLat];
  });
}

/** Whether the room counts show: as the operator said, or on an open server when they said nothing. */
export function statsShown(setting: "auto" | "on" | "off", accessLevel: string): boolean {
  return setting === "on" || (setting === "auto" && accessLevel === "open");
}

/** Whether the place count shows: where the counts do, on a server that serves places. */
export function placesShown(
  config: Pick<ServerConfig, "homeStats">,
  facts: Pick<DescriptorFacts, "accessLevel" | "capabilities">,
): boolean {
  return (
    statsShown(config.homeStats, facts.accessLevel) && (facts.capabilities ?? []).includes("places")
  );
}

/** The console's page for adding a server, with this one's address filled in. */
export function consoleLinkFor(consoleUrl: string | undefined, origin: string): string | undefined {
  return consoleUrl ? `${consoleUrl}/servers?add=${encodeURIComponent(origin)}` : undefined;
}

export function buildHomeView(input: {
  facts: DescriptorFacts;
  config: Pick<
    ServerConfig,
    | "publicUrl"
    | "docsEnabled"
    | "docsPath"
    | "homeConsoleUrl"
    | "homeSiteUrl"
    | "homeMapTiles"
    | "homeStats"
    | "sourceUrl"
  >;
  ready: boolean;
  rooms: { total: number; changedThisMonth: number } | undefined;
  places: number | undefined;
  qrSvg: string;
}): HomeView {
  const { facts, config } = input;
  const origin = config.publicUrl.replace(/\/+$/, "");
  const capabilities = facts.capabilities ?? [];
  return {
    name: facts.name ?? facts.host,
    description: facts.description,
    hasContact: (facts.contact?.trim() ?? "") !== "",
    origin,
    hostLabel: origin.replace(/^https?:\/\//, ""),
    key: facts.key,
    version: facts.version,
    startedAt: facts.startedAt,
    accessLevel: facts.accessLevel,
    games: gamesOf(capabilities),
    capabilities: CAPABILITIES.map((c) => ({ ...c, on: capabilities.includes(c.id) })),
    coverage: facts.coverage,
    coverageBounds: boundsOf(facts.coverage),
    ready: input.ready,
    rooms: statsShown(config.homeStats, facts.accessLevel) ? input.rooms : undefined,
    places: placesShown(config, facts) ? input.places : undefined,
    qrSvg: input.qrSvg,
    consoleLink: consoleLinkFor(config.homeConsoleUrl, origin),
    siteUrl: config.homeSiteUrl,
    aboutUrl: config.homeSiteUrl ? `${config.homeSiteUrl}/docs` : undefined,
    mapTiles: config.homeMapTiles,
    sourceUrl: config.sourceUrl,
    docsPath: config.docsEnabled ? `/${config.docsPath}` : undefined,
  };
}
