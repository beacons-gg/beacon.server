import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { publishedOpenApiDocument } from "../docs/openapi";

/**
 * The committed `openapi.json` is the published spec, so a pull request shows its API change. When
 * this fails, regenerate it: `pnpm --filter @beaconsgg/server-app openapi`.
 */
describe("the committed OpenAPI snapshot", () => {
  it("matches the spec the wire schemas build", () => {
    const committed: unknown = JSON.parse(
      readFileSync(join(__dirname, "..", "..", "openapi.json"), "utf8"),
    );
    expect(committed).toEqual(publishedOpenApiDocument());
  });
});
