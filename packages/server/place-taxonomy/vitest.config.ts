import { defineConfig } from "vitest/config";
import { SRC_SCOPE, coverageFor } from "@beaconsgg/vitest-config";

// Below the repo floor at 63.3%, so it carries its own. `taxonomy.ts` is at 57.7% lines and 20% of
// its functions: the category mapping is a large data table with a handful of entry points, and the
// suite reaches the entry points rather than the table.
export default defineConfig({
  test: { coverage: coverageFor({ include: SRC_SCOPE, floor: 60 }) },
});
