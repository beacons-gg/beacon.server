import type { DidKey, ScoutReportParams, ScoutSummary } from "@beaconsgg/protocol-types";
import { ScoutRelay, type ReportStamp } from "@beaconsgg/server-runtime";
import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { RoomsGateway } from "../rooms/rooms.gateway";

/** How often to age out expired scout reports. */
const SWEEP_MS = 5000;

/**
 * NestJS shell around the framework-agnostic {@link ScoutRelay} (`@beaconsgg/server-runtime`): it
 * bridges the relay's broadcast to the socket.io gateway and drives expiry on an interval. All the
 * relay logic (dedup, freshness, TTL bound, FIFO cap, interpolated-cell discovery) lives in the
 * package, so any host can reuse it unchanged.
 */
@Injectable()
export class ScoutsService implements OnModuleInit, OnModuleDestroy {
  private readonly relay: ScoutRelay;
  private sweepHandle: ReturnType<typeof setInterval> | undefined;

  constructor(gateway: RoomsGateway) {
    this.relay = new ScoutRelay({
      broadcast: (delta, games) => gateway.broadcastMap(delta, games),
    });
  }

  onModuleInit(): void {
    this.sweepHandle = setInterval(() => this.relay.sweepExpired(Date.now()), SWEEP_MS);
    this.sweepHandle.unref?.();
  }
  onModuleDestroy(): void {
    if (this.sweepHandle) clearInterval(this.sweepHandle);
  }

  report(
    owner: DidKey,
    params: ScoutReportParams,
    stamp: ReportStamp,
    game?: string | undefined,
  ): { ok: boolean; error?: string } {
    return this.relay.report(owner, params, stamp, game);
  }

  cancel(owner: DidKey, unique: string): { ok: boolean; error?: string } {
    return this.relay.cancel(owner, unique);
  }

  scoutsInView(cells: string[], nowMs: number, games?: readonly string[]): ScoutSummary[] {
    return this.relay.scoutsInView(cells, nowMs, games);
  }
}
