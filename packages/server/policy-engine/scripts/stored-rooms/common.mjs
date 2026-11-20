// The shared harness behind the stored-room fixtures: drive the builders AND the engine of a
// historical checkout, then save the room its store holds. Each `epoch-*.mjs` calls this with the
// root of a checkout at its commit, installed and built (`pnpm install`, then `turbo run build`
// over the game package and `@beaconsgg/policy-engine`). The checkouts are of the repository this
// code was split from, where the game's builders sat beside the engine. Not part of any build.
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

/** BIP39's published test phrases, so the suite can sign as the members a room already knows. */
const MNEMONICS = {
  alice:
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  bob: "legal winner thank year wave sausage worth useful legal winner thank yellow",
  carol: "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
};

const HOST = "beacon.example";
const LOCATION = { lat: 47.61, lng: -122.34 };

export function harness(checkout, startIso, commit) {
  const root = path.resolve(checkout); // `require` would read a relative path from this file, not the cwd
  // The game's builder package lives outside this repository, so its directory in the checkout is
  // named at run time (the stored fixtures' README shows how).
  const gameDir = process.env.GAME_DIR;
  if (!gameDir) throw new Error("GAME_DIR must name the game's builder package in the checkout");
  const clock = { ms: Date.parse(startIso) };
  // Reproducible output: what the builders mint reads the wall clock (`mintedAt`, the ulid time) and
  // crypto.randomBytes (the ulid tail), so both are pinned, to the fixture clock and to a seeded
  // stream. A re-run writes the same bytes, dated when the fixture says it happened.
  let seed = 0x9e3779b9;
  crypto.randomBytes = (size) =>
    Buffer.from(
      Array.from({ length: size }, () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed >>> 24;
      }),
    );
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length > 0 ? args : [clock.ms]));
    }
    static now() {
      return clock.ms;
    }
  };

  const engineMod = require(path.join(root, "packages/server/policy-engine/dist/index.js"));
  const identity = require(path.join(root, "packages/core/identity/dist/index.js"));
  const game = require(path.join(root, gameDir, "dist/index.js"));

  // Older builds export the store from the main entry; later ones only from `./testing`.
  const { InMemoryStore } = engineMod.InMemoryStore
    ? engineMod
    : require(path.join(root, "packages/server/policy-engine/dist/testing.js"));
  const engine = new engineMod.PolicyEngine(new InMemoryStore(), {
    now: () => clock.ms,
    replayWindowMs: Number.MAX_SAFE_INTEGER,
  });
  const wallets = Object.fromEntries(
    Object.entries(MNEMONICS).map(([k, m]) => [k, identity.walletFromMnemonic(m)]),
  );
  const minter = (who) => identity.walletMinter(wallets[who]);
  // An older build signs a resource with identity's own wrapper; a later one through the item pair
  // over the game's `resourceItemBirth`. Both sign the same bytes.
  const signResourceAs = (m) => (r) =>
    identity.signResourceProvenance
      ? identity.signResourceProvenance(r, m)
      : identity.signItemProvenance(game.resourceItemBirth(r), m);
  const signResource = (who) => signResourceAs(minter(who));

  let n = 0;
  const counter = () => String(++n).padStart(22, "0");

  /** Place through `engine.place` as Alice, with the state the server's place handler built then. */
  async function place({ unique, type, policy, name, media, state }) {
    const mintedBy = identity.signRoomProvenance({ unique, kind: type, policy }, minter("alice"));
    const placed = await engine.place(
      {
        id: `${unique}@${HOST}`,
        type,
        location: LOCATION,
        policy,
        placedBy: wallets.alice.account.did,
        mintedBy,
        ...(name !== undefined ? { name } : {}),
        ...(media !== undefined ? { media } : {}),
        state,
        live: `https://${HOST}`,
      },
      `0000${counter()}`,
    );
    return placed.id;
  }

  async function op(who, room, name, params = {}) {
    const env = identity.signOpWithWallet(wallets[who], {
      op: name,
      room,
      nonce: `0000${counter()}`,
      issuedAt: new Date(clock.ms).toISOString(),
      params,
    });
    const applied = await engine.applyOp(env);
    if (!applied.result.ok) throw new Error(`${who} ${name}: ${JSON.stringify(applied.result)}`);
    return applied.result;
  }

  /** A player's memory, as the app mints one (`mintRewardItem` stamps the found-at place). */
  const memory = (who, levels) =>
    game.mintRewardItem(
      { class: "MemoryFragment", baseLevels: levels, tags: { source: ["places"] } },
      { location: LOCATION, owner: wallets[who].account.did, signResource: signResource(who) },
    );

  /** A join (no counters) or a progress report: a `ChallengeProgress` claim, signed by its player. */
  const progress = (who, counters = {}) =>
    game.buildProgressClaim(`01K3${counter()}`, counters, (item) =>
      identity.signItemProvenance(item, minter(who)),
    );

  async function save(room, file, story) {
    const stored = await engine.resolveRoom(room);
    if (!stored) throw new Error(`${room} is gone`);
    const $fixture = {
      commit,
      story,
      actors: Object.fromEntries(Object.entries(wallets).map(([k, w]) => [k, w.account.did])),
      clock: new Date(clock.ms).toISOString(),
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ $fixture, room: stored }, null, 2) + "\n");
    console.log("wrote", file, "version", stored.version, "phase", stored.state.phase);
  }

  return {
    engine,
    identity,
    game,
    clock,
    wallets,
    place,
    op,
    save,
    minter,
    signResource,
    signResourceAs,
    memory,
    progress,
    LOCATION,
  };
}

