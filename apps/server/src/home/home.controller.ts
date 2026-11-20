import { Controller, Get, Inject, Param, Query, Req, Res, UseGuards } from "@nestjs/common";
import { notFound } from "../common/capability-http";
import { HomeRateLimitGuard } from "../common/read-rate-limit.guard";
import type { ServerConfig } from "../config";
import { SERVER_CONFIG } from "../settings/live-config";
import { HOME_FILES } from "./home.files";
import { renderHome } from "./home.render";
import { HomeService } from "./home.service";
import { servesPage, type PageRequest } from "./negotiate";

/** The slice of an Express response the controller uses (no `express` type dep). */
interface HttpResponse {
  setHeader(name: string, value: string): void;
  send(body: string | Buffer): void;
}

/**
 * The policy the page is served under: nothing inline, scripts, styles and fonts from this server,
 * and the map's tiles from their own origin, the one place the page reaches beyond this server.
 * MapLibre styles its canvas and controls through the DOM, which a policy does not restrict, so no
 * `'unsafe-inline'` is needed for it.
 */
export function contentSecurityPolicy(mapTiles: string | undefined): string {
  const tiles = mapTiles ? ` ${new URL(mapTiles.replace(/\{[zxy]\}/g, "0")).origin}` : "";
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    // `data:` for MapLibre's control icons; `blob:` for tiles a browser decodes as blobs.
    `img-src 'self' data: blob:${tiles}`,
    `connect-src 'self'${tiles}`,
    "worker-src 'self' blob:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * The server's home page: `GET /` for a browser (or a chat's link preview) shows what this server
 * is, how to add it to a game (its address as text and a QR code) and where it serves, on a map.
 * On by default, off with `BEACON_HOME=off`; anything else at `/` gets the `404 unknownRoute` of a
 * path no route serves.
 */
@Controller()
export class HomeController {
  constructor(
    private readonly home: HomeService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  @Get()
  @UseGuards(HomeRateLimitGuard)
  async page(@Req() req: PageRequest, @Res() res: HttpResponse): Promise<void> {
    // The answer at `/` depends on who asks: a cache between must keep the page and the 404 apart.
    res.setHeader("Vary", "Accept, User-Agent");
    if (!this.config.homeEnabled || !servesPage(req)) notFound("Cannot GET /");
    const html = renderHome(await this.home.view());
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Security-Policy", contentSecurityPolicy(this.config.homeMapTiles));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    // The tile servers want to know which site their tiles are for (OpenStreetMap's usage policy
    // requires it); the page's address is all a request from it can say, and that is public.
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.send(html);
  }

  @Get("_home/:file")
  @UseGuards(HomeRateLimitGuard)
  asset(
    @Param("file") name: string,
    @Query("v") version: string | undefined,
    @Req() req: PageRequest,
    @Res() res: HttpResponse,
  ): void {
    const file = this.config.homeEnabled ? HOME_FILES.get(name) : undefined;
    if (!file) notFound(`Cannot GET /_home/${name}`);
    const gzip = file.gzip && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
    res.setHeader("Content-Type", file.type);
    res.setHeader("ETag", `"${file.hash}${gzip ? "-gz" : ""}"`);
    res.setHeader("Vary", "Accept-Encoding");
    // The page links every file under its content hash, so that address never changes meaning;
    // an address without one (MapLibre finding its worker, a hand-typed URL) is kept for a day.
    res.setHeader(
      "Cache-Control",
      version === file.hash ? "public, max-age=31536000, immutable" : "public, max-age=86400",
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (gzip) res.setHeader("Content-Encoding", "gzip");
    res.send(gzip ? file.gzip! : file.body);
  }
}
