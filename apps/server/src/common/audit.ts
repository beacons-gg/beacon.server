import type { DidKey } from "@beaconsgg/protocol-types";

/**
 * One structured audit line for an admin action, in the one format every admin controller logs
 * (`doc/spec/admin-api.md` §3, Audit): `op actor= target=`, then each detail given, then the
 * operator's reason.
 */
export function auditLine(
  op: string,
  actor: DidKey,
  target: string,
  details: readonly (string | undefined)[] = [],
  reason?: string,
): string {
  return [
    `${op} actor=${actor} target=${target}`,
    ...details,
    ...(reason !== undefined ? [`reason=${JSON.stringify(reason)}`] : []),
  ]
    .filter((part) => part !== undefined)
    .join(" ");
}

/** The detail of a removal: whether there was anything to remove. */
export function removedDetail(removed: boolean | undefined): string | undefined {
  return removed === undefined ? undefined : `removed=${String(removed)}`;
}
