/**
 * The shared signed-read bracket answers a params key it does not know the way the place route does
 * : by name, in `fields`, rather than as zod's issue dump.
 */
import { HttpStatus } from "@nestjs/common";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { signedReadParams } from "../common/capability-http";
import { rejectedWith } from "./test-helpers";

const nonce = { check: () => Promise.resolve(undefined), remember: () => Promise.resolve() };
const schema = z.object({ limit: z.number().int().optional() }).strict();
const env = (params: unknown) => ({
  actor: "did:key:zReader",
  env: { op: "test.fetch", nonce: ulid(), params },
});

describe("signedReadParams", () => {
  it("names a params key this build does not know", async () => {
    const err = await rejectedWith(() =>
      signedReadParams(nonce, env({ limit: 2, since: 5 }), schema),
    );
    expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(err.getResponse()).toMatchObject({ error: "invalid", fields: ["since"] });
  });

  it("keeps zod's own message for anything else", async () => {
    const err = await rejectedWith(() => signedReadParams(nonce, env({ limit: "two" }), schema));
    expect(err.getResponse()).not.toHaveProperty("fields");
  });
});
