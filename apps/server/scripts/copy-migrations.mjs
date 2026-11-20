// Copy the raw-SQL migration files into the build output. `tsc` compiles .ts only, so the
// checked-in .sql files (src/migrations/postgres/*.sql) must be copied to dist so the runtime
// migration runner (dist/migrations/runner.js, which resolves via __dirname) can read them.
import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, "..", "src", "migrations");
const to = join(here, "..", "dist", "migrations");

cpSync(join(from, "postgres"), join(to, "postgres"), { recursive: true }); // throws if it is missing
console.info("copied migration SQL -> dist/migrations");
