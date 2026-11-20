/**
 * The response-time downgrade: a code newer than its caller is sent as the one that caller already
 * handles, through the real Nest pipeline, because a filter is only as real as its registration. No
 * other test here boots Nest; this one does, on an ephemeral port.
 */
import "reflect-metadata";
import { UNDERSTANDS_HEADER, type ErrorCode } from "@beaconsgg/protocol-types";
import { CODE_FALLBACKS, NOT_FOUND_FALLBACKS } from "@beaconsgg/protocol-types/server";
import {
  Body,
  Controller,
  Get,
  HttpException,
  Module,
  Param,
  Post,
  type INestApplication,
} from "@nestjs/common";
import { APP_FILTER, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { badRequest, missing, type MissingCode } from "../common/capability-http";
import { UnderstandsFilter } from "../common/understands.filter";
import { statusForError } from "../rooms/http-status";

@Controller()
class RefusingController {
  @Get("revoked")
  revoked(): never {
    throw new HttpException(
      { ok: false, error: "deviceRevoked", message: "device revoked" },
      statusForError("deviceRevoked"),
    );
  }

  @Get("blocked")
  blocked(): never {
    throw new HttpException({ ok: false, error: "denied", message: "actor not admitted" }, 403);
  }

  @Get("plain")
  plain(): never {
    throw new HttpException("not an object body", 418);
  }

  @Get("room")
  room(): never {
    throw new HttpException({ ok: false, error: "unknownRoom" }, 404);
  }

  @Get("place")
  place(): never {
    missing("unknownPlace", "no active place has that `unique`");
  }

  /** A proposal's 400 `unknownPlace`, which every client has always been sent. */
  @Get("proposed")
  proposed(): never {
    badRequest("no active place with that `unique`", "unknownPlace");
  }

  /** A proposal's 400 `unknownMedia`, the other 404 code that is also a 400. */
  @Get("proposed-media")
  proposedMedia(): never {
    badRequest("no media with that hash", "unknownMedia");
  }

  /** Each 404 code that names what is missing, by name. */
  @Get("missing/:code")
  missingCode(@Param("code") code: MissingCode): never {
    missing(code, "not here");
  }

  /** A newer code at 404, which falls back as it would at any other status. */
  @Get("revoked-404")
  revoked404(): never {
    throw new HttpException({ ok: false, error: "deviceRevoked" }, 404);
  }

  @Post("echo")
  echo(@Body() body: unknown): unknown {
    return body;
  }
}

@Module({
  controllers: [RefusingController],
  providers: [{ provide: APP_FILTER, useClass: UnderstandsFilter }],
})
class RefusingModule {}

let app: INestApplication;
let base: string;

beforeAll(async () => {
  const nest = await NestFactory.create<NestExpressApplication>(RefusingModule, { logger: false });
  nest.useBodyParser("json", { limit: 64 });
  app = nest;
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
});
afterAll(() => app.close());

describe("UnderstandsFilter, through Nest", () => {
  const get = (path: string, understands?: string) =>
    fetch(`${base}${path}`, understands ? { headers: { [UNDERSTANDS_HEADER]: understands } } : {});

  it("sends an app that predates `deviceRevoked` the `denied` it already handles, at the same status", async () => {
    const res = await get("/revoked");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "denied", message: "device revoked" });
  });

  it("sends the new code to an app that declared it", async () => {
    const res = await get("/revoked", "code:clockSkew, code:deviceRevoked");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "deviceRevoked" });
  });

  it("leaves a baseline code alone, and Nest's own handling of anything else", async () => {
    expect(await (await get("/blocked")).json()).toMatchObject({ error: "denied" });
    const plain = await get("/plain");
    expect(plain.status).toBe(418);
    expect(await plain.json()).toEqual({ statusCode: 418, message: "not an object body" });
  });
});

