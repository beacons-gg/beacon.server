// Epoch C, fd27c84 (2026-09-14): reactions, with `ops.react.max`, on both builders; claimTtl 7d.
import { harness, placeCapsule, placeChallenge } from "./common.mjs";

const [root, out] = process.argv.slice(2);
const h = harness(root, "2026-09-14T12:00:00Z", "fd27c84");
const { clock, memory, op, progress, save } = h;

const hash = "q7k3Xy2mZ0fR8tV1bN4cW6dH9sL5pA0eJ3uG7oI2xYw";
const media = [{ type: "image", role: "full", hash, uris: [`${hash}@beacon.example`] }];
const capsule = await placeCapsule(h, { unique: "01K5C00000000000000CAPC000", media });
const bobs = memory("bob", { procedural: 5, semantic: 2, episodic: 1 });
await op("bob", capsule.id, "contribute", { resource: bobs });
await op("alice", capsule.id, "react", { target: bobs.unique, kind: "love" });
await op("bob", capsule.id, "react", { target: capsule.seed.unique, kind: "clap" });
const sealed = await h.engine.resolveRoom(capsule.id);
clock.ms = (sealed.state.lockAt + 60) * 1000; // sealed, not yet open
await h.engine.advancePhase(capsule.id);
await save(
  capsule.id,
  `${out}/kites-capsule.2026-09-14.locked.json`,
  "A six-spot medium reward capsule with reactions (`ops.react.max`) and a photo on the room and its rewards. Alice placed it with her seeded memory, Bob contributed one, each reacted to the other's, and it has locked. Nobody can claim yet.",
);

// apps/admin/features/challenges/api.ts: the operator places it and joins nobody; players join.
clock.ms = Date.parse("2026-09-14T12:00:00Z");
const c = await placeChallenge(h, {
  unique: "01K5C00000000000000CHA0000",
  mapped: false,
  deadlineIso: "2026-09-21T12:00:00Z",
});
await op("bob", c.id, "contribute", { resource: progress("bob") });
await op("carol", c.id, "contribute", { resource: progress("carol") });
await op("bob", c.id, "contribute", {
  resource: progress("bob", { [c.key(1, "capsule.finished")]: 2 }),
});
await op("bob", c.id, "collect");
await op("carol", c.id, "contribute", {
  resource: progress("carol", { [c.key(2, "jar.placed")]: 2 }),
});
clock.ms = Date.parse("2026-09-21T13:00:00Z"); // an hour past the deadline
await h.engine.advancePhase(c.id);
await save(
  c.id,
  `${out}/kites-challenge.2026-09-14.settled.json`,
  "A two-step challenge from the admin console (unmapped), settled at its deadline with step 2 one jar short. Alice (the operator) never joined; Bob and Carol did. Bob collected step 1's reward; Carol has not collected. Its claim window is the 7 days it was placed with.",
);
