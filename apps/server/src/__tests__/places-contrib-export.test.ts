import { createWallet } from "@beaconsgg/identity";
import { describe, expect, it } from "vitest";
import { licenseEnvelope } from "../places/export-import";
import { makePlace, makeSource, placesHarness, signedEnv, statusOf } from "./test-helpers";

/**
 * The contribution round-trip's export half (`apps/atlas/doc/spec/beacon-integration.md` §9).
 *
 * This is the one direction in the architecture where player-derived data flows toward a central
 * party, so most of what is asserted here is what the file does **not** contain. The leak checks
 * grep the serialized payload rather than inspecting a field, because a leak that matters is one
 * that arrives anywhere in the bytes — a `raw` payload, a stray credit line, a note folded into a
 * description — not only in the property somebody remembered to test.
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
  license: "CC0-1.0",
};

const proposeEnv = (w: ReturnType<typeof createWallet>, params: Record<string, unknown>) =>
  signedEnv(w, "places.propose", params);
const reviewEnv = (w: ReturnType<typeof createWallet>, params: Record<string, unknown>) =>
  signedEnv(w, "places.proposals.review", params);
const exportEnv = (w: ReturnType<typeof createWallet>, params: Record<string, unknown> = {}) =>
  signedEnv(w, "places.contrib.export", params);

/** Submit and approve in one step — every test here starts from an approved contribution. */
async function contribute(
  h: ReturnType<typeof placesHarness>,
  wallet: ReturnType<typeof createWallet>,
  target: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const { proposal } = await h.contributionsController.propose(
    proposeEnv(wallet, { target, ...extra }),
  );
  await h.controller.proposalsReview(reviewEnv(h.admin, { id: proposal.id, decision: "approve" }));
  return proposal.id;
}

describe("places.contrib.export — what leaves, and what never does", () => {
  it("is absent unless the operator turned it on", async () => {
    const off = placesHarness();
    await expect(statusOf(off.controller.exportContrib(exportEnv(off.admin)))).resolves.toBe(404);

    const on = placesHarness({ contribExport: true });
    expect((await on.controller.exportContrib(exportEnv(on.admin))).ok).toBe(true);
  });

  it("carries a credited contributor's DID and strips an uncredited one — note never leaves", async () => {
    const h = placesHarness({ contribExport: true });
    const named = createWallet();
    const anonymous = createWallet();

    await contribute(
      h,
      named,
      { ...NEW_TARGET, license: "CC-BY-4.0" },
      {
        credit: true,
        note: "I walk past this every morning",
      },
    );
    await contribute(
      h,
      anonymous,
      { ...NEW_TARGET, name: "Quiet Corner" },
      {
        note: "found it on a run",
      },
    );

    const { collection } = await h.controller.exportContrib(exportEnv(h.admin));
    expect(collection.beacon.profile).toBe("beacon-contrib/1");
    expect(collection.features).toHaveLength(2);

    const payload = JSON.stringify(collection);
    expect(payload).toContain(named.account.did);
    // The two assertions the whole feature is gated on.
    expect(payload).not.toContain(anonymous.account.did);
    expect(payload).not.toContain("every morning");
    expect(payload).not.toContain("on a run");
  });

  it("states the strictest grant of the contributions that fed a place", async () => {
    // Pure, because it is the rule rather than the plumbing: a consumer told CC0 about a field
    // somebody granted only under attribution has been misinformed in a way it cannot detect.
    expect(licenseEnvelope([{ license: "CC0-1.0" }, { license: "CC-BY-4.0" }])).toBe("CC-BY-4.0");
    expect(licenseEnvelope([{ license: "CC0-1.0" }])).toBe("CC0-1.0");
    // An uncredited contribution records no credited row at all, and CC0 is the floor.
    expect(licenseEnvelope([])).toBe("CC0-1.0");
  });

  it("carries the place's other source keys, so an improvement joins rather than duplicates", async () => {
    const h = placesHarness({ contribExport: true });
    await h.store.commitPlace(
      makePlace(U1, { category: "park", name: "Volunteer Park" }),
      makeSource(U1, {
        sourceId: "way/586464226",
        fields: { category: "park", name: "Volunteer Park", point: POINT },
      }),
      ["c23nb6"],
      [],
    );
    await contribute(h, createWallet(), {
      kind: "existing",
      unique: U1,
      description: "A 1904 Olmsted park.",
      license: "CC0-1.0",
    });

    const { collection } = await h.controller.exportContrib(exportEnv(h.admin));
    const [feature] = collection.features;
    expect(feature?.properties.contrib?.upstream).toEqual(["way/586464226"]);
    expect(feature?.properties.contrib?.id).toBe(`test.example/${U1}`);
    // The CONTRIBUTION's own fields, not the merged place: OSM named this park, and exporting that
    // name would ship a mapper's work as though a player had written it.
    expect(feature?.properties.name).toBeUndefined();
    expect(feature?.properties.description).toBe("A 1904 Olmsted park.");
  });

  it("skips a place whose UNCREDITED contribution has no grant", async () => {
    // The gate the first cut got wrong: it read *credited* contributions, and an uncredited one is
    // absent from that read — so a place whose only contribution had no grant looked identical to a
    // place with none and shipped stamped CC0, on a grant nobody made, into bytes that never change.
    const h = placesHarness({ contribExport: true });
    await contribute(h, createWallet(), NEW_TARGET); // uncredited by default
    const [stored] = await h.store.listProposals({}, 10);
    delete (stored as { license?: unknown }).license;
    await h.store.createProposal(stored!);

    const { collection } = await h.controller.exportContrib(exportEnv(h.admin));
    expect(collection.features).toHaveLength(0);
  });

  it("skips a place whose contributions predate the grant", async () => {
    const h = placesHarness({ contribExport: true });
    await contribute(h, createWallet(), NEW_TARGET, { credit: true });
    // Rewrite the row the way a pre-0021 database holds it: approved, credited, no licence.
    const [stored] = await h.store.listProposals({}, 10);
    expect(stored).toBeDefined();
    delete (stored as { license?: unknown }).license;
    await h.store.createProposal(stored!);

    const { collection } = await h.controller.exportContrib(exportEnv(h.admin));
    expect(collection.features).toHaveLength(0);
  });
});

describe("places.import — a contribution file is not a list", () => {
  it("refuses a beacon-contrib/1 collection", async () => {
    const h = placesHarness({ contribExport: true });
    await contribute(h, createWallet(), NEW_TARGET);
    const { collection } = await h.controller.exportContrib(exportEnv(h.admin));

    await expect(
      statusOf(
        h.controller.import(signedEnv(h.admin, "places.import", { name: "borrowed", collection })),
      ),
    ).resolves.toBe(400);
  });
});

describe("places.propose — the grant and the anonymity rule", () => {
  it("refuses CC-BY on an uncredited submission, in the schema", async () => {
    const h = placesHarness();
    await expect(
      statusOf(
        h.contributionsController.propose(
          proposeEnv(createWallet(), { target: { ...NEW_TARGET, license: "CC-BY-4.0" } }),
        ),
      ),
    ).resolves.toBe(400);

    // The same submission, credited, is fine — the constraint is the pairing, not the licence.
    expect(
      (
        await h.contributionsController.propose(
          proposeEnv(createWallet(), {
            target: { ...NEW_TARGET, license: "CC-BY-4.0" },
            credit: true,
          }),
        )
      ).ok,
    ).toBe(true);
  });
});
