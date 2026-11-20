import { ALLOWED_OPERATORS } from "@beaconsgg/jsonlogic-profile";
import { opMarkers, policyMarkers, ruleMarkers } from "@beaconsgg/protocol-types/server";
import { HANDLERS } from "./handlers";

/**
 * The `op:`, `policy:` and `rule:` markers for what this engine accepts beyond the baseline: each
 * op it has a handler for, each policy feature the placement schema takes, and each JSONLogic
 * operator placement lets into a rule body. Facts about the build, so a server advertises them
 * unconditionally (see `markers.ts` in `@beaconsgg/protocol-types`).
 *
 * The `policy:` half is read off `@beaconsgg/protocol-types`, so a version of it that adds a policy
 * field advertises the field here. That is right only while the engine implements the field in the
 * same release, which the release process guarantees.
 */
export function acceptedMarkers(): string[] {
  return [
    ...opMarkers(Object.keys(HANDLERS)),
    ...policyMarkers(),
    ...ruleMarkers(ALLOWED_OPERATORS),
  ];
}
