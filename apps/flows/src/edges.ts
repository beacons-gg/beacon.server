/**
 * What the skew matrix tests the head against (beacon.core's `doc/core-compatibility.md` §6):
 *
 *   npm view @beaconsgg/client-sdk versions --json | beacon-skew-edges [<tag>=<core range> ...]
 *
 * prints the GitHub Actions matrix. Each edge of the core skew window, read off the registry's
 * version list, is a cell as the client: the driver on the published SDK at that version against
 * the head's server. Each server release named on the command line (a release tag of this
 * repository, with the `@beaconsgg/protocol-types` range it was built on) is a cell as the server:
 * the head's driver against the server as released, when that core is inside the window. An empty
 * window is an error, not an empty matrix: a matrix with no cells passes, and that would read as
 * "the skew is fine".
 */
import { compare, gte, minVersion, parse, type SemVer, validRange } from "semver";

export interface SkewEdge {
  version: string;
  /** Why this version is an edge of the window, for the job's name and summary. */
  why: string;
}

export const DIRECTIONS = ["old-client", "old-server"] as const;
export type Direction = (typeof DIRECTIONS)[number];

/**
 * Where the window starts. 0.3 restarted it on purpose (beacon.core's `doc/core-compatibility.md`
 * §6): it renamed the wire's room fields and refusal codes, and it is the first release under the
 * `@beaconsgg` scope, so no earlier client speaks to this server. Its first candidate is the floor:
 * until 0.3.0 itself is published, the latest candidate is the window's one edge.
 *
 * The old-server column has the same floor, applied to the core a release was built on
 * ({@link releaseInWindow}), so it fills again with the first server release on 0.3.
 */
export const SKEW_FLOOR = "0.3.0-rc.1";

/** The published versions inside the window: at or above the floor. */
export function aboveFloor(published: readonly string[]): string[] {
  return published.filter((v) => {
    const parsed = parse(v);
    return parsed !== null && gte(parsed, SKEW_FLOOR);
  });
}

/**
 * Whether a server release built on `coreRange` (its `@beaconsgg/protocol-types` range) is inside the
 * window: the range admits nothing below {@link SKEW_FLOOR}. An empty range, a release with no such
 * dependency (one from before the scope moved), is outside.
 */
export function releaseInWindow(coreRange: string): boolean {
  const lowest = coreRange !== "" && validRange(coreRange) ? minVersion(coreRange) : null;
  return lowest !== null && gte(lowest, SKEW_FLOOR);
}

/** Canary and spike builds are `0.0.0-…`: throwaway, never a release. */
const isRelease = (v: SemVer): boolean => !(v.major === 0 && v.minor === 0 && v.patch === 0);
const isStable = (v: SemVer): boolean => v.prerelease.length === 0;

/**
 * The edges, oldest first. With `N` the newest major on the registry:
 *
 * - both ends of `N-1`, when it has a stable release: its oldest minor (that minor's latest patch)
 *   and its latest release. §6 promises one major apart "at any minor", so the oldest app still
 *   installed is in the window, and it stays there when a first `N` candidate is published while
 *   every server and app in the field is still on `N-1`;
 * - both ends of `N` in the same way, once it has a stable release;
 * - while `N` has no stable release yet, only its latest release candidate: candidates may break
 *   each other until `N.0.0` (§3), so an older candidate is not in the window.
 *
 * A prerelease of a later minor or major is not an edge once `N` is stable: the head is ahead of
 * it, and the head is the other side of every cell.
 */
export function skewEdges(published: readonly string[]): SkewEdge[] {
  const releases = published
    .map((v) => parse(v))
    .filter((v): v is SemVer => v !== null && isRelease(v))
    .sort(compare);
  const newest = releases.at(-1);
  if (!newest) return [];
  const major = newest.major;

  const edges: SkewEdge[] = [];
  const add = (v: SemVer | undefined, why: string): void => {
    if (!v) return;
    const existing = edges.find((e) => e.version === v.version);
    if (existing) existing.why += `, and ${why}`;
    else edges.push({ version: v.version, why });
  };
  /** Both ends of a major's stable releases. Says whether it had any. */
  const addEnds = (of: number): boolean => {
    const stable = releases.filter((v) => v.major === of && isStable(v));
    const oldestMinor = stable[0]?.minor;
    if (oldestMinor === undefined) return false;
    add(stable.filter((v) => v.minor === oldestMinor).at(-1), `the oldest minor of ${of}.x`);
    add(stable.at(-1), `the latest ${of}.x`);
    return true;
  };

  addEnds(major - 1);
  if (!addEnds(major)) {
    add(newest, `the latest release candidate of ${newest.major}.${newest.minor}.${newest.patch}`);
  }
  return edges;
}

/** `npm view … versions --json` answers an array, or a bare string when there is one version. */
export function parseVersions(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  const list = typeof parsed === "string" ? [parsed] : parsed;
  if (!Array.isArray(list) || !list.every((v): v is string => typeof v === "string")) {
    throw new Error("expected a JSON array of version strings");
  }
  return list;
}

export interface MatrixCell extends SkewEdge {
  direction: Direction;
}

/**
 * The matrix for `strategy.matrix`: every core edge as the old client, and every server release as
 * the old server (its `version` is the release tag). The two lists are different things on purpose.
 * A core version says what an installed app speaks; what a deployed server speaks is whichever
 * core its release was built on, which only its own tree at the tag knows.
 */
export function skewMatrix(
  edges: readonly SkewEdge[],
  serverReleases: readonly SkewEdge[] = [],
): { include: MatrixCell[] } {
  return {
    include: [
      ...edges.map((edge) => ({ ...edge, direction: "old-client" as const })),
      ...serverReleases.map((release) => ({ ...release, direction: "old-server" as const })),
    ],
  };
}

if (require.main === module) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => (input += chunk));
  process.stdin.on("end", () => {
    try {
      const serverReleases: SkewEdge[] = [];
      for (const arg of process.argv.slice(2)) {
        const [tag = "", core = ""] = arg.split("=", 2);
        if (releaseInWindow(core)) {
          serverReleases.push({ version: tag, why: "the latest server release" });
        } else {
          console.error(`server release ${tag} is built on core "${core}", outside the window`);
        }
      }
      const edges = skewEdges(aboveFloor(parseVersions(input)));
      if (edges.length === 0) {
        // Between the restart and the floor's own release, no published client can speak to this
        // server, so the old-client column has nothing to test; it fills again on its own once the
        // floor is published. A matrix with no cell at all is still an error.
        if (serverReleases.length === 0) {
          console.error(
            `the skew window is empty: no release at or above ${SKEW_FLOOR} and no server release`,
          );
          process.exit(1);
        }
        console.error(`no release at or above ${SKEW_FLOOR} yet: the old-client column is empty`);
      }
      for (const edge of edges) console.error(`edge ${edge.version}: ${edge.why}`);
      for (const release of serverReleases) {
        console.error(`server release ${release.version}: ${release.why}`);
      }
      console.log(JSON.stringify(skewMatrix(edges, serverReleases)));
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(2);
    }
  });
}
