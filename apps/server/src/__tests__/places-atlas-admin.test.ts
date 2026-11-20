/**
 * The runtime Atlas import surface, end to end: upload → preview → confirm → import → pin.
 *
 * This is the flow that replaced `BEACON_PLACES_ATLAS`: no configuration, no redeploy, and for the
 * archive path no hosting — the volume arrives as a file, is verified against its own signature
 * chain, and the trust decision (the publisher pin) lands in the store beside the data it protects.
 */
import { createHash } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { encode } from "@beaconsgg/geo";
import { placesHarness, signedEnv, statusOf, type TestWallet } from "./test-helpers";
import {
  CELL,
  IMPOSTOR,
  PUBLISHER,
  lighthouse,
  volume,
  volumeTree,
  volumeZip,
} from "./atlas-fixture";
import type { CellTile } from "@beaconsgg/atlas-volume";

const tile = (): CellTile => ({ cell: CELL, revision: 1, places: [lighthouse()] });

/** The upload's wire shape: envelope in the header, archive bytes as the streamed body. */
function uploadRequest(wallet: TestWallet, zip: Buffer): unknown {
  const envelope = signedEnv(wallet, "places.atlas.upload", {
    hash: createHash("sha256").update(zip).digest("base64url"),
    size: zip.length,
  });
  return Object.assign(Readable.from([zip]), {
    headers: { "x-beacon-op": Buffer.from(JSON.stringify(envelope)).toString("base64") },
  });
}

