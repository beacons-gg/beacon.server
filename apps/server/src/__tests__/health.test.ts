import type { Store } from "@beaconsgg/policy-engine";
import { InMemoryStore } from "@beaconsgg/policy-engine/testing";
import { HttpException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { HealthController } from "../health/health.controller";

/**
 * The health surface: `/health` is unconditional liveness; `/health/ready` probes the durable Store
 * and 503s while it is unreachable. Here the store is a reachable in-memory one, so readiness
 * resolves.
 */
describe("HealthController", () => {
  const controller = new HealthController(new InMemoryStore());

  it("liveness returns ok", () => {
    expect(controller.live()).toEqual({ status: "ok" });
  });

  it("readiness resolves when the store answers a query", async () => {
    await expect(controller.ready()).resolves.toEqual({ status: "ready" });
  });

  it("readiness 503s when the store's query rejects (proves the probe hits the backend)", async () => {
    // A store whose point lookup rejects — the OLD probe (`roomsInCells([])`) would have resolved
    // anyway (both stores short-circuit an empty cell list); the fixed probe must surface the failure.
    const unreachable = {
      getRoom: () => Promise.reject(new Error("pool down")),
    } as unknown as Store;
    const ctrl = new HealthController(unreachable);
    await expect(ctrl.ready()).rejects.toBeInstanceOf(HttpException);
    await ctrl.ready().catch((err: HttpException) => expect(err.getStatus()).toBe(503));
  });
});
