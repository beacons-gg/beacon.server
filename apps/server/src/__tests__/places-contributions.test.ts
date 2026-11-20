import { createWallet } from "@beaconsgg/identity";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { CONTRIB_SOURCE } from "../places/merge";
import type { MediaPresence } from "../places/contributions.service";
import {
  makePlace,
  makeSource,
  placesHarness,
  signedEnv,
  rejectedWith,
  statusOf,
  type TestWallet,
  TEST_GAME,
} from "./test-helpers";

/**
 * Player contributions (`doc/spec/place-proposals.md` §5 and §6): a signed DID proposes a place, an
 * operator decides, and **nothing reaches a read path in between**.
 */

const U1 = "01AAAAAAAAAAAAAAAAAAAAAAAA";
const POINT = { lat: 47.61, lng: -122.33 };
const NEW_TARGET = {
  kind: "new",
  category: "park",
  subcategory: "play",
  point: POINT,
  name: "Pocket Park",
  description: "A bench, three trees, and a very good view of the ferries.",
  // Required since 0021: a submission states the terms it may travel under. CC0 because these
  // fixtures mostly submit uncredited, and the wire refuses CC-BY without `credit`.
  license: "CC0-1.0",
};

const proposeEnv = (
  w: TestWallet,
  params: Record<string, unknown>,
  nonce?: string,
  game: string | null = TEST_GAME,
) => signedEnv(w, "places.propose", params, nonce, game);
const fetchEnv = (w: TestWallet, params: Record<string, unknown> = {}, nonce?: string) =>
  signedEnv(w, "places.proposals.fetch", params, nonce);
const reviewEnv = (w: TestWallet, params: Record<string, unknown>, nonce?: string) =>
  signedEnv(w, "places.proposals.review", params, nonce);

/** A media double that knows exactly one hash — enough to exercise both sides of the check. */
const mediaWith = (...hashes: string[]): MediaPresence => ({
  lookupIngested: (hash) =>
    Promise.resolve(hashes.includes(hash) ? { hash, id: `${hash}@test` } : undefined),
});
const PHOTO = { type: "image", role: "thumb" as const, hash: "abc", uris: ["abc@h"] };

/** Seed an OSM-sourced place with a name but no description — the thin record contributions fix. */
async function seedOsmPlace(store: Awaited<ReturnType<typeof placesHarness>>["store"]) {
  await store.commitPlace(
    makePlace(U1, { name: "Volunteer Park" }),
    makeSource(U1, { fields: { category: "park", name: "Volunteer Park", point: POINT } }),
    ["c23nb6"],
    [],
  );
}

describe("places.propose — game admission", () => {
  it("refuses a submission from an unadmitted game with 403 gameNotAdmitted", async () => {
    // A proposal is a durable row in the OPERATOR's curated dataset and their review queue, so it
    // is game content by the gate's rule even though it arrives through the shared bracket the way
    // mailbox and media do. Leaving it open would let an application refused everywhere else still
    // spend the operator's review time, which is the one cost measured in someone's attention.
    const { contributionsController: cc, stranger } = placesHarness({ games: ["kites"] });
    const env = proposeEnv(stranger, { target: NEW_TARGET }, undefined, "other-game");
    const err = await rejectedWith(() => cc.propose(env));
    expect(err.getStatus()).toBe(403);
    expect(err.getResponse()).toMatchObject({ error: "gameNotAdmitted" });
  });

  it("admits a listed game, and refuses a submission naming no game", async () => {
    const { contributionsController: cc, stranger } = placesHarness({ games: ["kites"] });
    expect(
      (await cc.propose(proposeEnv(stranger, { target: NEW_TARGET }, undefined, "kites"))).ok,
    ).toBe(true);
    const gameless = proposeEnv(stranger, { target: NEW_TARGET }, undefined, null);
    expect(await statusOf(cc.propose(gameless))).toBe(403);
  });

  it("refuses before the submission budget is charged, so a refusal costs the player nothing", async () => {
    // Admission precedes billing here as on the other three paths. The budget is one, so a charged
    // refusal would exhaust it and the honest submission after it would come back 429.
    const { contributionsController: cc, stranger } = placesHarness({
      games: ["kites"],
      rateMax: 1,
    });
    expect(
      await statusOf(
        cc.propose(proposeEnv(stranger, { target: NEW_TARGET }, undefined, "other-game")),
      ),
    ).toBe(403);
    expect(
      (await cc.propose(proposeEnv(stranger, { target: NEW_TARGET }, undefined, "kites"))).ok,
    ).toBe(true);
  });

  it("denies a revoked device on both the write and the read (403)", async () => {
    // Place proposals pass the shared signed-request gate like every other signed path. Unlike the
    // app gate, revocation covers the READ too — a stolen phone reading its owner's pending
    // submissions is the same problem as it filing new ones.
    const { contributionsController: cc, stranger } = placesHarness({ revokedStranger: true });
    expect(await statusOf(cc.propose(proposeEnv(stranger, { target: NEW_TARGET })))).toBe(403);
    expect(await statusOf(cc.fetch(signedEnv(stranger, "places.proposals.fetch", {})))).toBe(403);
  });

  it("leaves the signed READ open, so a player can still see their own pending submissions", async () => {
    // A game gate guards writes only. Refusing the fetch would hide a player's own contributions
    // from them without taking one row off the operator's queue.
    const { contributionsController: cc, stranger } = placesHarness({ games: ["kites"] });
    await cc.propose(proposeEnv(stranger, { target: NEW_TARGET }, undefined, "kites"));
    const { proposals } = await cc.fetch(
      signedEnv(stranger, "places.proposals.fetch", {}, undefined, "other-game"),
    );
    expect(proposals).toHaveLength(1);
  });
});

