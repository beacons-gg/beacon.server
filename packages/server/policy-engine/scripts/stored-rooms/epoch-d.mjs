// Epoch D, 4a214bd (2026-09-23): claimTtl 30d, and the close is scheduled from `settledAt` as well
// as checked against it.
import { harness, placeChallenge } from "./common.mjs";

const [root, out] = process.argv.slice(2);
const h = harness(root, "2026-09-23T12:00:00Z", "4a214bd");
const { clock, op, progress, save } = h;

const c = await placeChallenge(h, {
  unique: "01K6D00000000000000CHA0000",
  mapped: true,
  deadlineIso: "2026-10-07T12:00:00Z",
});
await op("alice", c.id, "contribute", { resource: progress("alice") });
await op("bob", c.id, "contribute", { resource: progress("bob") });
await op("alice", c.id, "contribute", {
  resource: progress("alice", { [c.key(1, "capsule.finished")]: 2 }),
});
await op("bob", c.id, "contribute", { resource: progress("bob", { [c.key(2, "jar.placed")]: 3 }) });
clock.ms += 60_000; // the next tick settles the won ladder
await h.engine.advancePhase(c.id);
await op("alice", c.id, "collect");
await save(
  c.id,
  `${out}/kites-challenge.2026-09-23.won.json`,
  "A two-step challenge placed from the phone (mapped), won a fortnight early: Alice finished step 1, Bob step 2, and it settled on the next tick with `settledAt` stamped. Alice collected both rewards; Bob has collected nothing.",
);
