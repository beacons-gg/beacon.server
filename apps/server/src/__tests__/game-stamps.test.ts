import { beforeEach, describe, expect, it } from "vitest";
import { PgMailboxStore } from "../stores/mailbox.pg.store";
import { PgStore } from "../stores/pg.store";
import { pgTwin } from "./pg-twin";

/**
 * The boot log's count of data from before game slugs (doc/deploy.md): the rooms and mail no game
 * can read or act on until the one-off update stamps them.
 */
const twin = pgTwin(
  (pool) => ({ rooms: new PgStore(pool, 1000), mailbox: new PgMailboxStore(pool) }),
  ["rooms", "mailbox"],
);

describe("counting what carries no game", () => {
  beforeEach(() => twin.reset());

  it("counts the rooms and the mail with no game, and nothing that has one", async () => {
    const { rooms, mailbox } = await twin.open();
    await twin.query(
      "INSERT INTO rooms (id, data, geohash) VALUES ('old@h', $1, 'c23nb'), ('new@h', $2, 'c23nb')",
      [{ type: "jar" }, { type: "jar", game: "game-a" }],
    );
    await twin.query(
      "INSERT INTO mailbox (id, recipient, sender, body, received_at, expires_at, nonce, game) " +
        "VALUES ('m1', 'r', 's', 'b', 't', 't', 'n1', NULL), ('m2', 'r', 's', 'b', 't', 't', 'n2', 'game-a')",
    );
    expect(await rooms.countWithoutGame()).toBe(1);
    expect(await mailbox.countWithoutGame()).toBe(1);
  });
});
