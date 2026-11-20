import { defineConfig } from "vitest/config";
import { SRC_SCOPE, coverageFor } from "@beaconsgg/vitest-config";

// One suite, end to end: it boots the real server on Postgres and runs the driver through it, so
// the driver's own lines are covered by the run that matters. The CLI wrapper (`main.ts`) is thin
// and read by `parseEnv`'s unit tests; its process-level tail is the uncovered remainder.
export default defineConfig({
  test: {
    coverage: coverageFor({ include: SRC_SCOPE }),
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
});