describe("places.propose — submission (place-proposals.md §5)", () => {
  it("records a pending proposal and publishes nothing", async () => {
    const { contributionsController: cc, store, stranger } = placesHarness();
    const { ok, proposal } = await cc.propose(proposeEnv(stranger, { target: NEW_TARGET }));

    expect(ok).toBe(true);
    expect(proposal.status).toBe("pending");
    expect(proposal.proposedBy).toBe(stranger.account.did);
    expect(proposal.credit).toBe(false); // opt-in, and this submission didn't opt in
    expect(proposal.placeUnique).toBeUndefined(); // a new-place proposal names no place yet
    expect(proposal.fields).toEqual({
      category: "park",
      subcategory: "play",
      point: POINT,
      name: "Pocket Park",
      description: NEW_TARGET.description,
    });

    // The dataset is untouched — this is the whole point of review-before-publish.
    expect((await store.queryByCells(["c23"], undefined, 10)).places).toHaveLength(0);
    expect(await store.getPlace(proposal.id)).toBeUndefined();
  });

  it("names a field it does not know inside the point, rather than dropping it", async () => {
    const { contributionsController: cc, stranger } = placesHarness();
    const target = { ...NEW_TARGET, point: { ...POINT, accuracy: 5 } };
    const err = await rejectedWith(() => cc.propose(proposeEnv(stranger, { target })));
    expect(err.getResponse()).toMatchObject({
      error: "invalid",
      fields: ["target.point.accuracy"],
    });
  });

  it("is idempotent by nonce", async () => {
    const { contributionsController: cc, stranger } = placesHarness();
    const nonce = ulid();
    const first = await cc.propose(proposeEnv(stranger, { target: NEW_TARGET }, nonce));
    const retry = await cc.propose(proposeEnv(stranger, { target: NEW_TARGET }, nonce));
    expect(retry.proposal.id).toBe(first.proposal.id);

    const mine = await cc.fetch(fetchEnv(stranger));
    expect(mine.proposals).toHaveLength(1);
  });

  it("fences a new place to a curated (category, subcategory) pair", async () => {
    const { contributionsController: cc, stranger } = placesHarness();
    // `gallery` is a real slug — but of `culture`, not `park`. Slugs are namespaced per category.
    await expect(
      statusOf(
        cc.propose(proposeEnv(stranger, { target: { ...NEW_TARGET, subcategory: "gallery" } })),
      ),
    ).resolves.toBe(400);
    // A slug of no category at all.
    await expect(
      statusOf(
        cc.propose(proposeEnv(stranger, { target: { ...NEW_TARGET, subcategory: "speakeasy" } })),
      ),
    ).resolves.toBe(400);
    // The pair the taxonomy actually publishes.
    expect((await cc.propose(proposeEnv(stranger, { target: NEW_TARGET }))).ok).toBe(true);
  });

  it("accepts an improvement to an active place and refuses one to an unknown place", async () => {
    const { contributionsController: cc, store, stranger } = placesHarness();
    await seedOsmPlace(store);

    const { proposal } = await cc.propose(
      proposeEnv(stranger, {
        target: {
          kind: "existing",
          unique: U1,
          description: "A 1904 Olmsted park.",
          license: "CC0-1.0",
        },
        credit: true,
      }),
    );
    expect(proposal.placeUnique).toBe(U1);
    expect(proposal.credit).toBe(true);

    await expect(
      statusOf(
        cc.propose(
          proposeEnv(stranger, {
            target: {
              kind: "existing",
              unique: "01ZZZZZZZZZZZZZZZZZZZZZZZZ",
              description: "x",
              license: "CC0-1.0",
            },
          }),
        ),
      ),
    ).resolves.toBe(400);
  });

  it("refuses an improvement that changes nothing, or one that reaches past descriptor fields", async () => {
    const { contributionsController: cc, store, stranger } = placesHarness();
    await seedOsmPlace(store);
    const bad = (target: Record<string, unknown>) =>
      statusOf(cc.propose(proposeEnv(stranger, { target })));

    await expect(bad({ kind: "existing", unique: U1, license: "CC0-1.0" })).resolves.toBe(400);
    // Moving or recategorizing someone else's place is operator-only — the schema is `.strict()`,
    // so these aren't quietly dropped, they're rejected.
    await expect(
      bad({ kind: "existing", unique: U1, point: { lat: 0, lng: 0 }, license: "CC0-1.0" }),
    ).resolves.toBe(400);
    await expect(
      bad({ kind: "existing", unique: U1, category: "sweets", license: "CC0-1.0" }),
    ).resolves.toBe(400);
  });

  it("only accepts photos this server can actually serve", async () => {
    const withMedia = placesHarness({ media: mediaWith("abc") });
    const target = { ...NEW_TARGET, media: [PHOTO] };
    expect(
      (await withMedia.contributionsController.propose(proposeEnv(withMedia.stranger, { target })))
        .ok,
    ).toBe(true);

    // A hash this server doesn't hold — a reviewer could never see what they're judging.
    await expect(
      statusOf(
        withMedia.contributionsController.propose(
          proposeEnv(withMedia.stranger, {
            target: { ...NEW_TARGET, media: [{ ...PHOTO, hash: "zzz" }] },
          }),
        ),
      ),
    ).resolves.toBe(400);

    // The stored entry points at THIS server's copy, not wherever the client said. Every consumer
    // fetches `uris[0]`, so keeping the client's pointer would have the reviewer judging bytes from
    // a host we don't control — and the approved place serving them, swappable, forever.
    const [stored] = (
      await withMedia.contributionsController.fetch(fetchEnv(withMedia.stranger, {}))
    ).proposals!;
    // …and it carries a credit this server BUILT: the grant the contributor chose, attributed to
    // this server because they did not ask to be named. A client-supplied credit is dropped — it
    // is published on a public read and could otherwise name anyone.
    expect(stored?.fields.media).toEqual([
      {
        type: "image",
        role: "thumb",
        hash: "abc",
        uris: ["abc@test"],
        credit: {
          license: "CC0 1.0",
          licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
          author: "did:key:zServerTest",
        },
      },
    ]);

    // Media capability off: refused outright rather than silently accepted photo-less.
    const noMedia = placesHarness();
    await expect(
      statusOf(noMedia.contributionsController.propose(proposeEnv(noMedia.stranger, { target }))),
    ).resolves.toBe(400);
  });

  it("caps a contributor's unreviewed backlog and their submission rate", async () => {
    const pending = placesHarness({ maxPending: 2 });
    const submit = (h: typeof pending) =>
      h.contributionsController.propose(proposeEnv(h.stranger, { target: NEW_TARGET }));
    await submit(pending);
    await submit(pending);
    // 2 already awaiting review: a 409 state refusal, not a 429 a client would retry.
    const full = await rejectedWith(() => submit(pending));
    expect(full.getStatus()).toBe(409);
    expect(full.getResponse()).toMatchObject({ ok: false, error: "tooManyPending" });

    // The rate budget is independent: a contributor whose queue is clear still can't flood.
    const rated = placesHarness({ rateMax: 1, maxPending: 99 });
    await submit(rated);
    await expect(statusOf(submit(rated))).resolves.toBe(429);
  });

  it("404s as absent when submissions are closed or places is off", async () => {
    const closed = placesHarness({ contributions: false });
    await expect(
      statusOf(
        closed.contributionsController.propose(proposeEnv(closed.stranger, { target: NEW_TARGET })),
      ),
    ).resolves.toBe(404);

    const off = placesHarness({ placesEnabled: false });
    await expect(
      statusOf(
        off.contributionsController.propose(proposeEnv(off.stranger, { target: NEW_TARGET })),
      ),
    ).resolves.toBe(404);
  });
});

