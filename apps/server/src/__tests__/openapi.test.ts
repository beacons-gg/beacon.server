import "reflect-metadata";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HANDLERS } from "@beaconsgg/policy-engine";
import { RequestMethod } from "@nestjs/common";
import { GUARDS_METADATA, HTTP_CODE_METADATA } from "@nestjs/common/constants";
import { describe, expect, it } from "vitest";
import * as protocolTypes from "@beaconsgg/protocol-types";
import { NOT_FOUND_FALLBACKS } from "@beaconsgg/protocol-types/server";
import { opsOf, SIGNED_ROUTES, type SignedOp, type SignedPath } from "../common/signed-routes";
import { ALLOW_WHILE_LOCKED } from "../common/write-lock.guard";
import {
  openApiPath,
  operationId,
  paramsComponent,
  REFUSAL_CODES,
  serverOpenApiDocument,
} from "../docs/openapi";
import { APP_CONTROLLERS, type MountedRoute, mountedRoutes } from "./routes";
import { testConfig } from "./test-config";

const doc = serverOpenApiDocument(
  testConfig({
    BEACON_NAME: "Test Beacon",
    BEACON_VERSION: "9.9.9",
    BEACON_PUBLIC_URL: "https://api.example",
  } as NodeJS.ProcessEnv),
);

/** Every route the app mounts. */
const MOUNTED: MountedRoute[] = APP_CONTROLLERS.flatMap((controller) => mountedRoutes(controller));

/** The one POST that is signed but carries no op envelope: a profile doc is signed by its account. */
const UNSIGNED_POSTS = ["profiles"];

interface Operation {
  requestBody?: unknown;
  parameters?: unknown[];
  responses?: Record<string, unknown>;
}

/** A response, read through its `$ref` when it is a shared one. */
function resolved(response: unknown): unknown {
  const target = (response as { $ref?: string }).$ref;
  return target === undefined ? response : doc.components.responses[target.split("/").pop()!];
}

/** The documented operation for a mounted route. */
function operation({ method, path }: MountedRoute): Operation | undefined {
  const ops = doc.paths[openApiPath(path)] as Record<string, Operation> | undefined;
  return ops?.[RequestMethod[method].toLowerCase()];
}

