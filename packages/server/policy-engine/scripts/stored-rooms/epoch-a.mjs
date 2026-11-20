// Epoch A, 885c4fb (2026-08-18), main before the challenges branch merged: one grant rule per
// policy, a flat `granted` ledger, claimTtl 7d, no reactions, and no `settledAt` (first stamped by
// 20780c0).
import { harness, placeCapsule } from "./common.mjs";

const [root, out] = process.argv.slice(2);
const h = harness(root, "2026-08-18T12:00:00Z", "885c4fb");
const { game, clock, memory, op, place, save } = h;

const capsule = await placeCapsule(h, { unique: "01K2Z00000000000000CAPA000" });
await op("bob", capsule.id, "contribute", {
  resource: memory("bob", { procedural: 5, semantic: 2, episodic: 1 }),
});
clock.ms += 2 * 86_400_000; // past both windows
await h.engine.advancePhase(capsule.id);
await op("alice", capsule.id, "claim");
await save(
  capsule.id,
  `${out}/kites-capsule.2026-08-18.claiming.json`,
  "A six-spot medium reward capsule (one grant rule, claimTtl 7d). Alice placed it with her own seeded memory, Bob contributed one, it unlocked, and Alice claimed: `claimed` holds Alice and `granted` is the legacy flat shape. Bob has not claimed. Stored before `settledAt` existed.",
);

// The Store's 10-slot jar (catalog.ts), minted into inventory with its scanner label and placed empty;
// the inventory placement carries the label onto the room's name.
clock.ms = Date.parse("2026-08-18T12:00:00Z");
const jar = await place({
  unique: "01K2Z00000000000000JAR0A00",
  type: "jar",
  policy: game.jarPolicy({ capacity: 10 }),
  name: "Jar · holds 10",
  state: { contents: [] },
});
const first = memory("alice", { procedural: 2, semantic: 4, episodic: 1 });
await op("alice", jar, "add", { resource: first });
await op("alice", jar, "add", {
  resource: memory("alice", { procedural: 1, semantic: 1, episodic: 6 }),
});
await op("bob", jar, "take", { item: first.unique });
await save(
  jar,
  `${out}/kites-jar.2026-08-18.json`,
  "A 10-slot jar. Alice added two memories and Bob took the first; one is left.",
);
