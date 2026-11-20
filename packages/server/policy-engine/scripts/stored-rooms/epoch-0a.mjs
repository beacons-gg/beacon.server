// Epoch 0a, 7c2db87 (2026-08-17), on the challenges branch before it merged: a challenge's phases were
// active -> ended -> won, one grant rule paid on a won-gated `claim`, and progress keys were bare
// event names. The engine was epoch A's: a flat `granted` ledger, no `settledAt`.
import { harness, organizerRewardPool } from "./common.mjs";

const [root, out] = process.argv.slice(2);
const h = harness(root, "2026-08-17T12:00:00Z", "7c2db87");
const { game, clock, op, place, progress, save } = h;

// CreateChallengeScreen.tsx: the escrow, the frozen policy, then the organizer joins as member one.
async function challenge(unique) {
  const policy = game.challengePolicy({
    tasks: [{ event: "capsule.finished", target: 2 }],
    deadlineSec: Math.floor(clock.ms / 1000) + 7 * 86_400,
    maxContributors: 2,
    rewardsPerMember: 1,
  });
  const id = await place({
    unique,
    type: "challenge",
    policy,
    name: "Market loop",
    state: { contents: [], [policy.grant.from]: organizerRewardPool(h, 2) },
  });
  await op("alice", id, "contribute", { resource: progress("alice") });
  await op("bob", id, "contribute", { resource: progress("bob") });
  return id;
}

const won = await challenge("01K2S00000000000000CHAW000");
await op("alice", won, "contribute", { resource: progress("alice", { "capsule.finished": 2 }) });
clock.ms += 60_000;
await h.engine.advancePhase(won);
await op("bob", won, "claim");
await save(
  won,
  `${out}/kites-challenge.2026-08-17.won.json`,
  "A one-step stage-3 challenge, won on the spot: Alice finished both capsules, the next tick jumped it through `ended` to `won`, and Bob claimed. Alice has not claimed.",
);

clock.ms = Date.parse("2026-08-17T12:00:00Z");
const lost = await challenge("01K2S00000000000000CHAL000");
await op("alice", lost, "contribute", { resource: progress("alice", { "capsule.finished": 1 }) });
clock.ms += 7 * 86_400_000 + 3_600_000; // an hour past the deadline
await h.engine.advancePhase(lost);
await save(
  lost,
  `${out}/kites-challenge.2026-08-17.lost.json`,
  "A one-step stage-3 challenge that ran out of time one capsule short. It sits in `ended`, which is not its last phase: its `unlockAt` is the deficit times a billion seconds past the deadline.",
);