describe("places.atlas — upload, preview, import, pin", () => {
  it("uploads an archive, previews who signed it, imports it, and pins the publisher", async () => {
    const { controller, snapshots, store, staging, admin } = placesHarness();
    const zip = await volumeZip(volume(tile()));

    const up = await controller.atlasUpload(uploadRequest(admin, zip) as never);
    expect(up.preview).toMatchObject({
      volume: "us-west",
      version: "2026-08",
      places: 1,
      cells: 1,
      publisher: PUBLISHER.did,
      pin: "new", // nothing pinned yet — importing is what pins
    });

    const imported = await controller.atlasImport(
      signedEnv(admin, "places.atlas.import", { staged: up.staged, publisher: PUBLISHER.did }),
    );
    expect(imported.snapshot.source).toBe("atlas:us-west");
    await snapshots.idle();

    const done = await snapshots.getSnapshot(imported.snapshot.id);
    expect(done?.status).toBe("done");
    expect(done?.stats).toMatchObject({ chunksTotal: 1, fetched: 1, created: 1 });

    // The trust decision is durable, and the staged bytes are not: the pin outlives the archive.
    expect(await store.getAtlasPublisher("us-west")).toBe(PUBLISHER.did);
    await expect(access(staging.dir(up.staged))).rejects.toThrow();
  });

  it("imports only the cells matching coverage prefixes, and refuses an empty scope", async () => {
    const { controller, snapshots, staging, admin } = placesHarness();
    // A second tile far from c23nb — its place's point must actually encode to its cell, because
    // the connector verifies the two agree.
    const farPoint: [number, number] = [-118.3, 34.05];
    const farCell = encode({ lat: farPoint[1], lng: farPoint[0] }, 5);
    const far: CellTile = {
      cell: farCell,
      revision: 1,
      places: [
        { ...lighthouse(), id: ulid(), name: "Far Place", point: farPoint, upstream: ["osm:w/1"] },
      ],
    };
    const up = await controller.atlasUpload(
      uploadRequest(admin, await volumeZip(volume([tile(), far]))) as never,
    );
    expect(up.preview.cells).toBe(2);

    // A scope matching nothing is refused before any run — and the staged tree survives the
    // rejection, so the retry below corrects the scope against the SAME staged id, no re-upload.
    expect(
      await statusOf(
        controller.atlasImport(
          signedEnv(admin, "places.atlas.import", {
            staged: up.staged,
            publisher: PUBLISHER.did,
            cells: ["zz"],
          }),
        ),
      ),
    ).toBe(400);
    await expect(access(staging.dir(up.staged))).resolves.toBeUndefined();

    // A prefix FINER than the volume's cell precision still selects the cell containing it.
    const imported = await controller.atlasImport(
      signedEnv(admin, "places.atlas.import", {
        staged: up.staged,
        publisher: PUBLISHER.did,
        cells: [`${CELL}7`],
      }),
    );
    await snapshots.idle();
    const done = await snapshots.getSnapshot(imported.snapshot.id);
    expect(done?.status).toBe("done");
    // One chunk, one place — the far cell was never fetched, not fetched-then-dropped.
    expect(done?.stats).toMatchObject({ chunksTotal: 1, fetched: 1, created: 1 });
  });

  it("imports from a mounted path — confined to the configured root, refused without one", async () => {
    const volumesDir = await mkdtemp(join(tmpdir(), "atlas-volumes-"));
    try {
      // The volume tree verbatim, as `cartographer upload` ships it: latest.json + <version>/…
      await volumeTree(join(volumesDir, "us-west"), volume(tile()));

      const { controller, snapshots, admin } = placesHarness({ atlasVolumesDir: volumesDir });
      const preview = await controller.atlasInspect(
        signedEnv(admin, "places.atlas.inspect", { path: "us-west" }),
      );
      expect(preview.preview).toMatchObject({ volume: "us-west", places: 1, pin: "new" });

      const imported = await controller.atlasImport(
        signedEnv(admin, "places.atlas.import", { path: "us-west", publisher: PUBLISHER.did }),
      );
      await snapshots.idle();
      const done = await snapshots.getSnapshot(imported.snapshot.id);
      expect(done?.status).toBe("done");
      expect(done?.stats).toMatchObject({ fetched: 1, created: 1 });

      // The op names a directory UNDER the root and nothing else — a traversal is a 400, and a
      // server with no configured root refuses the whole shape.
      expect(
        await statusOf(
          controller.atlasInspect(signedEnv(admin, "places.atlas.inspect", { path: "../etc" })),
        ),
      ).toBe(400);
      const unconfigured = placesHarness();
      expect(
        await statusOf(
          unconfigured.controller.atlasInspect(
            signedEnv(unconfigured.admin, "places.atlas.inspect", { path: "us-west" }),
          ),
        ),
      ).toBe(400);
    } finally {
      await rm(volumesDir, { recursive: true, force: true });
    }
  });

  it("previews an already-pinned volume as pinned, and a swapped publisher as a mismatch", async () => {
    const { controller, snapshots, admin } = placesHarness();
    const first = await controller.atlasUpload(
      uploadRequest(admin, await volumeZip(volume(tile()))) as never,
    );
    await controller.atlasImport(
      signedEnv(admin, "places.atlas.import", { staged: first.staged, publisher: PUBLISHER.did }),
    );
    await snapshots.idle();

    const again = await controller.atlasUpload(
      uploadRequest(admin, await volumeZip(volume(tile()))) as never,
    );
    expect(again.preview.pin).toBe("pinned");

    // The same volume name signed by a different key — exactly what the pin exists to catch.
    const swapped = await controller.atlasUpload(
      uploadRequest(admin, await volumeZip(volume(tile(), {}, IMPOSTOR))) as never,
    );
    expect(swapped.preview).toMatchObject({ pin: "mismatch", pinnedPublisher: PUBLISHER.did });

    // And importing it is refused — restating the impostor's did does not help, the pin decides.
    expect(
      await statusOf(
        controller.atlasImport(
          signedEnv(admin, "places.atlas.import", {
            staged: swapped.staged,
            publisher: IMPOSTOR.did,
          }),
        ),
      ),
    ).toBe(400);
  });

  it("unpin is the deliberate rotation path: after it, a new publisher can import", async () => {
    const { controller, snapshots, store, admin } = placesHarness();
    const first = await controller.atlasUpload(
      uploadRequest(admin, await volumeZip(volume(tile()))) as never,
    );
    await controller.atlasImport(
      signedEnv(admin, "places.atlas.import", { staged: first.staged, publisher: PUBLISHER.did }),
    );
    await snapshots.idle();

    const unpinned = await controller.atlasUnpin(
      signedEnv(admin, "places.atlas.unpin", { volume: "us-west" }),
    );
    expect(unpinned.removed).toBe(true);

    const rotated = await controller.atlasUpload(
      uploadRequest(admin, await volumeZip(volume(tile(), {}, IMPOSTOR))) as never,
    );
    expect(rotated.preview.pin).toBe("new");
    await controller.atlasImport(
      signedEnv(admin, "places.atlas.import", { staged: rotated.staged, publisher: IMPOSTOR.did }),
    );
    await snapshots.idle();
    expect(await store.getAtlasPublisher("us-west")).toBe(IMPOSTOR.did);
  });

  /**
   * The audit list revocation starts from: before this op, the only path to an unpin was a
   * mismatch preview — which requires possessing a volume signed by the very key being distrusted.
   */
  it("lists every pin with its audit half, and an unpinned volume drops off the list", async () => {
    const { controller, snapshots, admin } = placesHarness();
    const empty = await controller.atlasPins(signedEnv(admin, "places.atlas.pins.fetch", {}));
    expect(empty.pins).toEqual([]);

    const up = await controller.atlasUpload(
      uploadRequest(admin, await volumeZip(volume(tile()))) as never,
    );
    await controller.atlasImport(
      signedEnv(admin, "places.atlas.import", { staged: up.staged, publisher: PUBLISHER.did }),
    );
    await snapshots.idle();

    const listed = await controller.atlasPins(signedEnv(admin, "places.atlas.pins.fetch", {}));
    expect(listed.pins).toHaveLength(1);
    expect(listed.pins[0]).toMatchObject({
      volume: "us-west",
      publisher: PUBLISHER.did,
      pinnedBy: admin.account.did,
    });
    expect(listed.pins[0]!.pinnedAt).toBeTruthy();

    await controller.atlasUnpin(signedEnv(admin, "places.atlas.unpin", { volume: "us-west" }));
    const after = await controller.atlasPins(signedEnv(admin, "places.atlas.pins.fetch", {}));
    expect(after.pins).toEqual([]);
  });

  it("refuses bytes that do not match the signed attestation, and strangers, always", async () => {
    const { controller, admin, stranger } = placesHarness();
    const zip = await volumeZip(volume(tile()));

    // The envelope attests one hash, the body carries other bytes — the streamed re-hash catches it.
    const lying = signedEnv(admin, "places.atlas.upload", {
      hash: createHash("sha256").update(Buffer.from("something else")).digest("base64url"),
      size: zip.length,
    });
    const req = Object.assign(Readable.from([zip]), {
      headers: { "x-beacon-op": Buffer.from(JSON.stringify(lying)).toString("base64") },
    });
    expect(await statusOf(controller.atlasUpload(req as never))).toBe(400);

    expect(await statusOf(controller.atlasUpload(uploadRequest(stranger, zip) as never))).toBe(403);
    expect(
      await statusOf(
        controller.atlasImport(
          signedEnv(stranger, "places.atlas.import", { staged: ulid(), publisher: PUBLISHER.did }),
        ),
      ),
    ).toBe(403);
  });

  it("import restating a publisher the manifest does not carry is refused before any run", async () => {
    const { controller, snapshots, admin } = placesHarness();
    const up = await controller.atlasUpload(
      uploadRequest(admin, await volumeZip(volume(tile()))) as never,
    );
    // The operator "confirmed" a different did than the manifest names — replay-shaped mistake.
    expect(
      await statusOf(
        controller.atlasImport(
          signedEnv(admin, "places.atlas.import", { staged: up.staged, publisher: IMPOSTOR.did }),
        ),
      ),
    ).toBe(400);
    await snapshots.idle();
    expect(await snapshots.listSnapshots()).toHaveLength(0); // nothing was enqueued
  });
});