/**
 * A medium reward capsule the way the capsule scanner placed one (placeCapsule.ts fed by
 * assembleScanResult.ts): a drawn size over the default unlock transform, the default reward grant,
 * the Store's six spots (`CAPSULE_CONTRIBUTORS` in catalog.ts), a reward pool with one per spot, the
 * finder's own memory seeded as her contribution, and the harvest's name (and media, when it has one)
 * on the room and its rewards. rooms.service.ts seeded the pool under the (first) grant rule's `from`.
 */
export async function placeCapsule(h, { unique, media }) {
  const { game, wallets, LOCATION } = h;
  const reward = {
    class: "MemoryFragment",
    baseLevels: { procedural: 3, semantic: 3, episodic: 3 },
    tags: { source: ["places"] },
    name: "Pike Place",
    ...(media !== undefined ? { media } : {}),
  };
  const mint = {
    location: LOCATION,
    owner: wallets.alice.account.did,
    signResource: h.signResource("alice"),
  };
  const pool = game.mintRewardPool(reward, { count: 6, ...mint });
  const seed = game.mintRewardItem(reward, mint);
  const policy = game.capsulePolicy({
    unlockTransform: game.DEFAULT_UNLOCK_TRANSFORM,
    ...game.capsuleSizeOptions(game.CAPSULE_SIZES.find((s) => s.id === "medium")),
    maxContributors: 6,
    grant: game.DEFAULT_REWARD_GRANT,
  });
  const first = Array.isArray(policy.grant) ? policy.grant[0] : policy.grant;
  const id = await h.place({
    unique,
    type: "capsule",
    policy,
    name: "Pike Place",
    ...(media !== undefined ? { media } : {}),
    state: { contents: [seed], [first.from]: pool },
  });
  return { id, seed };
}

/**
 * A two-step challenge through `challengePlacement`, the way the phone (`mapped`) or the admin
 * console (not) assembled one once the challenges branch merged: `capsule.finished` x2, then
 * `jar.placed` x3, two spots. `step2` is step 2's reward, a memory unless given. rooms.service.ts
 * spread `initialPools` into state.
 */
export async function placeChallenge(h, { unique, mapped, deadlineIso, step2 }) {
  const { game, identity } = h;
  const alice = h.minter("alice");
  // Both the phone's forge and the console author a memory reward through `authoredRewardSpec`.
  const memoryReward = (n) =>
    game.memoryReward(
      game.authoredRewardSpec({ name: `Market prize ${n}`, description: `Step ${n} reward` }),
    );
  const container = game.challengePlacement(
    {
      unique,
      name: "Market loop",
      spots: 2,
      deadlineSec: Math.floor(Date.parse(deadlineIso) / 1000),
      owner: h.wallets.alice.account.did,
      steps: [
        { tasks: [{ event: "capsule.finished", target: 2 }], rewards: [memoryReward(1)] },
        { tasks: [{ event: "jar.placed", target: 3 }], rewards: [step2 ?? memoryReward(2)] },
      ],
      mapped,
    },
    {
      signResource: h.signResourceAs(alice),
      signItem: (item) => identity.signItemProvenance(item, alice),
      signContainer: (c) => identity.signRoomProvenance(c, alice),
    },
  );
  const id = await h.place({
    unique,
    type: "challenge",
    policy: container.policy,
    name: container.label,
    state: { contents: [], ...container.initialPools },
  });
  return { id, key: game.stepEventKey };
}

/** The pre-merge create screen's rewards: a copy of one of the organizer's memories per spot. */
export function organizerRewardPool(h, spots) {
  const { game, wallets, LOCATION } = h;
  const source = game.mintResource(wallets.alice.account.did, {
    tags: { source: ["places"] },
    name: "Rainier at dusk",
    description: "From the ferry",
  });
  return game.mintRewardPool(game.rewardCopySpec(source), {
    count: spots,
    location: LOCATION,
    owner: wallets.alice.account.did,
    signResource: h.signResource("alice"),
  });
}
