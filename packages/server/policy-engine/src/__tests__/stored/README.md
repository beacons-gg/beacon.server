# Stored rooms, frozen

These are whole rooms that earlier builds put in custody, saved as their store held them. Every
engine change runs against the policies and the state that are already out there.
`stored-rooms.test.ts` loads each one the way a database read does and plays it forward.

A store hands a room back as it wrote it and doesn't validate it. Postgres `jsonb` only reorders the
keys, and the suite applies that order on load. What a stored room depends on is checked only at
place time. So these files catch what nothing else would:

- a ceiling lowered under a stored `max`;
- a JSONLogic operator that a stored formula uses;
- a legacy reader removed;
- a close rule that reads state an older engine never wrote.

**Add, never rewrite.** When the builders or the engine start writing a different shape, generate a
new dated file beside the old ones. `shipped/` is the other half: today's policies, placed fresh.
The files carry the name of an example game, `kites`.

## How the files were made

Each file came from the builders **and** the engine of the commit in its `$fixture.commit`. The
commits are in the repository this code was split from, where the game's builders sat beside the
engine. A script in `scripts/stored-rooms/` drove a built checkout of that commit through the calls
the app made then. `$fixture.story` says what happened to the room. `$fixture.clock` is when the
room was saved.

The members are the fixed recovery phrases in `scripts/stored-rooms/common.mjs`. Those are BIP39's
published test phrases, so a test can sign as the players the room already knows. Alice placed
every room.

| Epoch | Commit    | Date       | What its rooms carry                                                                      |
| ----- | --------- | ---------- | ----------------------------------------------------------------------------------------- |
| 0a    | `7c2db87` | 2026-08-17 | a challenge in phases `active` then `ended` then `won`, paid by one rule on a `won` claim |
| 0b    | `a436570` | 2026-08-18 | a claim-paid ladder whose rungs are `when`-gated grant rules on a `settled` claim         |
| A     | `885c4fb` | 2026-08-18 | one grant rule and a flat `granted` ledger with a 7-day `claimTtl` and no `settledAt`     |
| B     | `cdabc32` | 2026-08-25 | several grant rules and a `granted` ledger per pool, with a rung that can pay a scanner   |
| C     | `fd27c84` | 2026-09-14 | `ops.react.max` and a reaction ledger on both builders                                    |
| D     | `4a214bd` | 2026-09-23 | a 30-day `claimTtl` and a close scheduled from `settledAt` as well as checked by it       |

Epochs 0a and 0b keep bare event keys. Epochs A and B have no reactions yet.

Epochs 0a and 0b are commits on the challenges branch before it merged. That branch went to playtest
builds. The game still keeps readers for both generations, so rooms of both are treated as in
custody.

`settledAt` is stamped once the challenges branch merged (`20780c0`). From then on the close has
measured the claim window from that time. So the rooms from before that merge are the ones that
still run their window from `unlockAt`.

A lost epoch-0a challenge parks in `ended`, which is not its last phase. The challenge waits there on
a `won` decades away. The transition horizon closes such a room a claim window after its deadline
(see the policy-engine README).

| File                                       | Epoch | The room                                                                           |
| ------------------------------------------ | ----- | ---------------------------------------------------------------------------------- |
| `kites-challenge.2026-08-17.won.json`      | 0a    | a one-step challenge that was won. Bob claimed and Alice has not.                  |
| `kites-challenge.2026-08-17.lost.json`     | 0a    | a one-step challenge one capsule short at its deadline and parked in `ended`       |
| `kites-challenge.2026-08-18.claiming.json` | 0b    | a two-step ladder settled with step 2 short. Alice claimed and Bob has not.        |
| `kites-capsule.2026-08-18.claiming.json`   | A     | an unlocked medium reward capsule. Alice claimed and Bob has not.                  |
| `kites-jar.2026-08-18.json`                | A     | a 10-slot jar with one memory left                                                 |
| `kites-challenge.2026-08-25.running.json`  | B     | a mapped two-step challenge that pays a scanner at step 2. Alice collected step 1. |
| `kites-capsule.2026-09-14.locked.json`     | C     | a sealed medium reward capsule with a photo and one reaction from each member      |
| `kites-challenge.2026-09-14.settled.json`  | C     | an unmapped two-step challenge settled with step 2 short. Bob and Carol played.    |
| `kites-challenge.2026-09-23.won.json`      | D     | a mapped two-step challenge won early. Alice collected and Bob has not.            |

## Why no engine stamp

A room could carry `engine: <n>` from placement, so a later engine could branch on the number. The
engine doesn't stamp one. Every room already in custody lacks the stamp. So readers must tell
generations apart by shape anyway, and the shape tests the engine already uses say exactly what
differs where a counter would not: `Array.isArray` on a `granted` entry and `typeof settledAt`. The
other use is a rollback that refuses rooms newer than itself. That use needs builds that already
read the field. Revisit the stamp when a change can't be told apart by shape.

## Regenerate an epoch, or add one

The output is reproducible. The scripts pin the wall clock and the random source the builders mint
ids from, so regenerating an epoch rewrites its files byte for byte. A new epoch starts from a copy
of the nearest script and only adds files. Existing files must come back unchanged.

The scripts need a built checkout of the repository the commits are in. Put it in a sibling
directory.
Don't put it under `/tmp`: a tmpfs can't hardlink the pnpm store, so every install copies the whole
store. Run this from the repository root:

```sh
git worktree add --detach ../at-885c4fb 885c4fb
(cd ../at-885c4fb && pnpm install --frozen-lockfile \
  && pnpm exec turbo run build --filter=<game-package>... --filter=@beaconsgg/policy-engine...)
```

`<game-package>` is the name of the game's builder package in that checkout. `<game-dir>` below is
that package's directory, relative to the checkout's root.

Then regenerate in place from this package and format:

```sh
GAME_DIR=<game-dir> node scripts/stored-rooms/epoch-a.mjs ../../../../at-885c4fb src/__tests__/stored
pnpm exec prettier --write src/__tests__/stored
git diff --exit-code src/__tests__/stored
```

The last command fails when an existing file changed. The scripts read the game's builders from the
checkout they are given. This package doesn't depend on the game.
