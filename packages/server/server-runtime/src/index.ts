// @beaconsgg/server-runtime — [S] server-only
// Reusable server runtime infrastructure, framework-agnostic so the NestJS/transport shells stay
// throwaway: the lifecycle timer-wheel scheduler, the per-key mutex (per-room serialization), and
// the scout relay (owner-authoritative advertisements the server caches but never custodies).

export * from "./scheduler";
export * from "./mutex";
export * from "./scout-relay";
