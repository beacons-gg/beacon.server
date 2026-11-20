import { assetUrl } from "./home.files";
import type { HomeView } from "./home.view";
import { towerSvg } from "./tower";

/**
 * The home page's HTML, in the operator console's look: one dark mode, the pixel tower, mono for
 * machine values, colour only for state. Every operator-supplied string is escaped here; the page
 * carries no inline script or style, so the Content-Security-Policy the controller sets can forbid
 * both.
 */

/** Escape text for HTML content and double-quoted attributes. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const ACCESS: Record<string, { title: string; note: string }> = {
  open: { title: "Open", note: "anyone can play here" },
  request: { title: "By request", note: "ask the operator to join" },
  private: { title: "Private", note: "by invitation only" },
};

/**
 * Who the map's tiles come from, for its attribution: OpenStreetMap's own words for theirs (their
 * licence asks for it), and the host for any other, since most tile services ask to be named.
 */
export function tileAttribution(tiles: string): string {
  const host = new URL(tiles.replace(/\{[zxy]\}/g, "0")).hostname;
  return host.endsWith("openstreetmap.org") ? "© OpenStreetMap contributors" : `Tiles: ${host}`;
}

/** "3d 4h", "5h 12m", "8m": how long the process has been up, as the console says it. */
export function uptime(startedAt: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(startedAt)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** A DID shortened for the eye, the full value kept for copying. */
function shortKey(key: string): string {
  return key.length > 28 ? `${key.slice(0, 16)}…${key.slice(-6)}` : key;
}

function stat(label: string, value: string, note: string, extra = ""): string {
  return `<div class="stat"><dt><span class="glyph" aria-hidden="true"></span>${label}</dt><dd class="v ${extra}">${value}</dd><dd class="n">${note}</dd></div>`;
}

export function renderHome(view: HomeView, now = new Date()): string {
  const e = escapeHtml;
  const access = ACCESS[view.accessLevel] ?? { title: view.accessLevel, note: "" };
  const listed = view.accessLevel === "open";
  const description =
    view.description ?? "A Beacon server: rooms, places and players for the games that use it.";
  const everywhere = view.coverage.length === 1 && view.coverage[0] === "";
  const data = JSON.stringify({
    bounds: view.coverageBounds,
    tiles: view.mapTiles ?? null,
    attribution: view.mapTiles ? tileAttribution(view.mapTiles) : "",
    maplibre: assetUrl("maplibre-gl.mjs"),
    everywhere,
  }).replaceAll("<", "\\u003c");
  const games =
    view.games.length === 0
      ? { value: "Any", note: "every game is welcome" }
      : { value: String(view.games.length), note: view.games.map(e).join(", ") };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(view.name)} · Beacon server</title>
<meta name="description" content="${e(description)}">
${listed ? "" : '<meta name="robots" content="noindex, nofollow">\n'}<meta property="og:type" content="website">
<meta property="og:site_name" content="Beacon">
<meta property="og:title" content="${e(view.name)}">
<meta property="og:description" content="${e(description)}">
<meta property="og:url" content="${e(view.origin)}/">
<meta name="theme-color" content="#08080a">
<link rel="icon" href="${assetUrl("icon.svg")}" type="image/svg+xml">
<link rel="stylesheet" href="${assetUrl("home.css")}">
${view.mapTiles ? `<link rel="stylesheet" href="${assetUrl("maplibre-gl.css")}">\n` : ""}</head>
<body>
<div class="frame"><main class="panel">
<header class="top">
  <a class="mark" href="/">${towerSvg()}<span><span class="word">beacon<span class="cursor" aria-hidden="true"></span></span><span class="sub">~/server</span></span></a>
  <span class="grow"></span>
  <span class="tag ${view.ready ? "ok" : "err"}" id="status"><i></i><span id="status-text">${view.ready ? `ready · up ${uptime(view.startedAt, now)}` : "not ready"}</span></span>
  ${view.aboutUrl ? `<a class="btn hide-sm" href="${e(view.aboutUrl)}" rel="noopener">About Beacon servers</a>` : ""}
  ${view.docsPath ? `<a class="btn hide-sm" href="${e(view.docsPath)}">API docs</a>` : ""}
  ${view.consoleLink ? `<a class="btn hide-sm" href="${e(view.consoleLink)}" rel="noopener">Open in the console →</a>` : ""}
</header>

<section class="hero">
  <div>
    <p class="kicker">beacon server</p>
    <h1>${e(view.name)}</h1>
    <p class="lead">${e(description)}</p>
    <p class="kicker">server address · add it in your game</p>
    <div class="addr"><code id="address">${e(view.origin)}</code><button class="btn primary" type="button" id="copy" data-copy="${e(view.origin)}">Copy address</button></div>
    <p class="hint">In a Beacon game, open <b>Servers</b>, then <b>Add a server</b>, and paste the address. Or scan the code with your phone to open this page there.</p>
  </div>
  <figure class="qr">
    <div class="qr-box" role="img" aria-label="QR code for ${e(view.origin)}">${view.qrSvg}</div>
    <figcaption><span class="kicker">scan to add</span><span class="mono mu">${e(view.hostLabel)}</span></figcaption>
  </figure>
</section>

<dl class="stats">
  ${stat("Status", view.ready ? "ready" : "not ready", `up since ${e(view.startedAt.slice(0, 10))}`, `mono ${view.ready ? "ok" : "err"}`)}
  ${stat("Access", e(access.title), e(access.note))}
  ${stat("Games", games.value, games.note)}
  ${
    view.rooms
      ? stat(
          "Rooms",
          view.rooms.total.toLocaleString("en"),
          `${view.rooms.changedThisMonth.toLocaleString("en")} changed in the last 30 days`,
        )
      : stat("Server release", e(view.version), "Beacon server", "mono")
  }
  ${view.places !== undefined ? stat("Places", view.places.toLocaleString("en"), "parks, landmarks and more, for games to use") : ""}
</dl>

<div class="body">
  <section class="pane">
    <h2>Coverage <span>${everywhere ? "everywhere" : "where this server serves"}</span></h2>
    ${view.mapTiles ? '<div id="map" class="map" role="img" aria-label="Map of the area this server covers"></div>' : ""}
    <div class="tags">${everywhere ? '<span class="tag gold">everywhere</span>' : view.coverage.map((c) => `<span class="tag gold">${e(c)}</span>`).join("")}</div>
    <p class="note">${everywhere ? "This server takes rooms and places anywhere in the world." : "Rooms, places and challenges in these areas live on this server. The codes are geohash prefixes."}</p>
  </section>
  <section class="pane">
    <h2>What it offers <span>from its signed descriptor</span></h2>
    <ul class="caps">${view.capabilities
      .map(
        (c) =>
          `<li><span class="tag ${c.on ? "ok" : ""}"><i></i>${e(c.id)}</span><span class="${c.on ? "i2" : "mu"}">${c.on ? e(c.label) : "Off"}</span></li>`,
      )
      .join("")}</ul>
    <h2 class="gap">Operator</h2>
    <dl class="rows">
      ${view.hasContact ? '<div><dt>Contact</dt><dd id="contact"><button type="button" class="linkish" id="show-contact">Show contact</button></dd></div>' : ""}
      <div><dt>Signing key</dt><dd class="mono"><button type="button" class="linkish" data-copy="${e(view.key)}" title="${e(view.key)} (click to copy)">${e(shortKey(view.key))}</button></dd></div>
      <div><dt>Descriptor</dt><dd class="mono"><a href="/server/descriptor">/server/descriptor</a> <span class="mu">signed, verifiable</span></dd></div>
      ${view.rooms ? `<div><dt>Release</dt><dd class="mono">${e(view.version)}</dd></div>` : ""}
    </dl>
  </section>
</div>

<footer class="foot">
  <span>Beacon server ${e(view.version)}</span>
  ${view.sourceUrl ? `<a href="${e(view.sourceUrl)}" rel="noopener">Source code</a>` : ""}
  <a href="/health/ready">/health/ready</a>
  ${view.docsPath ? `<a href="${e(view.docsPath)}">${e(view.docsPath)}</a>` : ""}
  ${view.aboutUrl ? `<a class="show-sm" href="${e(view.aboutUrl)}" rel="noopener">About Beacon servers</a>` : ""}
  ${view.consoleLink ? `<a class="show-sm" href="${e(view.consoleLink)}" rel="noopener">Open in the console</a>` : ""}
  <span class="grow"></span>
  ${view.siteUrl ? `<a href="${e(view.siteUrl)}" rel="noopener">Part of the Beacon Server Network</a>` : ""}
</footer>
</main></div>
<script type="application/json" id="home-data">${data}</script>
<script type="module" src="${assetUrl("home.js")}"></script>
</body>
</html>
`;
}
