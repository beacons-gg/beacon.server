// @ts-check
// The lint config is the published @beaconsgg/eslint-config: the base rules, the RN-safety gate
// and the tier gate, read from this repo's workspace and from `beacon.foreign` in
// package.json. This repo holds the server tier and installs one package of another: the client
// SDK, for the five-flow driver (apps/flows), which is a client. The root manifest names it as the
// client tier's, so server code may not import it; a game or the console is not installed here and
// fails to resolve on its own.
import { URL } from "node:url";
import { repoConfig } from "@beaconsgg/eslint-config";

export default repoConfig(new URL("./", import.meta.url));
