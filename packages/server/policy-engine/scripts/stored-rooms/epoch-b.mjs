// Epoch B, cdabc32 (2026-08-25): a challenge can pay a scanner. Several grant rules and a per-pool
// `granted` (since the challenges branch merged), step-namespaced event keys, no `ops.react` yet,
// claimTtl 7d.
import { harness, placeChallenge } from "./common.mjs";

const [root, out] = process.argv.slice(2);
const h = harness(root, "2026-08-25T12:00:00Z", "cdabc32");
const { game, op, progress, save } = h;

// placeChallenge.ts, then the organizer's join (useScanner.ts).
const c = await placeChallenge(h, {
  unique: "01K3B00000000000000CHA0000",
  mapped: true,
  deadlineIso: "2026-09-08T12:00:00Z",
  step2: game.scannerReward("capsule-explorers"),
});
await op("alice", c.id, "contribute", { resource: progress("alice") });
await op("bob", c.id, "contribute", { resource: progress("bob") });
await op("alice", c.id, "contribute", {
  resource: progress("alice", { [c.key(1, "capsule.finished")]: 2 }),
});
await op("alice", c.id, "collect");
await op("bob", c.id, "contribute", { resource: progress("bob", { [c.key(2, "jar.placed")]: 1 }) });
await save(
  c.id,
  `${out}/kites-challenge.2026-08-25.running.json`,
  "A two-step challenge placed from the phone (mapped), still running. Step 2 pays a scanner. Alice and Bob joined; Alice finished step 1 and collected its reward; Bob has placed one of step 2's three jars. Its policy has no `react` op.",
);