describe("the OpenAPI spec generated from the zod wire schemas", () => {
  it("is an OpenAPI 3.1 document with info + server drawn from config", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("Test Beacon");
    expect(doc.info.version).toBe("9.9.9");
    expect(doc.servers?.[0]?.url).toBe("https://api.example");
  });

  it("documents every route the app mounts, except the home page", () => {
    // The home page is HTML for a browser, not API.
    const api = MOUNTED.filter(({ method, path }) => {
      return !(method === RequestMethod.GET && /^(_home\/.*)?$/.test(path));
    });
    expect(api.length).toBeGreaterThan(40);
    expect(
      api.filter((route) => operation(route) === undefined).map((route) => route.path),
    ).toEqual([]);
  });

  it("documents the status a POST answers with: Nest's 201 unless the handler sets its own", () => {
    const wrong = MOUNTED.filter((route) => route.method === RequestMethod.POST).flatMap(
      (route) => {
        const code = String(
          (Reflect.getMetadata(HTTP_CODE_METADATA, route.handler) as number | undefined) ?? 201,
        );
        const success = Object.keys(operation(route)?.responses ?? {}).filter((c) =>
          c.startsWith("2"),
        );
        return success.length === 1 && success[0] === code
          ? []
          : [`${route.path}: ${success.join(",")}`];
      },
    );
    expect(wrong).toEqual([]);
  });

  it("documents 503 on exactly the POSTs the write lock refuses", () => {
    const wrong = MOUNTED.filter((route) => route.method === RequestMethod.POST).flatMap(
      (route) => {
        const allowed = Reflect.getMetadata(ALLOW_WHILE_LOCKED, route.handler) === true;
        const documented = operation(route)?.responses?.["503"] !== undefined;
        return allowed === documented ? [route.path] : [];
      },
    );
    expect(wrong).toEqual([]);
  });

  it("documents 429 on exactly the routes with a rate-limit guard", () => {
    const wrong = MOUNTED.filter((route) => operation(route) !== undefined).flatMap((route) => {
      const guards = (Reflect.getMetadata(GUARDS_METADATA, route.handler) ?? []) as Array<{
        name: string;
      }>;
      const limited = guards.some((guard) => guard.name.endsWith("RateLimitGuard"));
      const documented = operation(route)?.responses?.["429"] !== undefined;
      return limited === documented ? [] : [route.path];
    });
    expect(wrong).toEqual([]);
  });

  it("registers the core + location schema components from the zod contract", () => {
    const schemas = Object.keys(doc.components?.schemas ?? {});
    for (const s of [
      "OpEnvelope",
      "Room",
      "OkResult",
      "ServerDescriptor",
      "DiscoveryResponse",
      "GeocodeResult",
      "PlaceSummary",
      "PlaceDetail",
      "PlacesQueryResult",
      "PlaceSnapshot",
      "Refusal",
    ]) {
      expect(schemas).toContain(s);
    }
  });

  it("references the location result schemas from their endpoint responses (no drift)", () => {
    expect(JSON.stringify(doc.paths?.["/geocode"])).toContain("#/components/schemas/GeocodeResult");
    expect(JSON.stringify(doc.paths?.["/places"])).toContain(
      "#/components/schemas/PlacesQueryResult",
    );
    expect(JSON.stringify(doc.paths?.["/places/{unique}"])).toContain(
      "#/components/schemas/PlaceDetail",
    );
  });

  it("exposes the location endpoints' query parameters", () => {
    expect(JSON.stringify(doc.paths?.["/geocode"])).toContain('"name":"geohash"');
    expect(JSON.stringify(doc.paths?.["/places"])).toContain('"name":"cells"');
    expect(JSON.stringify(doc.paths?.["/places"])).toContain('"name":"categories"');
  });

  it("answers every refusal with the Refusal schema", () => {
    const stray = Object.entries(doc.paths).flatMap(([path, ops]) =>
      Object.values(ops as Record<string, Operation>).flatMap((op) =>
        Object.entries(op.responses ?? {})
          .filter(([status]) => status.startsWith("4") || status.startsWith("5"))
          .filter(([, response]) => !JSON.stringify(resolved(response)).includes("Refusal"))
          .map(([status]) => `${path} ${status}`),
      ),
    );
    // The readiness probe answers its own `{ status, error }`, for an orchestrator.
    expect(stray).toEqual(["/health/ready 503"]);
  });
});

describe("the signed-route table", () => {
  it("names every signed POST the app mounts, and nothing it does not mount", () => {
    const posts = MOUNTED.filter((route) => route.method === RequestMethod.POST)
      .map((route) => route.path)
      .filter((path) => !UNSIGNED_POSTS.includes(path))
      .sort();
    expect(Object.keys(SIGNED_ROUTES).sort()).toEqual(posts);
  });

  it("gives each signed route's request the table's op names and params schemas", () => {
    for (const path of Object.keys(SIGNED_ROUTES) as SignedPath[]) {
      const documented = JSON.stringify(
        operation({ method: RequestMethod.POST, path, handler: {} }),
      );
      for (const op of opsOf(path)) {
        expect(documented, path).toContain(`"${op.op}"`);
        if (op.params) {
          expect(documented, path).toContain(`#/components/schemas/${paramsComponent(op)}"`);
        }
      }
    }
  });

  it("names each params component as core names the schema, so the spec and the SDK agree", () => {
    for (const op of Object.values(SIGNED_ROUTES).flat() as SignedOp[]) {
      if (op.params === undefined) continue;
      const component = paramsComponent(op);
      const coreName = `${component.charAt(0).toLowerCase()}${component.slice(1)}Schema`;
      const core = (protocolTypes as Record<string, unknown>)[coreName];
      expect(core, `${op.op}: ${coreName}`).toBe(op.params);
    }
  });

  // Core 0.4.3 left the Atlas preview's `versionUrl` open with `.max(Infinity)`, which JSON writes as
  // `null`, and the generator dropped it. Core 1.0 writes no such bound; a release that brings one
  // back fails here.
  it("writes no bound JSON Schema refuses, such as an open `.max(Infinity)`'s `null`", () => {
    expect(JSON.stringify(doc)).not.toMatch(
      /"(maxLength|minLength|maximum|minimum|exclusiveMaximum|exclusiveMinimum|maxItems|minItems)":null/,
    );
  });

  it("lists the room engine's op names for room ops, with params left to the policy", () => {
    const body = JSON.stringify(doc.paths["/rooms/{id}/ops"]);
    for (const name of Object.keys(HANDLERS)) expect(body).toContain(`"${name}"`);
  });
});

