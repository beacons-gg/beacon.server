/**
 * The home page's stylesheet and script, served from memory at `/_home/home.css` and
 * `/_home/home.js` so the page needs no inline style or script (the CSP forbids both).
 */

/** The palette the operator console shares, and the page's layout. */
export const HOME_CSS = `
@font-face{font-family:Inter;font-style:normal;font-weight:100 900;font-display:swap;src:url(/_home/inter.woff2) format("woff2")}
@font-face{font-family:"JetBrains Mono";font-style:normal;font-weight:400;font-display:swap;src:url(/_home/mono-400.woff2) format("woff2")}
@font-face{font-family:"JetBrains Mono";font-style:normal;font-weight:500;font-display:swap;src:url(/_home/mono-500.woff2) format("woff2")}
@font-face{font-family:"JetBrains Mono";font-style:normal;font-weight:600;font-display:swap;src:url(/_home/mono-600.woff2) format("woff2")}
:root{--page:#08080a;--panel:#0e0e11;--surface:#131316;--surface-2:#1a1a1f;--line:#212126;--line-2:#2d2d33;--cell:#1b1b20;--ink:#ececef;--ink-2:#9b9ba3;--ink-3:#7e7e87;--gold:#f5b942;--ok:#3fcf73;--err:#f2554f;--sans:Inter,ui-sans-serif,system-ui,sans-serif;--mono:"JetBrains Mono",ui-monospace,"SFMono-Regular",monospace;color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;background:var(--page);color:var(--ink);font:13px/1.45 var(--sans);font-feature-settings:"tnum";-webkit-font-smoothing:antialiased}
a{color:inherit}
.mono,code{font-family:var(--mono)}
.mu{color:var(--ink-3)}.i2{color:var(--ink-2)}.ok{color:var(--ok)}.err{color:var(--err)}.gold{color:var(--gold)}
.grow{flex:1}
.frame{padding:10px;max-width:1320px;margin:0 auto}
.panel{display:block;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.top{display:flex;align-items:center;gap:10px;min-height:56px;padding:8px 20px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.mark{display:flex;align-items:center;gap:10px;text-decoration:none}
.mark svg{display:block}
.word{display:block;font:600 17px/1 var(--mono);letter-spacing:-.01em}
.cursor{display:inline-block;width:8px;height:15px;margin-left:3px;vertical-align:-2px;background:var(--gold);animation:blink 1.1s steps(1) 4}
.sub{display:block;margin-top:5px;font:400 11px/1 var(--mono);color:var(--ink-3)}
@keyframes blink{50%{opacity:0}}
@media (prefers-reduced-motion:reduce){.cursor{animation:none}}
.tag{display:inline-flex;align-items:center;gap:6px;min-height:22px;padding:1px 7px;border:1px solid var(--line-2);border-radius:4px;font:500 11px var(--mono);color:var(--ink-2)}
.tag i{width:7px;height:7px;background:currentColor;flex:none}
.tag.ok{color:var(--ok)}.tag.err{color:var(--err)}.tag.gold{color:var(--gold)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border-radius:6px;border:1px solid var(--line-2);background:var(--panel);color:var(--ink);font:500 12.5px var(--sans);text-decoration:none;cursor:pointer;white-space:nowrap}
.btn:hover{background:var(--surface-2)}
.btn.primary{background:var(--ink);color:#0b0b0d;border-color:var(--ink)}
.btn.primary:hover{background:#d6d6da}
.btn:focus-visible,a:focus-visible,.linkish:focus-visible{outline:2px solid var(--ink-2);outline-offset:2px}
.kicker{margin:0 0 8px;font:500 10.5px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3)}
.hero{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:32px;padding:30px;border-bottom:1px solid var(--line)}
h1{margin:0;font-size:30px;font-weight:600;letter-spacing:-.02em;overflow-wrap:anywhere}
.lead{max-width:640px;margin:8px 0 22px;color:var(--ink-2);font-size:14px}
.addr{display:flex;align-items:center;gap:10px;max-width:640px;padding:10px 12px;border:1px solid var(--line-2);border-radius:8px;background:var(--surface)}
.addr code{flex:1;min-width:0;font-size:17px;font-weight:500;overflow-wrap:anywhere}
.hint{max-width:640px;margin:14px 0 0;color:var(--ink-2);font-size:12.5px}
.hint b{color:var(--ink);font-weight:500}
.qr{margin:0;padding:16px;border:1px solid var(--line);border-radius:10px;background:var(--surface);text-align:center;align-self:start}
.qr-box{display:inline-block;padding:10px;border-radius:6px;background:#ececef;line-height:0}
.qr-box svg{width:200px;height:200px}
.qr figcaption{display:flex;flex-direction:column;gap:4px;margin-top:12px;font-size:11px}
.qr figcaption .kicker{margin:0}
.stats{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;margin:0;border-bottom:1px solid var(--line)}
.stat{padding:16px 30px;border-right:1px solid var(--line)}
.stat:last-child{border-right:0}
.stat dt{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--ink-2)}
.glyph{width:12px;height:12px;border:1.5px solid var(--ink-3);border-radius:3px}
.stat dd{margin:0}
.stat .v{margin:8px 0 3px;font-size:26px;font-weight:500;letter-spacing:-.03em;line-height:1.15}
.stat .v.mono{font-size:22px}
.stat .n{font-size:11.5px;color:var(--ink-3);overflow-wrap:anywhere}
.body{display:grid;grid-template-columns:1fr 1fr}
.pane{min-width:0;padding:20px 30px;border-right:1px solid var(--line)}
.pane:last-child{border-right:0}
h2{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin:0 0 12px;font-size:14px;font-weight:600}
h2 span{font-size:11.5px;font-weight:400;color:var(--ink-3)}
h2.gap{margin-top:24px}
.map{height:300px;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--cell)}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.note{margin:10px 0 0;font-size:12px;color:var(--ink-3)}
.caps{list-style:none;margin:0;padding:0}
.caps li{display:grid;grid-template-columns:130px 1fr;gap:10px;align-items:center;padding:7px 0;border-top:1px solid var(--line)}
.caps li:first-child{border-top:0}
.rows{margin:0}
.rows div{display:grid;grid-template-columns:110px minmax(0,1fr);gap:10px;padding:8px 0;border-top:1px solid var(--line)}
.rows div:first-child{border-top:0}
.rows dt{color:var(--ink-3)}
.rows dd{margin:0;overflow-wrap:anywhere}
.rows .mono{font-size:12px}
.linkish{padding:0;border:0;background:none;color:inherit;font:inherit;cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px}
.foot{display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center;padding:14px 30px;border-top:1px solid var(--line);font:400 11.5px var(--mono);color:var(--ink-3)}
.foot a{color:var(--ink-2)}
.show-sm{display:none}
.maplibregl-ctrl-group{background:var(--surface-2)!important;border:1px solid var(--line-2)}
.maplibregl-ctrl-icon{filter:invert(1)}
.maplibregl-ctrl-attrib{background:rgba(8,8,10,.7)!important;color:var(--ink-3)!important}
.maplibregl-ctrl-attrib a{color:var(--ink-2)!important}
@media (max-width:860px){
  .frame{padding:0}.panel{border:0;border-radius:0}
  .top{padding:8px 14px}.hide-sm{display:none}.show-sm{display:inline}
  .hero{grid-template-columns:1fr;gap:20px;padding:20px 16px}
  h1{font-size:24px}
  .addr{flex-direction:column;align-items:stretch}
  .stats{grid-auto-flow:row;grid-template-columns:1fr 1fr}
  .stat{padding:12px 16px;border-bottom:1px solid var(--line)}
  .stat:nth-child(2n){border-right:0}
  .body{grid-template-columns:1fr}
  .pane{padding:18px 16px;border-right:0;border-bottom:1px solid var(--line)}
  .caps li{grid-template-columns:124px 1fr}
  .foot{padding:14px 16px}
}
`;

