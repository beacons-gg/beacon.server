import { describe, expect, it, vi } from "vitest";
import { DEFAULT_HOME_MAP_TILES, DEFAULT_SOURCE_URL } from "../config";
import type { HttpException } from "@nestjs/common";
import { HomeRateLimitGuard } from "../common/read-rate-limit.guard";
import { contentSecurityPolicy, HomeController } from "../home/home.controller";
import { assetUrl, HOME_FILES } from "../home/home.files";
import { isUnfurler, servesPage, wantsHtml } from "../home/negotiate";
import { escapeHtml, renderHome, tileAttribution, uptime } from "../home/home.render";
import { HomeService, COUNTS_TTL_MS, roomActivityOf } from "../home/home.service";
import { boundsOf, buildHomeView, consoleLinkFor, gamesOf, statsShown } from "../home/home.view";
import type { HomeView } from "../home/home.view";
import type { DescriptorFacts } from "../server-identity";
import { testConfig } from "./test-config";
import { rejectedWith } from "./test-helpers";

/**
 * The home page a browser gets at `GET /`: what this server is, how to add it, where it serves.
 * Its settings, the view it is built from, the HTML (escaping above all: name, description and
 * contact are the operator's free text), the routing that keeps every non-browser caller on the
 * 404 it always had, and the service's caching.
 */

const FACTS: DescriptorFacts = {
  host: "xbq6.beacons.gg",
  key: "did:key:z6MkiFjJXkXp1THdHCUkmXQ5EqDzY6jHz5qQi9qfGJgR6s9n",
  coverage: ["c22", "9q8"],
  name: "Rookery West",
  description: "Weekly challenges.",
  contact: "ops@rookery.example",
  version: "0.1.2",
  startedAt: "2026-10-20T09:14:00.000Z",
  accessLevel: "open",
  capabilities: ["mailbox", "places", "policy:ops.games", "game:kites"],
};

function view(over: Partial<HomeView> = {}): HomeView {
  return {
    ...buildHomeView({
      facts: FACTS,
      config: testConfig({ BEACON_PUBLIC_URL: "https://xbq6.beacons.gg/" }),
      ready: true,
      rooms: { total: 12, changedThisMonth: 3 },
      places: 340,
      qrSvg: "<svg data-qr></svg>",
    }),
    ...over,
  };
}

describe("home page settings", () => {
  it("is on by default, linking the hosted console and beacons.gg, drawing OpenStreetMap", () => {
    const c = testConfig({});
    expect(c.homeEnabled).toBe(true);
    expect(c.homeStats).toBe("auto");
    expect(c.homeConsoleUrl).toBe("https://console.beacons.gg");
    expect(c.homeSiteUrl).toBe("https://beacons.gg");
    expect(c.homeMapTiles).toBe(DEFAULT_HOME_MAP_TILES);
  });

  it("turns each part off, takes overrides, and refuses a value that is not a URL", () => {
    const c = testConfig({
      BEACON_HOME: "off",
      BEACON_HOME_STATS: "false",
      BEACON_HOME_CONSOLE_URL: "https://console.example.com/",
      BEACON_HOME_SITE_URL: "off",
      BEACON_HOME_MAP_TILES: "",
    });
    expect(c.homeEnabled).toBe(false);
    expect(c.homeStats).toBe("off");
    expect(testConfig({ BEACON_HOME_STATS: "on" }).homeStats).toBe("on");
    expect(c.homeConsoleUrl).toBe("https://console.example.com");
    expect(c.homeSiteUrl).toBeUndefined();
    expect(c.homeMapTiles).toBeUndefined();
    expect(() => testConfig({ BEACON_HOME_SITE_URL: "beacons.gg" })).toThrow(
      /BEACON_HOME_SITE_URL/,
    );
    expect(() => testConfig({ BEACON_HOME_MAP_TILES: "ftp://tiles/{z}/{x}/{y}" })).toThrow(
      /BEACON_HOME_MAP_TILES/,
    );
  });

  it("links the public repository unless set, and then only an https URL", () => {
    expect(DEFAULT_SOURCE_URL).toBe("https://github.com/beacons-gg/beacon.server");
    expect(testConfig({}).sourceUrl).toBe(DEFAULT_SOURCE_URL);
    expect(testConfig({ BEACON_SOURCE_URL: "  " }).sourceUrl).toBe(DEFAULT_SOURCE_URL);
    expect(testConfig({ BEACON_SOURCE_URL: " https://git.example.com/fork/ " }).sourceUrl).toBe(
      "https://git.example.com/fork",
    );
    for (const bad of ["off", "git.example.com", "http://git.example.com/fork"]) {
      expect(() => testConfig({ BEACON_SOURCE_URL: bad })).toThrow(
        `Invalid BEACON_SOURCE_URL: ${JSON.stringify(bad)} (an https URL, or unset)`,
      );
    }
  });
});

