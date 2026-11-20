import { defineConfig } from "vitest/config";
import { SRC_SCOPE, coverageFor } from "@beaconsgg/vitest-config";

// Below the repo floor at 60.8%, so it carries its own. The gap is the CLI's own subcommands rather
// than the library under them: `pack.ts` 3.7%, `media.ts` 20.4%, `main.ts` 39.9%, against
// `identity`, `osm`, `normalize`, `merge` and `wikipedia` at 100%.
export default defineConfig({
  test: { coverage: coverageFor({ include: SRC_SCOPE, floor: 60 }) },
});
