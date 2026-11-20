import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { HOME_CSS, HOME_JS } from "./home.assets";
import { faviconSvg } from "./tower";
import { HOME_ASSETS_DIR, PACKAGE_FILES } from "./package-files";

/** A file the home page loads, ready to send: its bytes, a gzipped copy where that helps, its tag. */
export interface ServedFile {
  type: string;
  body: Buffer;
  /** Only for text: fonts are compressed already. */
  gzip: Buffer | undefined;
  /** The content hash: the `ETag`, and the `?v=` the page links the file under. */
  hash: string;
}

const TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  svg: "image/svg+xml",
  woff2: "font/woff2",
};

function served(name: string, body: Buffer): ServedFile {
  const ext = name.slice(name.lastIndexOf(".") + 1);
  const type = TYPES[ext] ?? "application/octet-stream";
  return {
    type,
    body,
    gzip: ext === "woff2" ? undefined : gzipSync(body, { level: 9 }),
    hash: createHash("sha256").update(body).digest("base64url").slice(0, 12),
  };
}

/**
 * A package file: from `dist/home-assets`, where the build copied it, or from the package itself
 * when running from source (the suites, a dev boot without a build).
 */
function packageFile(name: string, specifier: string): Buffer {
  const built = join(__dirname, HOME_ASSETS_DIR, name);
  return readFileSync(existsSync(built) ? built : require.resolve(specifier));
}

function load(): Map<string, ServedFile> {
  const files = new Map<string, ServedFile>();
  for (const [name, specifier] of Object.entries(PACKAGE_FILES)) {
    files.set(name, served(name, packageFile(name, specifier)));
  }
  // The stylesheet names the fonts by their versioned addresses, so a new font is a new URL too.
  const css = HOME_CSS.replace(/\/_home\/([a-z0-9-]+\.woff2)/g, (_, font: string) => {
    const file = files.get(font);
    if (!file) throw new Error(`home page: the stylesheet names ${font}, which is not served`);
    return `/_home/${font}?v=${file.hash}`;
  });
  files.set("home.css", served("home.css", Buffer.from(css)));
  files.set("home.js", served("home.js", Buffer.from(HOME_JS)));
  files.set("icon.svg", served("icon.svg", Buffer.from(faviconSvg())));
  return files;
}

/**
 * Every file, read and prepared once when the server starts: a missing one stops the boot rather
 * than failing the first visitor, and no request hashes or compresses a megabyte again.
 */
export const HOME_FILES: ReadonlyMap<string, ServedFile> = load();

/**
 * The address the page links a file under, its content hash in the query: the HTML is never
 * cached, so a release that changes a file changes its address, and a browser can keep each one
 * for good rather than mix a new page with yesterday's script.
 */
export function assetUrl(name: string): string {
  const file = HOME_FILES.get(name);
  if (!file) throw new Error(`home page: no file named ${name}`);
  return `/_home/${name}?v=${file.hash}`;
}
