import "reflect-metadata";
import { RequestMethod } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { APP_CONTROLLERS as CONTROLLERS, guardNames, mountedRoutes } from "./routes";

/**
 * The bucket each `GET` must be in. This is the design decision the PR makes, so it is asserted
 * rather than described: which guard a route carries decides whose traffic can exhaust whose
 * budget, and getting it wrong is quieter than having no guard at all, because it surfaces only as
 * somebody else's 429.
 *
 * Keyed on the **full** route path (controller prefix included), so two controllers cannot collide
 * on a bare handler path and inherit each other's entry.
 */
const EXPECTED = new Map<string, string>([
  ["discovery", "PlayerReadRateLimitGuard"],
  ["rooms/:id", "PlayerReadRateLimitGuard"],
  ["profiles/:id", "PlayerReadRateLimitGuard"],
  ["media/:hash", "PlayerReadRateLimitGuard"],
  // Its own bucket, so the hot path above cannot close the door a new client walks through.
  ["server/descriptor", "DescriptorRateLimitGuard"],
  // Its own bucket too, like the descriptor's.
  ["server/about", "AboutRateLimitGuard"],
  // Reference data: no player state, and /geocode proxies an upstream.
  ["geocode", "ReadRateLimitGuard"],
  ["places", "ReadRateLimitGuard"],
  ["places/taxonomy", "ReadRateLimitGuard"],
  ["places/:unique", "ReadRateLimitGuard"],
  // The home page and the files it loads: their own bucket, so a crowd opening the page from one
  // venue's wifi cannot spend the reference-data budget a game's place lookups draw on.
  ["", "HomeRateLimitGuard"],
  ["_home/:file", "HomeRateLimitGuard"],
]);

/**
 * `GET`s that carry no budget on purpose. Each needs a reason, because the default for a new read
 * route is "guarded" and this list is what a reviewer reads to check an exemption was deliberate.
 */
const EXEMPT = new Map<string, string>([
  ["health", "liveness; returns a constant, and an orchestrator must never be throttled out of it"],
  ["health/ready", "readiness; same reason, and a 429 here would read as an unhealthy instance"],
]);

/** Every `@Get` handler on a controller, as `[fullRoutePath, guardNames]`. */
function getRoutes(controller: new (...args: never[]) => object): Array<[string, string[]]> {
  return mountedRoutes(controller)
    .filter((route) => route.method === RequestMethod.GET)
    .map(({ path, handler }) => [path, guardNames(handler)]);
}

describe("read-guard coverage", () => {
  /**
   * A read route added later is silently unguarded forever: unlike the write path, there is no
   * signature, blocklist or budget behind it to fail loudly. So the inventory is asserted rather
   * than remembered. This is the read-side answer to the "every new signed route has to remember
   * the consult" problem on the write path.
   */
  it("puts every GET in its stated bucket, or names it exempt with a reason", () => {
    // Asserting the exact guard, not merely that one is present: membership in a set of three would
    // pass if `/discovery` were moved onto the reference-data bucket, which is the pooling this PR
    // exists to avoid, and it would show up only as a place lookup failing for someone else.
    const wrong: string[] = [];
    for (const controller of CONTROLLERS) {
      for (const [path, guards] of getRoutes(controller)) {
        if (EXEMPT.has(path)) continue;
        const expected = EXPECTED.get(path);
        if (expected === undefined) {
          wrong.push(`GET /${path} (${controller.name}): not in EXPECTED or EXEMPT`);
        } else if (!guards.includes(expected)) {
          wrong.push(
            `GET /${path} (${controller.name}): want ${expected}, got [${guards.join(", ")}]`,
          );
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it("finds the routes at all, so a metadata change cannot make the check vacuous", () => {
    // Without this, a Nest upgrade that renamed a metadata key would turn the assertion above into
    // "no routes, therefore none unguarded" and it would keep passing while checking nothing.
    const paths = CONTROLLERS.flatMap((c) => getRoutes(c).map(([p]) => p));
    expect(paths).toContain("discovery");
    expect(paths).toContain("server/descriptor");
    expect(paths).toContain("rooms/:id");
    expect(paths).toContain("media/:hash");
    expect(paths).toContain("health/ready"); // the controller prefix is really being joined
    expect(paths.length).toBeGreaterThanOrEqual(8);

    // Every listed route is real, so a rename cannot leave a stale entry silently guarding nothing.
    for (const path of [...EXPECTED.keys(), ...EXEMPT.keys()]) expect(paths).toContain(path);
  });
});

/**
 * Every POST a player or a stranger can reach carries a rate-limit guard, writes and signed reads
 * alike. The operator routes are the exemption, by design: they answer only keys on
 * `BEACON_ADMINS`, so the people they would throttle are the ones running the server.
 */
describe("POST guard coverage", () => {
  const isOperator = (path: string) => /^(places\/)?admin\//.test(path);

  it("guards every POST outside the operator surface", () => {
    const unguarded = CONTROLLERS.flatMap((controller) =>
      mountedRoutes(controller)
        .filter((route) => route.method === RequestMethod.POST && !isOperator(route.path))
        .filter(
          ({ handler }) => !guardNames(handler).some((name) => name.endsWith("RateLimitGuard")),
        )
        .map((route) => route.path),
    );
    expect(unguarded).toEqual([]);
  });

  it("puts the signed player reads in their own bucket", () => {
    for (const path of ["mailbox/fetch", "places/proposals/fetch"]) {
      const route = CONTROLLERS.flatMap((c) => mountedRoutes(c)).find(
        (r) => r.method === RequestMethod.POST && r.path === path,
      );
      expect(guardNames(route!.handler), path).toEqual(["SignedReadRateLimitGuard"]);
    }
  });
});
