/** The request slice the rate limiters read to key a client — avoids an `@types/express` dependency. */
export interface ClientKeyRequest {
  ip?: string;
  socket?: { remoteAddress?: string | undefined };
}

/**
 * Client key = the framework-resolved client IP, shared by the write ({@link WriteRateLimitGuard}) and
 * read ({@link ReadRateLimitGuard}) rate limiters so the anti-spoofing invariant lives in one place.
 *
 * `req.ip` honors the configured `trust proxy` hop count (see `main.ts` / `BEACON_TRUST_PROXY`), so
 * behind a correctly-configured proxy it's the real client and **not** the spoofable leftmost
 * `X-Forwarded-For` — never read that raw header here, or a limiter can be bypassed by rotating it.
 * Falls back to the socket peer.
 */
export function clientKey(req: ClientKeyRequest): string {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

/**
 * How {@link clientKey} will resolve, in one phrase, for the boot log. Lives here rather than in the
 * shell because it restates *this* function's contract, and an operator reading
 * `clientKey=socket-peer` on a deployment that has an ingress is looking at the misconfiguration
 * described in `doc/deploy.md`: every limiter would key on the balancer, so one key covers the whole
 * player base.
 *
 * Takes the **raw** env string as well as the parsed value, because `parseTrustProxy` folds five
 * distinct inputs to `false` (unset, empty, `0`, `false`, and anything it could not parse). Telling
 * an operator who wrote `BEACON_TRUST_PROXY=yes` that the variable is unset is the reading most
 * likely to be dismissed out of hand, and a typo is the harder of the two cases to notice: someone
 * who never set it at least knows they never set it.
 */
export function describeClientKey(trustProxy: boolean | number, raw?: string): string {
  if (trustProxy !== false) return `x-forwarded-for (trust ${String(trustProxy)})`;
  const value = raw?.trim();
  if (value === undefined || value === "") return "socket-peer (BEACON_TRUST_PROXY unset)";
  if (["0", "false"].includes(value.toLowerCase())) {
    return `socket-peer (BEACON_TRUST_PROXY=${value})`;
  }
  return `socket-peer (BEACON_TRUST_PROXY=${JSON.stringify(value)} NOT UNDERSTOOD)`;
}