describe("places.proposals.fetch — scoping", () => {
  it("a contributor sees only their own submissions", async () => {
    const { contributionsController: cc, controller, admin, stranger } = placesHarness();
    const other = createWallet();
    await cc.propose(proposeEnv(stranger, { target: NEW_TARGET }));
    await cc.propose(proposeEnv(other, { target: NEW_TARGET }));

    const mine = await cc.fetch(fetchEnv(stranger));
    expect(mine.proposals.map((p) => p.proposedBy)).toEqual([stranger.account.did]);
    const theirs = await cc.fetch(fetchEnv(other));
    expect(theirs.proposals.map((p) => p.proposedBy)).toEqual([other.account.did]);

    // The operator's queue is the unscoped view of the same op.
    const queue = await controller.proposalsFetch(fetchEnv(admin));
    expect(queue.proposals).toHaveLength(2);
  });

  it("rejects a replayed read envelope", async () => {
    const { contributionsController: cc, stranger } = placesHarness();
    const nonce = ulid();
    await cc.fetch(fetchEnv(stranger, {}, nonce));
    await expect(statusOf(cc.fetch(fetchEnv(stranger, {}, nonce)))).resolves.toBe(409);
  });
});

describe("places.proposals.review — the decision (place-proposals.md §6)", () => {
  it("approving a new place creates it under the proposal's own id, as a contrib source", async () => {
    const { contributionsController: cc, controller, store, admin, stranger } = placesHarness();
    const { proposal } = await cc.propose(proposeEnv(stranger, { target: NEW_TARGET }));

    const reviewed = await controller.proposalsReview(
      reviewEnv(admin, { id: proposal.id, decision: "approve" }),
    );
    expect(reviewed.proposal.status).toBe("approved");
    expect(reviewed.proposal.reviewedBy).toBe(admin.account.did);
    // The id IS the place unique — that's what makes a re-approval idempotent.
    expect(reviewed.proposal.appliedPlace).toBe(proposal.id);

    const place = await store.getPlace(proposal.id);
    expect(place?.name).toBe("Pocket Park");
    expect(place?.category).toBe("park");
    expect(place?.status).toBe("active");
    expect((await store.getSource(CONTRIB_SOURCE, proposal.id))?.editedBy).toBe(admin.account.did);
    // Now visible to an ordinary read.
    expect((await store.queryByCells(["c23"], undefined, 10)).places).toHaveLength(1);
  });

  it("approving an improvement fills the hole without disturbing the connector's fields", async () => {
    const { contributionsController: cc, controller, store, admin, stranger } = placesHarness();
    await seedOsmPlace(store);
    const { proposal } = await cc.propose(
      proposeEnv(stranger, {
        target: {
          kind: "existing",
          unique: U1,
          description: "A 1904 Olmsted park.",
          license: "CC0-1.0",
        },
      }),
    );
    await controller.proposalsReview(reviewEnv(admin, { id: proposal.id, decision: "approve" }));

    const place = await store.getPlace(U1);
    expect(place?.description).toBe("A 1904 Olmsted park."); // the contribution
    expect(place?.name).toBe("Volunteer Park"); // still OSM's — contrib didn't propose one
    expect((await store.sourcesForPlace(U1)).map((s) => s.source).sort()).toEqual([
      CONTRIB_SOURCE,
      "osm",
    ]);
  });

  it("several contributors accumulate into one contrib record", async () => {
    const { contributionsController: cc, controller, store, admin, stranger } = placesHarness();
    const other = createWallet();
    await seedOsmPlace(store);

    const first = await cc.propose(
      proposeEnv(stranger, {
        target: { kind: "existing", unique: U1, description: "A park.", license: "CC0-1.0" },
      }),
    );
    const second = await cc.propose(
      proposeEnv(other, {
        target: {
          kind: "existing",
          unique: U1,
          website: "https://parks.example",
          license: "CC0-1.0",
        },
      }),
    );
    await controller.proposalsReview(
      reviewEnv(admin, { id: first.proposal.id, decision: "approve" }),
    );
    await controller.proposalsReview(
      reviewEnv(admin, { id: second.proposal.id, decision: "approve" }),
    );

    const place = await store.getPlace(U1);
    expect(place?.description).toBe("A park."); // the earlier contribution survived the later one
    expect(place?.website).toBe("https://parks.example");
    expect((await store.getSource(CONTRIB_SOURCE, U1))?.fields).toEqual({
      description: "A park.",
      website: "https://parks.example",
      // The description's credit travels with the description — set by the submission that wrote
      // it, and untouched by the later website-only contribution.
      descriptionCredit: {
        license: "CC0 1.0",
        licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
        author: "did:key:zServerTest",
      },
    });
  });

  it("a reviewer can amend before it lands", async () => {
    const { contributionsController: cc, controller, store, admin, stranger } = placesHarness();
    const { proposal } = await cc.propose(proposeEnv(stranger, { target: NEW_TARGET }));
    await controller.proposalsReview(
      reviewEnv(admin, {
        id: proposal.id,
        decision: "approve",
        edits: { name: "Pocket Park (South)" },
      }),
    );
    expect((await store.getPlace(proposal.id))?.name).toBe("Pocket Park (South)");
  });

  it("rejecting writes nothing to the dataset but tells the contributor why", async () => {
    const { contributionsController: cc, controller, store, admin, stranger } = placesHarness();
    const { proposal } = await cc.propose(proposeEnv(stranger, { target: NEW_TARGET }));

    await controller.proposalsReview(
      reviewEnv(admin, {
        id: proposal.id,
        decision: "reject",
        reason: "that's a private residence",
      }),
    );
    expect(await store.getPlace(proposal.id)).toBeUndefined();
    expect((await store.queryByCells(["c23"], undefined, 10)).places).toHaveLength(0);

    const mine = await cc.fetch(fetchEnv(stranger));
    expect(mine.proposals[0]?.status).toBe("rejected");
    expect(mine.proposals[0]?.reviewReason).toBe("that's a private residence");
  });

  it("the first decision stands — a second operator can't overturn it", async () => {
    const { contributionsController: cc, controller, store, admin, stranger } = placesHarness();
    const { proposal } = await cc.propose(proposeEnv(stranger, { target: NEW_TARGET }));
    await controller.proposalsReview(reviewEnv(admin, { id: proposal.id, decision: "approve" }));

    const second = await controller.proposalsReview(
      reviewEnv(admin, { id: proposal.id, decision: "reject", reason: "changed my mind" }),
    );
    expect(second.proposal.status).toBe("approved");
    expect(second.proposal.reviewReason).toBeUndefined();
    expect(await store.getPlace(proposal.id)).toBeDefined(); // and the place stays
  });

  it("is admin-only, and the queue stays reviewable after submissions close", async () => {
    const open = placesHarness();
    const { proposal } = await open.contributionsController.propose(
      proposeEnv(open.stranger, { target: NEW_TARGET }),
    );
    await expect(
      statusOf(
        open.controller.proposalsReview(
          reviewEnv(open.stranger, { id: proposal.id, decision: "approve" }),
        ),
      ),
    ).resolves.toBe(403);
    await expect(statusOf(open.controller.proposalsFetch(fetchEnv(open.stranger)))).resolves.toBe(
      403,
    );

    // Closing submissions must not strand a backlog.
    const closed = placesHarness({ contributions: false });
    expect((await closed.controller.proposalsFetch(fetchEnv(closed.admin))).ok).toBe(true);

    // Places off entirely ⇒ the queue is absent too.
    const off = placesHarness({ placesEnabled: false });
    await expect(statusOf(off.controller.proposalsFetch(fetchEnv(off.admin)))).resolves.toBe(404);
  });

  it("refuses to approve an improvement whose place has retired, and leaves it pending", async () => {
    const { contributionsController: cc, controller, store, admin, stranger } = placesHarness();
    await seedOsmPlace(store);
    const { proposal } = await cc.propose(
      proposeEnv(stranger, {
        target: { kind: "existing", unique: U1, description: "A park.", license: "CC0-1.0" },
      }),
    );
    // The place's only source stops carrying it after the submission, so the place retires and a
    // description alone can't make it servable again.
    await store.commitPlace(
      makePlace(U1, { name: "Volunteer Park", status: "retired" }),
      makeSource(U1, {
        fields: { category: "park", name: "Volunteer Park", point: POINT },
        goneAt: "2026-01-02T00:00:00.000Z",
      }),
      [],
      [],
    );

    const err = await rejectedWith(() =>
      controller.proposalsReview(reviewEnv(admin, { id: proposal.id, decision: "approve" })),
    );
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse()).toMatchObject({ error: "unknownPlace" });
    expect((await cc.fetch(fetchEnv(stranger))).proposals[0]?.status).toBe("pending");
    expect((await store.getPlace(U1))?.status).toBe("retired");
  });

  it("404s an unknown proposal id", async () => {
    const { controller, admin } = placesHarness();
    await expect(
      statusOf(
        controller.proposalsReview(
          reviewEnv(admin, { id: "01ZZZZZZZZZZZZZZZZZZZZZZZZ", decision: "approve" }),
        ),
      ),
    ).resolves.toBe(404);
  });
});

