import { Injectable } from "@nestjs/common";
import { DidRateLimiter, envLimiter } from "./did-rate-limit";

/**
 * The per-DID budgets for the **game write surface** (rooms, ops, scouts), keyed on the
 * cryptographically verified actor rather than the client IP.
 *
 * IP is the wrong key here in both directions, and a location game produces both failures. It is
 * **over-broad**, because players deliberately gather at one real-world place and share that
 * venue's wifi or a carrier NAT, so one abuser rate-limits everyone standing near them. It is
 * **under-broad**, because a phone changes IP by walking down the street or toggling airplane mode,
 * which resets the budget for free. The IP guard stays as the outer bound on unverified traffic;
 * this is the inner bound on a known account.
 *
 * **Two classes, because background and player-initiated writes have different shapes.** Pooling
 * them is what produces the confusing failure the IP guard's breach log exists to diagnose: a
 * runaway scout heartbeat drains the shared budget, and an unrelated jar take is what fails.
 *
 * | Class      | Covers                              | Knobs                          | Default |
 * | ---------- | ----------------------------------- | ------------------------------ | ------- |
 * | **player** | `place`, and every signed room op   | `BEACON_OP_RATE_LIMIT_*`       | 120/60s |
 * | **relay**  | `POST /scouts` (`report`, `cancel`) | `BEACON_SCOUT_RATE_LIMIT_*`    | 120/60s |
 * | _override_ | `react`, on top of the player class | `BEACON_REACT_RATE_LIMIT_*`    | 60/60s  |
 *
 * Both defaults are sized from what the client actually does, not guessed. The relay heartbeat is
 * one POST per deployed scout per covering server per minute (`RELAY_MS` in `useMyScoutSync`), so
 * ten scouts across three servers sits at 30 a minute and 120 leaves four times the headroom that
 * honest play needs. Player writes are human-paced: 120 a minute is far past tapping through a
 * capsule and far short of a script.
 *
 * A per-op **override can only ever tighten**. An op charges its class budget *and* its override
 * and must pass both, so an override is never a way to buy room beyond the class ceiling.
 *
 * **Verification happens before any of this**, so a flood of *invalid* signatures is still bounded
 * only by the IP guard. That is a deliberate property rather than an oversight: an Ed25519 verify
 * is cheap next to the store write it protects, and the budget cannot key on an actor that has not
 * been established yet.
 *
 * In-process and per-instance by design (one server process per database), like every other limiter
 * here. A multi-instance deploy needs a shared limiter, deferred on the horizontal-scaling trigger
 * along with both IP guards.
 */
@Injectable()
export class DidBudgets {
  /**
   * A placement, and every signed op applied to a room. That includes the read-only `list`, on
   * purpose: the engine bills before it branches on `READ_ONLY_OPS`, and a `list` still costs a
   * signature verify, a nonce round trip and a store read, so it is not free to serve.
   */
  private readonly player = envLimiter("BEACON_OP_RATE_LIMIT", 120);

  /** Background relay traffic: the scout heartbeat and its cancel. */
  private readonly relay = envLimiter("BEACON_SCOUT_RATE_LIMIT", 120);

  /**
   * Ops that need a tighter budget than the player class gives them. `react` is the one a bored
   * client fires as fast as it can tap, and 60 a minute is well past a human tapping through a
   * capsule's memories and well short of a script filling a room's ledger.
   */
  private readonly perOp: ReadonlyMap<string, DidRateLimiter> = new Map([
    ["react", envLimiter("BEACON_REACT_RATE_LIMIT", 60)],
  ]);

  /**
   * Charge one player-initiated write against the class budget and any per-op override. True when
   * it is within both.
   *
   * Both counters are charged on every attempt, deliberately without short-circuiting. If the class
   * verdict could skip the override's charge, an account that exhausted its class budget would stop
   * advancing the override's window and carry phantom headroom into the next one, so what an
   * override permits would depend on how the class happened to fare.
   */
  allowPlayerWrite(actor: string, op: string): boolean {
    const withinClass = this.player.check(actor);
    const override = this.perOp.get(op);
    const withinOverride = override === undefined || override.check(actor);
    return withinClass && withinOverride;
  }

  /** Charge one scout relay write (`report` or `cancel`). True when it is within budget. */
  allowRelayWrite(actor: string): boolean {
    return this.relay.check(actor);
  }
}