describe("the home view", () => {
  it("reads the descriptor's facts and the address a game adds", () => {
    const v = view();
    expect(v.origin).toBe("https://xbq6.beacons.gg");
    expect(v.hostLabel).toBe("xbq6.beacons.gg");
    expect(v.games).toEqual(["kites"]);
    expect(v.capabilities.filter((c) => c.on).map((c) => c.id)).toEqual(["mailbox", "places"]);
    expect(v.consoleLink).toBe(
      "https://console.beacons.gg/servers?add=https%3A%2F%2Fxbq6.beacons.gg",
    );
    expect(v.rooms).toEqual({ total: 12, changedThisMonth: 3 });
    expect(v.places).toBe(340);
  });

  it("says a contact exists without carrying it, so the page holds no address to scrape", () => {
    expect(view().hasContact).toBe(true);
    const html = renderHome(view());
    expect(html).not.toContain("ops@rookery.example");
    expect(html).toContain('id="show-contact"');
    expect(renderHome(view({ hasContact: false }))).not.toContain("show-contact");
  });

  it("draws the empty prefix as the world and a prefix as its cell", () => {
    expect(boundsOf([""])).toEqual([[-180, -85, 180, 85]]);
    const [[w, s, e, n]] = boundsOf(["9q8"]) as [[number, number, number, number]];
    expect(w).toBeLessThan(e);
    expect(s).toBeLessThan(n);
    expect(w).toBeCloseTo(-123.75, 2);
  });

  it("names no games when every game is welcome, and no console when the link is off", () => {
    expect(gamesOf(["policy:ops.games", "mailbox"])).toEqual([]);
    expect(consoleLinkFor(undefined, "https://a")).toBeUndefined();
  });

  it("shows the room counts on an open server, hides them on a closed one, and does as told", () => {
    expect(statsShown("auto", "open")).toBe(true);
    expect(statsShown("auto", "private")).toBe(false);
    expect(statsShown("on", "private")).toBe(true);
    expect(statsShown("off", "open")).toBe(false);
  });

  it("leaves the room counts out when the operator turned them off", () => {
    const v = buildHomeView({
      facts: FACTS,
      config: testConfig({ BEACON_HOME_STATS: "off" }),
      ready: true,
      rooms: { total: 1, changedThisMonth: 1 },
      places: 9,
      qrSvg: "",
    });
    expect(v.rooms).toBeUndefined();
    expect(v.places).toBeUndefined();
    // Nor does a server that does not serve places show a count of them.
    const noPlaces = buildHomeView({
      facts: { ...FACTS, capabilities: ["mailbox"] },
      config: testConfig({}),
      ready: true,
      rooms: undefined,
      places: 9,
      qrSvg: "",
    });
    expect(noPlaces.places).toBeUndefined();
  });
});