/**
 * The page's behaviour, none of which it needs to be read: copy buttons, the status refreshed from
 * `/health/ready` every 30 seconds while the tab is shown, and the coverage map. The map is the one
 * thing the page loads from elsewhere (the tiles, in the visitor's browser, never the server), and
 * it is drawn only when the operator left it on.
 */
export const HOME_JS = `
const data = JSON.parse(document.getElementById("home-data").textContent);

for (const button of document.querySelectorAll("[data-copy]")) {
  // The label is taken once: a second click inside the second and a half would otherwise keep
  // "Copied" as the label to go back to.
  const label = button.textContent;
  button.addEventListener("click", async () => {
    const value = button.getAttribute("data-copy");
    try {
      await navigator.clipboard.writeText(value);
      button.textContent = "Copied";
    } catch {
      window.prompt("Copy this:", value);
      return;
    }
    setTimeout(() => { button.textContent = label; }, 1500);
  });
}

// The contact is not in the page: a click reads it from the signed descriptor, so it is there for a
// person who asks and not for a scraper reading HTML. It goes in as text, a link only when it is
// plainly an email or an http(s) address.
const showContact = document.getElementById("show-contact");
showContact?.addEventListener("click", async () => {
  showContact.disabled = true;
  let contact = "";
  try {
    contact = String((await (await fetch("/server/descriptor", { cache: "no-store" })).json()).contact ?? "").trim();
  } catch {}
  const cell = document.getElementById("contact");
  if (!contact) {
    showContact.disabled = false;
    showContact.textContent = "Could not load it; try again";
    return;
  }
  const href = /^[^\\s@<>"]+@[^\\s@<>"]+\\.[^\\s@<>"]+$/.test(contact)
    ? "mailto:" + contact
    : /^https?:\\/\\/[^\\s<>"]+$/i.test(contact) ? contact : "";
  const node = document.createElement(href ? "a" : "span");
  node.textContent = contact;
  if (href) { node.href = href; node.rel = "nofollow noopener"; }
  cell.replaceChildren(node);
});

const status = document.getElementById("status");
const statusText = document.getElementById("status-text");
async function refresh() {
  if (document.hidden) return;
  let ready = false;
  try { ready = (await fetch("/health/ready", { cache: "no-store" })).ok; } catch {}
  status.classList.toggle("ok", ready);
  status.classList.toggle("err", !ready);
  if (!ready) statusText.textContent = "not ready";
  else if (statusText.textContent === "not ready") statusText.textContent = "ready";
}
setInterval(refresh, 30000);
document.addEventListener("visibilitychange", refresh);

if (data.tiles && document.getElementById("map")) {
  // The library finds its worker beside itself, under the same version: no worker URL is set here,
  // so a cached worker of another release can never meet this one.
  const maplibregl = await import(data.maplibre);
  const features = data.bounds.map(([w, s, e, n]) => ({
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
  }));
  const all = data.bounds.reduce((b, [w, s, e, n]) => [Math.min(b[0], w), Math.min(b[1], s), Math.max(b[2], e), Math.max(b[3], n)], [180, 90, -180, -90]);
  const map = new maplibregl.Map({
    container: "map",
    attributionControl: { compact: true },
    style: {
      version: 8,
      sources: { tiles: { type: "raster", tiles: [data.tiles], tileSize: 256, maxzoom: 19, attribution: data.attribution } },
      layers: [{ id: "tiles", type: "raster", source: "tiles", paint: { "raster-brightness-min": 0.92, "raster-brightness-max": 0.04, "raster-saturation": -1, "raster-contrast": 0.1 } }],
    },
    bounds: data.everywhere ? [[-170, -60], [170, 75]] : [[all[0], all[1]], [all[2], all[3]]],
    fitBoundsOptions: { padding: 24, maxZoom: 9 },
    renderWorldCopies: false,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  // The map is made before the grid around it settles (fonts, the two columns); MapLibre follows
  // only the window's size, so the container's own is watched, or a part of the canvas stays blank.
  new ResizeObserver(() => map.resize()).observe(document.getElementById("map"));
  map.on("load", () => {
    map.addSource("coverage", { type: "geojson", data: { type: "FeatureCollection", features } });
    map.addLayer({ id: "coverage-fill", type: "fill", source: "coverage", paint: { "fill-color": "#f5b942", "fill-opacity": data.everywhere ? 0.06 : 0.22 } });
    map.addLayer({ id: "coverage-line", type: "line", source: "coverage", paint: { "line-color": "#f5b942", "line-opacity": 0.85, "line-width": 1.5 } });
  });
}
`;
