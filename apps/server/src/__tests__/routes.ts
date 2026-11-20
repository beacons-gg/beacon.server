import "reflect-metadata";
import { RequestMethod } from "@nestjs/common";
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from "@nestjs/common/constants";
import { AppModule } from "../app.module";

/** Every controller the app mounts, read from the module, so a new one is covered without a list. */
export const APP_CONTROLLERS = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AppModule) as Array<
  new (...args: never[]) => object
>;

/** One route a controller mounts: its method, its full path (no leading slash), and its handler. */
export interface MountedRoute {
  method: RequestMethod;
  path: string;
  handler: object;
}

/** Join a controller prefix and a handler path into the route as mounted. */
function fullPath(prefix: string, handler: string): string {
  return [prefix, handler]
    .flatMap((part) => part.split("/"))
    .filter((seg) => seg.length > 0)
    .join("/");
}

/** Every route a controller mounts, read from Nest's decorator metadata. */
export function mountedRoutes(controller: new (...args: never[]) => object): MountedRoute[] {
  const prefix = String(Reflect.getMetadata(PATH_METADATA, controller) ?? "");
  const proto = controller.prototype as Record<string, unknown>;
  const routes: MountedRoute[] = [];
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === "constructor") continue;
    const handler = proto[name];
    if (typeof handler !== "function") continue;
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
    if (method === undefined) continue;
    const path = String(Reflect.getMetadata(PATH_METADATA, handler) ?? "");
    routes.push({ method, path: fullPath(prefix, path), handler });
  }
  return routes;
}

/** The names of the guards a handler carries (`@UseGuards`), in order. */
export function guardNames(handler: object): string[] {
  const guards = (Reflect.getMetadata(GUARDS_METADATA, handler) ?? []) as Array<{ name?: string }>;
  return guards.map((guard) => guard?.name ?? String(guard));
}