describe("the home page's HTML", () => {
  it("escapes the operator's text everywhere it lands", () => {
    const html = renderHome(
      view({
        name: '<script>alert("n")</script>',
        description: "a & b <img src=x onerror=1>",
      }),
    );
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(&quot;n&quot;)&lt;/script&gt;");
    expect(html).toContain("a &amp; b &lt;img src=x onerror=1&gt;");
    expect(escapeHtml(`'`)).toBe("&#39;");
  });

  it("keeps the map's data out of reach of a closing script tag", () => {
    const html = renderHome(view({ mapTiles: "https://t.example/{z}/{x}/{y}.png?</script>" }));
    const data = html.slice(
      html.indexOf('id="home-data">'),
      html.indexOf("</script>", html.indexOf('id="home-data">')),
    );
    expect(data).not.toContain("</script");
    expect(data).toContain("\\u003c/script>");
  });

  it("carries the address, the QR code, the counts and every link the operator left on", () => {
    const html = renderHome(view(), new Date("2026-10-23T13:14:00Z"));
    expect(html).toContain('data-copy="https://xbq6.beacons.gg"');
    expect(html).toContain("<svg data-qr></svg>");
    expect(html).toContain("3 changed in the last 30 days");
    expect(html).toContain("ready · up 3d 4h");
    expect(html).toContain("https://console.beacons.gg/servers?add=");
    expect(html).toContain(
      '<a href="https://beacons.gg" rel="noopener">Part of the Beacon Server Network</a>',
    );
    expect(html).toContain(
      'href="https://beacons.gg/docs" rel="noopener">About Beacon servers</a>',
    );
    expect(html).toContain(`<a href="${DEFAULT_SOURCE_URL}" rel="noopener">Source code</a>`);
    expect(renderHome(view({ sourceUrl: "https://git.example.com/fork?a=1&b=2" }))).toContain(
      '<a href="https://git.example.com/fork?a=1&amp;b=2" rel="noopener">Source code</a>',
    );
    expect(html).toContain('id="map"');
    expect(html).not.toContain("noindex");
  });

  it("drops what the operator turned off, and asks search engines to pass a server that is not open", () => {
    const html = renderHome(
      view({
        consoleLink: undefined,
        siteUrl: undefined,
        aboutUrl: undefined,
        mapTiles: undefined,
        rooms: undefined,
        accessLevel: "private",
        ready: false,
      }),
    );
    expect(html).not.toContain("console.beacons.gg");
    expect(html).not.toContain('href="https://beacons.gg"');
    expect(html).not.toContain("About Beacon servers");
    expect(html).not.toContain('id="map"');
    expect(html).not.toContain("maplibre-gl.css");
    expect(html).not.toContain("changed in the last 30 days");
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain("Private");
    expect(html).toContain("not ready");
  });

  it("says how long the server has been up the way the console does", () => {
    const at = "2026-10-23T00:00:00Z";
    expect(uptime(at, new Date("2026-10-23T00:08:30Z"))).toBe("8m");
    expect(uptime(at, new Date("2026-10-23T05:12:00Z"))).toBe("5h 12m");
    expect(uptime(at, new Date("2026-10-26T04:00:00Z"))).toBe("3d 4h");
  });
});

/** A response that records what the controller did with it. */
function response() {
  const sent: { headers: Record<string, string>; body: unknown } = { headers: {}, body: undefined };
  const res = {
    setHeader(name: string, value: string) {
      sent.headers[name] = value;
    },
    send(body: unknown) {
      sent.body = body;
    },
  };
  return { res, sent };
}