describe("the Refusal schema's error codes", () => {
  it("names every code the server's HTTP routes refuse with", () => {
    const root = join(__dirname, "..");
    const files = (readdirSync(root, { recursive: true }) as string[]).filter(
      (file) =>
        file.endsWith(".ts") &&
        !file.includes("__tests__") &&
        // A gateway answers in a socket ack, not over HTTP.
        !file.endsWith(".gateway.ts"),
    );
    const sent = new Set<string>();
    for (const file of files) {
      const source = readFileSync(join(root, file), "utf8");
      // `error: "code"` in a refusal body, a code passed to a refusal helper, and a proposal's
      // rejection, which `rejectProposal` sends as the code.
      for (const match of source.matchAll(
        /error: "(\w+)"|(?:badRequest|conflict|denied|rateLimited|refusal)\([^;]*?,\s*"(\w+)"\s*[,)]|ProposeError\(\{ reason: "(\w+)"|missing\("(\w+)"/g,
      )) {
        sent.add((match[1] ?? match[2] ?? match[3] ?? match[4])!);
      }
    }
    // The codes most likely to drift, each sent in a different way.
    for (const code of [
      "writeLocked",
      "replayed",
      "tooManyPending",
      "hashMismatch",
      "unknownRun",
    ]) {
      expect(sent, code).toContain(code);
    }
    expect([...sent].filter((code) => REFUSAL_CODES[code] === undefined)).toEqual([]);
    for (const code of Object.keys(NOT_FOUND_FALLBACKS)) {
      expect(REFUSAL_CODES[code], code).toBeDefined();
    }
  });

  it("leaves the list open, so a generated client reads a newer server's code as a refusal", () => {
    const refusal = doc.components.schemas["Refusal"] as {
      properties: { error: { type?: string; enum?: unknown; description?: string } };
    };
    expect(refusal.properties.error.type).toBe("string");
    expect(refusal.properties.error.enum).toBeUndefined();
    expect(refusal.properties.error.description).toContain("a newer server may add codes");
  });
});

describe("operation ids", () => {
  const operations = Object.entries(doc.paths).flatMap(([path, ops]) =>
    Object.entries(ops as Record<string, { operationId?: string }>).map(([method, op]) => ({
      path,
      method,
      id: op.operationId,
    })),
  );

  it("names every operation from its method and path, each name once", () => {
    expect(operations.length).toBeGreaterThan(40);
    for (const { path, method, id } of operations) {
      expect(id, `${method} ${path}`).toBe(operationId(method, path));
    }
    const ids = operations.map((op) => op.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reads as a method and the path's words", () => {
    expect(operationId("get", "/rooms/{id}")).toBe("getRoomsById");
    expect(operationId("post", "/places/admin/atlas/upload")).toBe("postPlacesAdminAtlasUpload");
    expect(operationId("get", "/health/ready")).toBe("getHealthReady");
  });
});
