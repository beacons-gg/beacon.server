import { defineConfig } from "vitest/config";
import { SRC_SCOPE, coverageFor } from "@beaconsgg/vitest-config";

// `src/testing.ts` is fixtures published for other suites, not engine code. Counted, the fixtures
// this package's own tests run would lift the floor the engine is held to.
export default defineConfig({
  test: { coverage: coverageFor({ include: SRC_SCOPE, exclude: ["src/testing.ts"] }) },
});