describe("HomeController", () => {
  const service = { view: () => Promise.resolve(view()) } as unknown as HomeService;
  const browser = { headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" } };

  it("serves the page to a browser, under a policy that allows only this server and the tiles", async () => {
    const controller = new HomeController(service, testConfig({}));
    const { res, sent } = response();
    await controller.page(browser, res);
    expect(String(sent.body)).toContain("<title>Rookery West · Beacon server</title>");
    const csp = sent.headers["Content-Security-Policy"]!;
    expect(csp).toContain("img-src 'self' data: blob: https://tile.openstreetmap.org");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(sent.headers["Cache-Control"]).toBe("no-store");
    expect(sent.headers["Vary"]).toBe("Accept, User-Agent");
    // OpenStreetMap's tile policy wants the site named; no-referrer gets its "access blocked" tiles.
    expect(sent.headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("serves a chat's link preview, which asks for anything, so the card shows the server", async () => {
    const { res, sent } = response();
    await new HomeController(service, testConfig({})).page(
      { headers: { accept: "*/*", "user-agent": "Mozilla/5.0 (compatible; Discordbot/2.0)" } },
      res,
    );
    expect(String(sent.body)).toContain('property="og:title" content="Rookery West"');
  });

  it("answers anything else, and everyone while the page is off, with the 404 of a path no route serves", async () => {
    for (const [config, accept] of [
      [testConfig({}), "application/json"],
      [testConfig({}), "*/*"],
      [testConfig({}), undefined],
      [testConfig({}), "text/html;q=0, */*"],
      [testConfig({ BEACON_HOME: "off" }), "text/html"],
    ] as const) {
      const { res } = response();
      const refused = new HomeController(service, config).page({ headers: { accept } }, res);
      expectUnknownRoute(await rejectedWith(() => refused), "Cannot GET /");
    }
  });

  it("serves every file it names, versioned ones for good, and gzips text for a client that takes it", () => {
    const controller = new HomeController(service, testConfig({}));
    expect([...HOME_FILES.keys()].sort()).toEqual([
      "home.css",
      "home.js",
      "icon.svg",
      "inter.woff2",
      "maplibre-gl-worker.mjs",
      "maplibre-gl.css",
      "maplibre-gl.mjs",
      "mono-400.woff2",
      "mono-500.woff2",
      "mono-600.woff2",
    ]);
    for (const [name, file] of HOME_FILES) {
      expect(file.body.length, name).toBeGreaterThan(0);
      const { res, sent } = response();
      controller.asset(name, file.hash, { headers: { "accept-encoding": "gzip, br" } }, res);
      expect(sent.headers["Cache-Control"], name).toBe("public, max-age=31536000, immutable");
      expect(sent.headers["Content-Encoding"], name).toBe(
        name.endsWith(".woff2") ? undefined : "gzip",
      );
    }
    const { res, sent } = response();
    controller.asset("home.js", undefined, { headers: {} }, res);
    expect(sent.headers["Cache-Control"]).toBe("public, max-age=86400");
    expect(sent.body).toBe(HOME_FILES.get("home.js")!.body);
  });

  it("links the fonts and files under their content hashes, and the map library by its own", () => {
    const css = HOME_FILES.get("home.css")!.body.toString();
    expect(css).toContain(`/_home/inter.woff2?v=${HOME_FILES.get("inter.woff2")!.hash}`);
    expect(assetUrl("home.js")).toBe(`/_home/home.js?v=${HOME_FILES.get("home.js")!.hash}`);
    const html = renderHome(view());
    expect(html).toContain(assetUrl("home.css"));
    expect(html).toContain(JSON.stringify(assetUrl("maplibre-gl.mjs")));
    // MapLibre finds its worker beside itself under its own version: the page never sets one.
    expect(HOME_FILES.get("home.js")!.body.toString()).not.toContain("setWorkerUrl");
  });

  it("refuses names it does not serve, a prototype key among them", async () => {
    const controller = new HomeController(service, testConfig({}));
    for (const name of ["toString", "__proto__", "../package.json", "home.ts"]) {
      const err = await rejectedWith(() =>
        controller.asset(name, undefined, { headers: {} }, response().res),
      );
      expectUnknownRoute(err, `Cannot GET /_home/${name}`);
    }
    const off = new HomeController(service, testConfig({ BEACON_HOME: "off" }));
    const err = await rejectedWith(() =>
      off.asset("home.css", undefined, { headers: {} }, response().res),
    );
    expectUnknownRoute(err, "Cannot GET /_home/home.css");
  });
});

describe("who gets the page", () => {
  it("is whoever names HTML, unless they refuse it with q=0", () => {
    expect(wantsHtml("text/html")).toBe(true);
    expect(wantsHtml(["application/json", "text/html;q=0.9"])).toBe(true);
    expect(wantsHtml("text/html; q=0")).toBe(false);
    expect(wantsHtml("application/json")).toBe(false);
    expect(wantsHtml("*/*")).toBe(false);
  });

  it("includes the link previews of the chats an address gets pasted into", () => {
    expect(isUnfurler("Slackbot-LinkExpanding 1.0")).toBe(true);
    expect(isUnfurler("TelegramBot (like TwitterBot)")).toBe(true);
    expect(isUnfurler("curl/8.5.0")).toBe(false);
    expect(
      servesPage({ headers: { accept: "*/*", "user-agent": "facebookexternalhit/1.1" } }),
    ).toBe(true);
  });

  it("leaves a probe at / that is not for the page outside the page's rate limit", () => {
    const guard = new HomeRateLimitGuard();
    const at = (path: string, headers: Record<string, string>) =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ path, headers, ip: "203.0.113.9" }) }),
      }) as never;
    for (let i = 0; i < 400; i++) expect(guard.canActivate(at("/", { accept: "*/*" }))).toBe(true);
    let refused = 0;
    for (let i = 0; i < 400; i++) {
      try {
        guard.canActivate(at("/", { accept: "text/html" }));
      } catch {
        refused += 1;
      }
    }
    expect(refused).toBe(100);
  });

  it("names a tile service other than OpenStreetMap by its host", () => {
    expect(tileAttribution(DEFAULT_HOME_MAP_TILES)).toBe("© OpenStreetMap contributors");
    expect(tileAttribution("https://tiles.example.com/{z}/{x}/{y}.png")).toBe(
      "Tiles: tiles.example.com",
    );
    expect(contentSecurityPolicy(undefined)).toContain("connect-src 'self';");
  });
});

