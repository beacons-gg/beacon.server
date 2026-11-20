/**
 * The manifest of the skew matrix's old client (beacon.core's `doc/core-compatibility.md` §6): this
 * driver's dependencies, with the core packages at a published version instead of the ones this
 * repository's lockfile pins.
 *
 *   beacon-old-client 1.0.0-rc.1 > /tmp/old-client/package.json
 *
 * `pnpm install --ignore-workspace` beside it, with the driver's `dist` copied in, is an installed
 * app that has not updated: the compiled driver over the registry's copies at that version.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

type Dependencies = Record<string, string>;

const CORE_SCOPE = "@beaconsgg/";

/**
 * `dependencies` for a consumer outside the workspace: a core package at `edge`, a `catalog:` range
 * at the version of THAT package the workspace installed (each asked by name: a second catalogued
 * dependency must not inherit the first one's version), and any other range as written. A
 * `workspace:` link to anything but a core package has no meaning outside the workspace, so it is
 * refused rather than guessed.
 */
export function oldClientDependencies(
  dependencies: Dependencies,
  edge: string,
  installed: (name: string) => string,
): Dependencies {
  return Object.fromEntries(
    Object.entries(dependencies).map(([name, range]) => {
      if (name.startsWith(CORE_SCOPE)) return [name, edge];
      if (range.startsWith("catalog:")) return [name, installed(name)];
      if (range.startsWith("workspace:")) {
        throw new Error(`${name} is a workspace link, and is not a core package`);
      }
      return [name, range];
    }),
  );
}

/** The version of `name` installed for the package at `from`: its own node_modules, then each parent's. */
export function installedVersion(name: string, from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    const manifest = join(dir, "node_modules", name, "package.json");
    if (existsSync(manifest)) {
      return (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
    }
    if (dirname(dir) === dir) throw new Error(`${name} is not installed above ${from}`);
  }
}

if (require.main === module) {
  const edge = process.argv[2];
  if (!edge) {
    console.error("usage: beacon-old-client <published core version>");
    process.exit(2);
  }
  const packageDir = join(__dirname, "..");
  const own = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
    dependencies: Dependencies;
  };
  const dependencies = oldClientDependencies(own.dependencies, edge, (name) =>
    installedVersion(name, packageDir),
  );
  console.log(JSON.stringify({ name: "old-client", private: true, dependencies }, null, 2));
}
