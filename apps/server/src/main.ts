import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { describeClientKey } from "./common/client-key";
import { corsOriginOption, jsonBodyLimit, loadConfig, type ServerConfig } from "./config";
import { setupDocs } from "./docs/docs.setup";
import { SERVER_CONFIG } from "./settings/live-config";
import { OriginCheckedIoAdapter } from "./ws.adapter";

/**
 * Production bootstrap for the server. Wires the operational hardening: structured logging (Nest's
 * `Logger`), CORS + WS origin allow-list from `BEACON_CORS_ORIGINS`, graceful shutdown
 * (`enableShutdownHooks` lets `StoreModule` end the DB pool), and a trust-proxy hint so the rate
 * limiter sees the real client IP behind a load balancer.
 */
const logger = new Logger("Bootstrap");

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  if (process.env["BEACON_DB_PATH"]) {
    // Left over from an older .env: harmless beside a URL, but the operator should know.
    logger.warn(
      "BEACON_DB_PATH is set but no longer read: SQLite was removed, and the server runs on BEACON_DATABASE_URL.",
    );
  }

  // CORS: `*` admits any origin, an empty list none, a list those (REST and WS alike).
  const corsOrigin = corsOriginOption(config.corsOrigins);
  if (corsOrigin === true) {
    logger.warn(
      "BEACON_CORS_ORIGINS is * : allowing every origin (REST + WS). Set it to your client " +
        "origin(s) before exposing this server publicly.",
    );
  }
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    cors: { origin: corsOrigin, credentials: true },
  });

  // Sized from the media limit unconditionally: `mediaEnabled` is a runtime setting now, so deciding
  // the parser's size from its boot value would leave an operator who turns media on with a ceiling
  // that refuses every upload before MediaService can answer. `jsonBodyLimit` is shared with the
  // clamp in settings/live-config.ts so the two cannot disagree about what fits.
  app.useBodyParser("json", { limit: jsonBodyLimit(config.mediaMaxBytes) });

  // The WS live/map channel is gated by the same allow-list as REST.
  app.useWebSocketAdapter(new OriginCheckedIoAdapter(app, corsOrigin, config.publicUrl));

  // Behind a load balancer, honor X-Forwarded-* so the rate limiter keys off the real client IP.
  // Configured hop-count (default false = trust none): `true` (trust-all) would make req.ip the
  // client-controlled leftmost XFF and defeat the limiter — set BEACON_TRUST_PROXY=1 behind one proxy.
  const http = app.getHttpAdapter().getInstance() as { set?: (k: string, v: unknown) => void };
  http.set?.("trust proxy", config.trustProxy);

  // Graceful shutdown: drain the store (StoreModule.beforeApplicationShutdown) on SIGTERM/SIGINT.
  app.enableShutdownHooks();

  // OpenAPI spec + Swagger UI, opt-in via BEACON_DOCS (off by default).
  const docsBase = setupDocs(app, config);

  await app.listen(config.port);
  logger.log(
    `Beacon server listening on :${config.port} ` +
      // The live config's: a restored server's name is not the one in BEACON_HOST.
      `(host=${app.get<ServerConfig>(SERVER_CONFIG).host}, ` +
      `cors=${corsOrigin === true ? "*" : corsOrigin === false ? "none" : corsOrigin.join(",")}, ` +
      // Named at boot on purpose: every limiter keys on `req.ip`, so a wrong `BEACON_TRUST_PROXY`
      // is visible here rather than only in a breach log nobody triggers (doc/deploy.md).
      `clientKey=${describeClientKey(config.trustProxy, process.env["BEACON_TRUST_PROXY"])}` +
      `${docsBase ? `, docs=${docsBase}` : ""})`,
  );
}

// A failed boot (no BEACON_DATABASE_URL, an invalid variable, a port in use) logs and exits
// non-zero. The process never listened, so /health/ready cannot report it; the exit code is what
// an orchestrator sees.
bootstrap().catch((err: unknown) => {
  // The message only: a config refusal is one line an operator can act on, and a failure inside
  // Nest's own boot has already been logged by Nest, stack and all.
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
