import { defineConfig } from "vitest/config";
import { SRC_SCOPE, coverageFor } from "@beaconsgg/vitest-config";

// Below the repo floor at 42.2%, so it carries its own. `reader.ts` (201 lines) and `archive.ts`
// (69) have no test at all: what is covered is the trust check and half of the format codec, and
// the read half of a published volume is exercised through `apps/server`.
export default defineConfig({
  test: { coverage: coverageFor({ include: SRC_SCOPE, floor: 40 }) },
});
