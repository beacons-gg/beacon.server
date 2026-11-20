import { HttpException } from "@nestjs/common";
import { beforeEach, describe, expect, it } from "vitest";
import { AboutController } from "../about/about.controller";
import { MAX_ABOUT_LENGTH } from "../config";
import { PROCESS_STARTED_AT } from "../server-identity";
import { runtimeSettingsFrom, SETTING_SPECS } from "../settings/registry";
import { SettingsService } from "../settings/settings.service";
import { MemorySettingsStore } from "./memory-stores";
import { testConfig } from "./test-config";

/**
 * `BEACON_ABOUT` and `GET /server/about`: the operator's long description, Markdown, served
 * unsigned beside the descriptor. A live setting like the descriptor's text fields, with the same
 * length rule at boot and at an admin write.
 */

const ADMIN = "did:key:zAdmin";

async function serviceWith(
  env: NodeJS.ProcessEnv = {},
  now?: () => number,
): Promise<SettingsService> {
  const svc = new SettingsService(
    new MemorySettingsStore(),
    runtimeSettingsFrom(testConfig(env)),
    now,
  );
  await svc.load();
  return svc;
}

/** The 404 body a route throws, or undefined when it answered. */
function refusal(fn: () => unknown): { status: number; body: unknown } | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    if (!(err instanceof HttpException)) throw err;
    return { status: err.getStatus(), body: err.getResponse() };
  }
}

describe("the about setting", () => {
  const schema = SETTING_SPECS.about.schema;

  it("takes Markdown up to the cap, or nothing", () => {
    expect(schema.safeParse("# Night walks\n\n- [Rules](https://example.org)").success).toBe(true);
    expect(schema.safeParse(undefined).success).toBe(true);
    expect(schema.safeParse("x".repeat(MAX_ABOUT_LENGTH)).success).toBe(true);
  });

  it("refuses text over the cap and anything that is not text", () => {
    expect(schema.safeParse("x".repeat(MAX_ABOUT_LENGTH + 1)).success).toBe(false);
    expect(schema.safeParse(42).success).toBe(false);
    expect(schema.safeParse(["a"]).success).toBe(false);
  });

  it("is read from BEACON_ABOUT at boot, kept as written apart from trailing whitespace", () => {
    const text = "# Night walks\n\n  Indented line\n";
    expect(testConfig({ BEACON_ABOUT: text }).about).toBe("# Night walks\n\n  Indented line");
    expect(testConfig({}).about).toBeUndefined();
    expect(testConfig({ BEACON_ABOUT: "   \n" }).about).toBeUndefined();
  });

  it("refuses to boot with an over-long BEACON_ABOUT, naming the variable", () => {
    expect(() => testConfig({ BEACON_ABOUT: "x".repeat(MAX_ABOUT_LENGTH + 1) })).toThrow(
      /BEACON_ABOUT.*at most 8192/,
    );
  });
});

describe("GET /server/about", () => {
  let now = 0;
  beforeEach(() => {
    now = Date.parse("2026-10-26T12:00:00.000Z");
  });

  it("answers 404 noAbout when the server has no about text", async () => {
    const controller = new AboutController(await serviceWith());
    const r = refusal(() => controller.about());
    expect(r?.status).toBe(404);
    // `noAbout` to a caller that declares it; the understands filter sends `unknownRoute` otherwise.
    expect(r?.body).toMatchObject({ ok: false, error: "noAbout" });
  });

  it("answers the environment's text with the process start as its time", async () => {
    const controller = new AboutController(
      await serviceWith({ BEACON_ABOUT: "Hello **players**." }),
    );
    expect(controller.about()).toEqual({
      about: "Hello **players**.",
      updated: PROCESS_STARTED_AT,
    });
  });

  it("changes at once when an admin writes it, and goes back to 404 when an admin clears it", async () => {
    const settings = await serviceWith({}, () => now);
    const controller = new AboutController(settings);

    await settings.set("about", "## Events\n\nMost Fridays.", ADMIN);
    expect(controller.about()).toEqual({
      about: "## Events\n\nMost Fridays.",
      updated: "2026-10-26T12:00:00.000Z",
    });

    now += 60_000;
    await settings.set("about", "", ADMIN);
    expect(refusal(() => controller.about())?.status).toBe(404);
  });

  it("refuses an admin write over the cap and keeps the text it had", async () => {
    const settings = await serviceWith({ BEACON_ABOUT: "Kept." });
    await expect(settings.set("about", "x".repeat(MAX_ABOUT_LENGTH + 1), ADMIN)).rejects.toThrow();
    expect(new AboutController(settings).about().about).toBe("Kept.");
  });
});
