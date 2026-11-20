// @beaconsgg/policy-engine — [S] server-only (Node OK)
// The generic op + policy + lifecycle engine over declarative rooms, behind a Store
// interface. Enforces consistency only (ordering, capacity, atomic handoff, idempotency);
// never gameplay claims (radical trust).

export * from "./store";
export * from "./roles";
export * from "./handlers";
// Policy *builders* are NOT exported here: they live in each game's own package (shared with its
// client). The engine only interprets the declarative policy data; it never builds it.
export * from "./lifecycle";
export * from "./policy-rules";
export * from "./engine";
export * from "./markers";
