import type { Store } from "@beaconsgg/policy-engine";
import type { GlobalId } from "@beaconsgg/protocol-types";
import { Controller, Get, HttpException, HttpStatus, Inject } from "@nestjs/common";
import { STORE } from "../stores/store.module";

// A reserved id that is never a real room. A point lookup on it always executes a query against the
// backend (unlike `roomsInCells([])`, which both stores short-circuit before touching the DB) and
// returns no data — so readiness genuinely proves the pool / file handle is reachable.
const READINESS_PROBE_ID = "health@readiness-probe" as GlobalId;

/**
 * Health + readiness surface. Two probes:
 *
 * - `GET /health` — **liveness**: the process is up and serving. Cheap, no dependencies. A load
 *   balancer / orchestrator uses it to decide the container is alive.
 * - `GET /health/ready` — **readiness**: the durable {@link Store} answers a query, so the instance
 *   can take custody traffic. Returns 503 while the store is unreachable (e.g. Postgres not yet up),
 *   so a rollout doesn't route traffic to an instance that can't persist.
 */
@Controller("health")
export class HealthController {
  constructor(@Inject(STORE) private readonly store: Store) {}

  @Get()
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(): Promise<{ status: "ready" }> {
    try {
      // Result is ignored — the probe id is never a real room; awaiting the query is what proves the
      // store's backing is reachable (see READINESS_PROBE_ID).
      await this.store.getRoom(READINESS_PROBE_ID);
      return { status: "ready" };
    } catch {
      throw new HttpException(
        { status: "not-ready", error: "store unreachable" },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }
}