describe("a place's credited contributors (place-proposals.md §5)", () => {
  it("names an approved contributor who asked for credit — but only when the read asks", async () => {
    const {
      contributionsController: cc,
      controller,
      reads,
      store,
      admin,
      stranger,
    } = placesHarness();
    await seedOsmPlace(store);
    const { proposal } = await cc.propose(
      proposeEnv(stranger, {
        target: {
          kind: "existing",
          unique: U1,
          description: "A 1904 Olmsted park.",
          license: "CC0-1.0",
        },
        credit: true,
      }),
    );
    await controller.proposalsReview(reviewEnv(admin, { id: proposal.id, decision: "approve" }));

    // A client that doesn't ask never sees the key — which is what lets this ship ahead of the app
    // release that reads it, since `placeDetailSchema` is `.strict()`.
    expect(await reads.detail(U1)).not.toHaveProperty("contributors");
    expect((await reads.detail(U1, true))?.contributors).toEqual([stranger.account.did]);
  });

  it("credits the author of a new place too, whose proposal named no place at all", async () => {
    // A new-place proposal has a null `place_unique` and lands on a place whose unique is the
    // proposal's own id — so keying the read on `place_unique` would miss exactly the person who
    // put the place there.
    const { contributionsController: cc, controller, reads, admin, stranger } = placesHarness();
    const { proposal } = await cc.propose(
      proposeEnv(stranger, { target: NEW_TARGET, credit: true }),
    );
    await controller.proposalsReview(reviewEnv(admin, { id: proposal.id, decision: "approve" }));

    expect((await reads.detail(proposal.id, true))?.contributors).toEqual([stranger.account.did]);
  });

  it("leaves out anyone who stayed anonymous, and anyone still waiting", async () => {
    const {
      contributionsController: cc,
      controller,
      reads,
      store,
      admin,
      stranger,
    } = placesHarness();
    await seedOsmPlace(store);

    const anon = await cc.propose(
      proposeEnv(stranger, {
        target: {
          kind: "existing",
          unique: U1,
          description: "Quiet in the mornings.",
          license: "CC0-1.0",
        },
      }),
    );
    await controller.proposalsReview(
      reviewEnv(admin, { id: anon.proposal.id, decision: "approve" }),
    );
    // Approved but never asked for credit → not named.
    expect((await reads.detail(U1, true))?.contributors).toEqual([]);

    // Wants credit, but nobody has decided yet — a request to be credited is a preference, not an
    // attribution, and must not appear on a place before the contribution does.
    await cc.propose(
      proposeEnv(stranger, {
        target: { kind: "existing", unique: U1, website: "https://x.example", license: "CC0-1.0" },
        credit: true,
      }),
    );
    expect((await reads.detail(U1, true))?.contributors).toEqual([]);
  });
});
