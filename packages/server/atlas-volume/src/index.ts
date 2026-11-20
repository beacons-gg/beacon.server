// @beaconsgg/atlas-volume — [S] server-only, and operator-side too.
//
// The published Atlas volume format: the contract between Cartographer's publisher and every consumer.
// It is a package rather than a file in either app because the format has two implementors that must
// agree byte for byte, an app never imports an app, and a published version's bytes never change.
//
// Holds no builder logic and no reader logic — only what both sides read: the shapes, the layout, the
// hash spelling, the signature check, and the consumer's sourceId derivation.

export * from "./format";
export * from "./source-id";
export * from "./trust";
export * from "./reader";
export * from "./archive";
