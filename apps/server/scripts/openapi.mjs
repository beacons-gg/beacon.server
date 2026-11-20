// Print the published OpenAPI document from the built server (the `openapi` script builds first):
//
//   node scripts/openapi.mjs > openapi.json
//
// The committed file is that output; a test holds it to the wire schemas, and a release attaches it
// to the GitHub Release with the release's version.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { publishedOpenApiDocument } = require("../dist/docs/openapi.js");

process.stdout.write(`${JSON.stringify(publishedOpenApiDocument(), null, 2)}\n`);
