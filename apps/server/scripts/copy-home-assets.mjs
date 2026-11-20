// Copy the home page's package files (fonts, the map library) into the build output, so the
// runtime serves them from dist and the packages themselves can stay dev dependencies: the image
// then carries the seven files the page loads, not the tens of megabytes they ship in. The list is
// src/home/package-files.ts, compiled by tsc just before this runs.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { PACKAGE_FILES, HOME_ASSETS_DIR } = require("../dist/home/package-files.js");
const to = join(here, "..", "dist", "home", HOME_ASSETS_DIR);

mkdirSync(to, { recursive: true });
for (const [name, specifier] of Object.entries(PACKAGE_FILES)) {
  copyFileSync(require.resolve(specifier), join(to, name)); // throws if a package or file is missing
}
console.info(`copied ${Object.keys(PACKAGE_FILES).length} home page files -> dist/home-assets`);
