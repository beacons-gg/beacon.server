# Shipped policies, frozen

These are policies a game has shipped, saved as the JSON its builders wrote. The engine's suites
keep running the real shapes without importing the game. `shipped-policies.test.ts` places and plays
each one. The files carry the name of an example game, `kites`.

**Add, never rewrite.** A placed room keeps the policy it was signed with. A shape stays worth
running for as long as rooms placed with it can exist. When a builder changes what it writes, add a
new dated file beside the old one.

Each file is one configuration of what the builders wrote on the date in its name. Older rooms
differ in ways these files don't cover:

- a 7-day `claimTtl`;
- one grant rule and a flat `granted` ledger;
- bare event keys and claim-paid rungs on early challenges;
- no `ops.react` before reactions.

`stored/` runs those as whole stored rooms.

The files came from the game's builders at commit `e9283cd` of the repository this code was split
from. Each one used the call the game's app made:

| File                                          | The policy                                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `kites-jar.2026-09-23.json`                   | a bag that holds 12 items                                                                 |
| `kites-capsule-medium.2026-09-23.json`        | a medium timed room for up to 4 contributors with the default unlock transform and grant  |
| `kites-challenge.2026-09-23.json`             | a mapped two-step challenge for 2 players with one reward per step and a 2030 deadline    |
| `kites-capsule-medium-tagged.2026-09-23.json` | the medium timed room for up to 3 contributors that admits only items tagged `color`      |
| `kites-challenge-unmapped.2026-09-23.json`    | the challenge with `mapped: false` (the operator's toggle), so its live phase is `active` |

The challenge's two steps are `capsule.finished` twice and then `jar.placed` three times. The tagged
room's `accept` is `{ tags: { color: [] } }`. The mapped challenge's live phase is `open`.
