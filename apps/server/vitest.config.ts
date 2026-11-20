import { defineConfig } from "vitest/config";
import { coverageFor, SRC_SCOPE } from "@beaconsgg/vitest-config";

// The shared shape (sources in `src/`, tests in `__tests__`) at the repo floor, plus the one thing
// this workspace needs first: a Postgres. The global setup fails the run, with the command that
// starts one, when `BEACON_TEST_DATABASE_URL` is unset or unreachable (#109; apps/server/README.md,
// Commands). Both CI workflows supply one.
export default defineConfig({
  test: {
    coverage: coverageFor({ include: SRC_SCOPE }),
    globalSetup: ["src/__tests__/global-setup.ts"],
  },
});
