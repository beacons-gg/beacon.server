/**
 * The files the home page serves out of installed packages, by the name it asks for them under.
 * `scripts/copy-home-assets.mjs` copies each into `dist/home-assets` at build time, so the image
 * carries these few files and not the packages they come from (the map library's alone is tens of
 * megabytes of source and maps). No side effects: the build script requires this module.
 */
export const PACKAGE_FILES: Readonly<Record<string, string>> = {
  "inter.woff2": "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
  "mono-400.woff2": "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2",
  "mono-500.woff2": "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2",
  "mono-600.woff2": "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-600-normal.woff2",
  "maplibre-gl.mjs": "maplibre-gl/dist/maplibre-gl.mjs",
  "maplibre-gl-worker.mjs": "maplibre-gl/dist/maplibre-gl-worker.mjs",
  "maplibre-gl.css": "maplibre-gl/dist/maplibre-gl.css",
};

/** Where the build puts them, relative to the compiled `dist/home/`. */
export const HOME_ASSETS_DIR = "../home-assets";