describe("HomeService", () => {
  const ready = { getRoom: () => Promise.resolve(undefined) };

  it("reuses the room counts for a minute, then counts again", async () => {
    let now = Date.parse("2026-10-23T12:00:00Z");
    const rooms = {
      countRooms: vi.fn(() => Promise.resolve(5)),
      countRoomsTouchedSince: vi.fn(() => Promise.resolve(2)),
    };
    const service = new HomeService(testConfig({}), () => FACTS, ready, { rooms, now: () => now });
    expect((await service.view()).rooms).toEqual({ total: 5, changedThisMonth: 2 });
    expect(rooms.countRoomsTouchedSince).toHaveBeenCalledWith(now / 1000 - 30 * 86_400);
    await service.view();
    expect(rooms.countRooms).toHaveBeenCalledTimes(1);
    now += COUNTS_TTL_MS;
    await service.view();
    expect(rooms.countRooms).toHaveBeenCalledTimes(2);
  });

  it("still renders when the store is down or cannot count: not ready, and no counts", async () => {
    const down = { getRoom: () => Promise.reject(new Error("pool down")) };
    const failing = {
      countRooms: () => Promise.reject(new Error("no")),
      countRoomsTouchedSince: () => Promise.resolve(0),
    };
    const v = await new HomeService(testConfig({}), () => FACTS, down, {
      rooms: failing,
      placeCount: () => Promise.reject(new Error("no")),
    }).view();
    expect(v.ready).toBe(false);
    expect(v.rooms).toBeUndefined();
    expect(v.places).toBeUndefined();
    expect(v.qrSvg).toContain("<svg");
    expect(
      (await new HomeService(testConfig({}), () => FACTS, ready).view()).rooms,
    ).toBeUndefined();
  });

  it("runs one count for the views that ask while it is running", async () => {
    const count = vi.fn(() => Promise.resolve(7));
    const service = new HomeService(testConfig({}), () => FACTS, ready, { placeCount: count });
    const views = await Promise.all([service.view(), service.view(), service.view()]);
    expect(views.map((v) => v.places)).toEqual([7, 7, 7]);
    expect(count).toHaveBeenCalledTimes(1);
  });

  it("shows the active-place count, counted once a minute", async () => {
    let now = Date.parse("2026-10-23T12:00:00Z");
    const count = vi.fn(() => Promise.resolve(225_084));
    const service = new HomeService(testConfig({}), () => FACTS, ready, {
      placeCount: count,
      now: () => now,
    });
    expect((await service.view()).places).toBe(225_084);
    await service.view();
    expect(count).toHaveBeenCalledTimes(1);
    now += COUNTS_TTL_MS;
    await service.view();
    expect(count).toHaveBeenCalledTimes(2);
    expect(renderHome(await service.view())).toContain("225,084");
  });

  it("finds the room counts only on a store that has both", () => {
    expect(roomActivityOf({ countRooms() {}, countRoomsTouchedSince() {} })).toBeDefined();
    expect(roomActivityOf({ countRooms() {} })).toBeUndefined();
    expect(roomActivityOf(undefined)).toBeUndefined();
  });
});

/** The `404 unknownRoute` a path no route serves gets. */
function expectUnknownRoute(err: HttpException, message: string): void {
  expect(err.getStatus()).toBe(404);
  expect(err.getResponse()).toEqual({ ok: false, error: "unknownRoute", message });
}
