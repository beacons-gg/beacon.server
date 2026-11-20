// @beaconsgg/image-encode — [S] server-only, and operator-side too.
//
// The WebP re-encode profile behind Cartographer's media crawl. It became a package when the Beacon
// server's place-image ingestor was its second caller (an app never imports an app); that ingestor was
// retired in 27d69d8, so this could fold back into Cartographer.

export * from "./encode";
