import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { ServerConfig } from "../config";
import { SERVER_CONFIG } from "../settings/live-config";
import { writeLocked } from "./capability-http";

/** Methods that change nothing here, so a locked server keeps answering them. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** A lock lasts minutes, not milliseconds; one minute is a sensible first wait for a retrying caller. */
const RETRY_AFTER_SECONDS = 60;

export const ALLOW_WHILE_LOCKED = "beacon:allowWhileLocked";

/**
 * Let a write through while the server is locked read-only (doc/deploy.md, "Read-only lock").
 *
 * Handler-level only, so a controller cannot opt in wholesale and carry a route added later along
 * with it. Keep this to what the operator needs to see and end a lock: the guard's whole value is
 * that a route nobody thought about stays refused.
 */
export const AllowWhileLocked = (): MethodDecorator => SetMetadata(ALLOW_WHILE_LOCKED, true);

/** The slice of the Express request and response the guard reads and writes. */
interface LockedRequest {
  method?: string;
}
interface LockedResponse {
  setHeader(name: string, value: string): void;
}

/**
 * Refuses every HTTP write while `writeLocked` is on, so nothing changes under a final backup.
 *
 * **Default deny.** Every non-read route is refused unless its handler carries
 * {@link AllowWhileLocked}: an allowlist fails closed, where a list of routes to refuse would miss
 * every route added after it. That is also why signed reads are refused along with the writes. They
 * ride a POST (`admin/media/list`, `mailbox/fetch`) and each records a nonce, so telling them apart
 * would rest on a list again.
 *
 * Global, ahead of every route guard, and read from the live config per request, so the lock takes
 * effect on the next request and lifts the same way. Socket gateways pass: that channel carries
 * server-to-client events and subscriptions only, never a write (`rooms.gateway.ts`).
 *
 * A `503` needs no new code from a client, because the SDK treats any 5xx as a retryable
 * `ServerError` before reading the body. The `error` string is for a person reading a response, so
 * it is deliberately not one of the protocol's `ERROR_CODES` and needs no fallback.
 */
@Injectable()
export class WriteLockGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SERVER_CONFIG) private readonly config: Pick<ServerConfig, "writeLocked">,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== "http") return true;
    if (!this.config.writeLocked) return true;

    const http = context.switchToHttp();
    if (READ_METHODS.has(http.getRequest<LockedRequest>().method ?? "")) return true;
    if (this.reflector.get<boolean>(ALLOW_WHILE_LOCKED, context.getHandler())) return true;

    http.getResponse<LockedResponse>().setHeader("Retry-After", String(RETRY_AFTER_SECONDS));
    writeLocked();
  }
}