describe("a 404 that names what is missing, through Nest", () => {
  const get = (path: string, understands?: string) =>
    fetch(`${base}${path}`, understands ? { headers: { [UNDERSTANDS_HEADER]: understands } } : {});

  it("is `unknownRoute` to a client that has not declared the code, as every 404 was before", async () => {
    const res = await get("/place");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      ok: false,
      error: "unknownRoute",
      message: "no active place has that `unique`",
    });
  });

  it("is the code itself to a client that declared it", async () => {
    const res = await get("/place", "code:unknownPlace");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "unknownPlace" });
  });

  it("leaves the same code alone at 400, where it has always gone to every client", async () => {
    const res = await get("/proposed");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unknownPlace" });
  });

  it("sends each of the five codes only to a client that declared it, as server#104 shipped", async () => {
    for (const code of Object.keys(NOT_FOUND_FALLBACKS)) {
      const fallback = await get(`/missing/${code}`);
      expect(fallback.status, code).toBe(404);
      expect(await fallback.json(), code).toEqual({
        ok: false,
        error: "unknownRoute",
        message: "not here",
      });
      // Declaring another code, or the code at a different namespace, is not declaring this one.
      const other = await get(`/missing/${code}`, `code:unknownRoom, result:${code}`);
      expect(await other.json(), code).toMatchObject({ error: "unknownRoute" });
      const declared = await get(`/missing/${code}`, `code:${code}`);
      expect(declared.status, code).toBe(404);
      expect(await declared.json(), code).toMatchObject({ error: code });
    }
  });

  it("leaves `unknownMedia` alone at 400 too", async () => {
    const res = await get("/proposed-media");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unknownMedia" });
  });

  it("still applies `CODE_FALLBACKS` at 404", async () => {
    expect(await (await get("/revoked-404")).json()).toMatchObject({ error: "denied" });
    expect(await (await get("/revoked-404", "code:deviceRevoked")).json()).toMatchObject({
      error: "deviceRevoked",
    });
  });

  it("takes the five codes and their fallback from core's `NOT_FOUND_FALLBACKS`", () => {
    // The codes and the fallback server#104 shipped. A change in core shows up here first.
    expect(NOT_FOUND_FALLBACKS).toEqual({
      unknownPlace: "unknownRoute",
      unknownMedia: "unknownRoute",
      unknownProposal: "unknownRoute",
      unknownRun: "unknownRoute",
      noAbout: "unknownRoute",
    });
    // At 404 only: none of them falls back at another status.
    for (const code of Object.keys(NOT_FOUND_FALLBACKS)) {
      expect(Object.keys(CODE_FALLBACKS)).not.toContain(code);
    }
  });
});

describe("the framework's own answers, through Nest", () => {
  const post = (
    body: string,
    headers: Record<string, string> = { "content-type": "application/json" },
  ) => fetch(`${base}/echo`, { method: "POST", headers, body });

  // A client reads a 4xx without the refusal body as a fault it may retry (core 0.4's `isFault`).
  it("answers a body over the parser's limit 413 tooLarge", async () => {
    const res = await post(JSON.stringify({ blob: "x".repeat(100) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      ok: false,
      error: "tooLarge",
      message: "request entity too large",
    });
  });

  it("answers a body that is not JSON 400 invalid", async () => {
    const res = await post("{not json");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid" });
  });

  it("answers a charset or an encoding the parser does not take 415 invalid", async () => {
    for (const headers of [
      { "content-type": "application/json; charset=latin1" },
      { "content-type": "application/json", "content-encoding": "x-unknown" },
    ]) {
      const res = await post("{}", headers);
      expect(res.status).toBe(415);
      expect(await res.json()).toMatchObject({ ok: false, error: "invalid" });
    }
  });

  it("answers a path no route serves 404 unknownRoute", async () => {
    for (const [method, path] of [
      ["GET", "/nowhere"],
      ["POST", "/rooms/x/nothing"],
      ["DELETE", "/echo"],
    ] as const) {
      const res = await fetch(`${base}${path}`, { method });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await res.json()).toEqual({
        ok: false,
        error: "unknownRoute",
        message: `Cannot ${method} ${path}`,
      });
    }
  });

  it("leaves a route's own 404 refusal and a body within the limit alone", async () => {
    const room = await fetch(`${base}/room`);
    expect(room.status).toBe(404);
    expect(await room.json()).toEqual({ ok: false, error: "unknownRoom" });
    const echoed = await post(JSON.stringify({ a: 1 }));
    expect(echoed.status).toBe(201);
    expect(await echoed.json()).toEqual({ a: 1 });
  });
});

describe("the fallback table and the status table agree", () => {
  it.each(Object.entries(CODE_FALLBACKS))(
    "%s goes out at the same status as its fallback %s",
    (code, fallback) => {
      // The filter rewrites the body and keeps the status; a mismatch here would send an older app
      // a code it knows at a status it has never seen that code arrive with.
      expect(statusForError(code as ErrorCode)).toBe(statusForError(fallback));
    },
  );
});

describe("the server registers it", () => {
  it("as a global filter on the app module", async () => {
    const { AppModule } = await import("../app.module");
    const providers = Reflect.getMetadata("providers", AppModule) as unknown[];
    expect(providers).toContainEqual({ provide: APP_FILTER, useClass: UnderstandsFilter });
  });
});
