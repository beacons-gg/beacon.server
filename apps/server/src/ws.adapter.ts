import type { INestApplicationContext } from "@nestjs/common";
import { IoAdapter } from "@nestjs/platform-socket.io";
import type { Server, ServerOptions } from "socket.io";

/**
 * Whether a live-channel handshake may proceed, by its `Origin` header. A request with none is not
 * from a browser page (a game's native client, a test driver) and proceeds, as it does over REST.
 * A page on the server's own origin proceeds too, as a same-origin REST request needs no CORS.
 * Otherwise the origin must be allowed by the CORS option (config.ts `corsOriginOption`).
 */
export function originAllowed(
  origin: string | undefined,
  allowed: boolean | string[],
  ownOrigin: string,
): boolean {
  if (origin === undefined || allowed === true || origin === ownOrigin) return true;
  return Array.isArray(allowed) && allowed.includes(origin);
}

/**
 * A socket.io adapter that applies the configured **CORS + WS origin allow-list** to the live-channel
 * handshake. `origin` is the CORS option REST uses (config.ts `corsOriginOption`): `true` admits any
 * origin, `false` none, a list those. CORS headers
 * alone do not gate a WebSocket (a browser applies no CORS to one), so the handshake itself is
 * refused for an origin that is not allowed ({@link originAllowed}). The map/live fan-out can't be
 * driven from an unlisted web origin.
 */
export class OriginCheckedIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly origin: boolean | string[],
    private readonly publicUrl: string,
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    // URL.canParse keeps a malformed BEACON_PUBLIC_URL from failing here; it then matches nothing.
    const ownOrigin = URL.canParse(this.publicUrl) ? new URL(this.publicUrl).origin : "";
    const gated: Partial<ServerOptions> = {
      ...options,
      cors: { origin: this.origin, credentials: true },
      allowRequest: (req, callback) =>
        callback(null, originAllowed(req.headers.origin, this.origin, ownOrigin)),
    };
    return super.createIOServer(port, gated) as Server;
  }
}
