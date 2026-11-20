import type { NestExpressApplication } from "@nestjs/platform-express";
import swaggerUi from "swagger-ui-express";
import type { ServerConfig } from "../config";
import { serverOpenApiDocument } from "./openapi";

/** The slice of the Express instance we register the docs routes on (avoids an `express` type dep). */
interface ExpressLike {
  get(path: string, handler: (req: unknown, res: { json(body: unknown): void }) => void): void;
  use(path: string, ...handlers: unknown[]): void;
}

/**
 * Mount Swagger UI + the raw OpenAPI JSON when `BEACON_DOCS` is on (off by default). Registered on the
 * underlying Express instance (not a Nest controller) so the UI's static assets serve without a module,
 * and gated purely by config so a production server exposes no docs unless the operator opts in.
 * Same-origin, so the CORS allow-list doesn't gate the UI itself. Returns the mounted base path (or
 * `undefined` when disabled) for the boot log.
 */
export function setupDocs(app: NestExpressApplication, config: ServerConfig): string | undefined {
  if (!config.docsEnabled) return undefined;
  const document = serverOpenApiDocument(config);
  const base = `/${config.docsPath}`;
  const http = app.getHttpAdapter().getInstance() as ExpressLike;
  // Raw spec first (handy for codegen / external viewers), then the UI at the base path.
  http.get(`${base}/openapi.json`, (_req, res) => res.json(document));
  http.use(
    base,
    swaggerUi.serve,
    swaggerUi.setup(document, { customSiteTitle: `${config.name} API` }),
  );
  return base;
}
