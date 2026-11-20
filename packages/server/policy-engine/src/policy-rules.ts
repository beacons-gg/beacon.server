import { assertValidRule } from "@beaconsgg/jsonlogic-profile";
import type { Policy } from "@beaconsgg/protocol-types";
import { grantRulesOf, MAX_OP_LEDGER, OP_LEDGER_KEYS, RESERVED_STATE_KEYS } from "./lifecycle";

/**
 * Whitelist-validate **every JSONLogic rule a policy carries**, in one place, so no rule-bearing field
 * can be added to `Policy` and quietly skip the profile gate.
 *
 * Three fields carry rules, for different reasons:
 *
 * - **`derived`** — the server evaluates these itself (a capsule's contended lock/unlock recompute), so
 *   an off-profile op here would reach the evaluator.
 * - **`grant[].when`** — also server-evaluated (the grant gate, engine step 8b); same exposure as
 *   `derived`.
 * - **`unlockTransform`** — the server *never* evaluates these; a client applies them at claim. It still
 *   has to validate them, because it is the only party that can stop a bad rule from being **persisted
 *   and fanned out**. An unvalidated rule is accepted at placement, stored, and served to every client;
 *   `applyUnlockTransform` then throws inside the whitelist gate at claim time — after the claim op has
 *   already succeeded server-side and transferred custody. The player's items move and never arrive.
 *   Validating at the boundary turns that into a clean rejection of the *placement* instead.
 *
 * A game authoring its own predicates (the `when` on an unlock rule) is exactly the case this protects:
 * the rule is written by one client and executed by every other one.
 *
 * Throws the underlying `assertValidRule` error; callers on the HTTP path catch it for a clean 400.
 */
export function assertValidPolicyRules(policy: Policy): void {
  // Derived keys are written into room state by `recomputeDerived` on every op, so a formula named
  // after an engine-owned key overwrites it: `derived: { reactions: ... }` replaces the reaction
  // ledger with a number, and `getReactions`' defensive array guard then reads it back as none,
  // killing dedupe and the bound with nothing logged. Same invariant as `grant.from` below, and the
  // same place to hold it: the reserved set, at placement.
  if (policy.derived) {
    for (const [key, rule] of Object.entries(policy.derived)) {
      if (RESERVED_STATE_KEYS.has(key)) {
        throw new Error(`derived key "${key}" is a reserved state key`);
      }
      assertValidRule(rule);
    }
  }
  if (policy.unlockTransform) {
    for (const rule of policy.unlockTransform) {
      if (rule.when !== undefined) assertValidRule(rule.when);
      for (const formula of Object.values(rule.set)) assertValidRule(formula);
    }
  }
  // Grant rules — the server evaluates `when` itself at grant time (engine step 8b), and a rule's
  // pool may not claim an engine-owned state key (a pool named `contributors` would let a seeded
  // placement forge the ledger; `granted` would pre-consume grants). Enforced HERE so it holds for
  // every placement path, like the other policy invariants; the HTTP boundary pre-checks for a 400.
  for (const rule of grantRulesOf(policy)) {
    if (rule.when !== undefined) assertValidRule(rule.when);
    if (RESERVED_STATE_KEYS.has(rule.from)) {
      throw new Error(`grant.from "${rule.from}" is a reserved state key`);
    }
  }
  // An op's ledger bound is policy data with a hard engine ceiling behind it. Refuse BOTH failures
  // HERE rather than absorbing them at op time: a bound above the ceiling would otherwise be
  // accepted and then quietly behave as something smaller, and a bound on an op that keeps no
  // ledger of its own would be accepted and then quietly behave as nothing at all. Neither leaves
  // the client any way to learn its policy was not the one the room got. `OP_LEDGER_KEYS` is the
  // registry of ops that keep one, so the next bounded op needs an entry there and no new wire type.
  for (const [op, rule] of Object.entries(policy.ops)) {
    if (rule.max === undefined) continue;
    if (!OP_LEDGER_KEYS.has(op)) {
      throw new Error(`ops.${op}.max is set, but "${op}" keeps no ledger of its own`);
    }
    if (rule.max > MAX_OP_LEDGER) {
      throw new Error(`ops.${op}.max ${rule.max} exceeds the engine ceiling of ${MAX_OP_LEDGER}`);
    }
  }
}
