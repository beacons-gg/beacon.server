// Epoch 0b, a436570 (2026-08-18), later on the challenges branch, still before it merged: a challenge is a ladder of steps, each
// rung a `when`-gated grant rule paid on a settled-gated `claim`, one pool per step, bare event
// keys. No `settledAt` yet.
import { harness, organizerRewardPool } from "./common.mjs";

const [root, out] = process.argv.slice(2);
const h = harness(root, "2026-08-18T12:00:00Z", "a436570");
const { game, clock, op, place, progress, save } = h;

// CreateChallengeScreen.tsx: one pool per step, the ladder policy, then the organizer joins.
const policy = game.challengePolicy({
  steps: [
    { tasks: [{ event: "capsule.finished", target: 2 }], rewardsPerMember: 1 },
    { tasks: [{ event: "jar.placed", target: 3 }], rewardsPerMember: 1 },
  ],
  deadlineSec: Math.floor(clock.ms / 1000) + 7 * 86_400,
  maxContributors: 2,
});
const id = await place({
  unique: "01K2T00000000000000CHA0000",
  type: "challenge",
  policy,
  name: "Market loop",
  state: {
    contents: [],
    [game.challengeStepPool(1)]: organizerRewardPool(h, 2),
    [game.challengeStepPool(2)]: organizerRewardPool(h, 2),
  },
});
await op("alice", id, "contribute", { resource: progress("alice") });
await op("bob", id, "contribute", { resource: progress("bob") });
await op("alice", id, "contribute", { resource: progress("alice", { "capsule.finished": 2 }) });
await op("bob", id, "contribute", { resource: progress("bob", { "jar.placed": 1 }) });
clock.ms += 7 * 86_400_000 + 3_600_000; // an hour past the deadline
await h.engine.advancePhase(id);
await op("alice", id, "claim");
await save(
  id,
  `${out}/kites-challenge.2026-08-18.claiming.json`,
  "A two-step claim-paid ladder, settled at its deadline with step 2 two jars short. Alice claimed (step 1's reward and her own claims); Bob has not.",
);
