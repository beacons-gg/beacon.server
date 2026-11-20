/**
 * Env parsing for operational/diagnostic knobs read straight from `process.env` — deliberately
 * outside the zod `ServerConfig` schema (e.g. the `BEACON_*_DEBUG` toggles and rate-limit knobs),
 * so a throwaway flag doesn't need schema plumbing. Shared by the rate-limit guard and the WS gateway.
 */

/**
 * Whether a switch's value is on: `on`, or `1` / `true` / `yes` (trimmed, case-insensitive).
 * Anything else, `off` included, is off. Every switch reads through this.
 */
export function isOn(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "on" || v === "1" || v === "true" || v === "yes";
}

/** A switch read straight from `process.env` ({@link isOn}). */
export function boolEnv(key: string): boolean {
  return isOn(process.env[key]);
}

/** A positive-integer env knob, falling back when unset/empty/non-finite/≤0. */
export function intEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** A comma-separated value as a trimmed, non-empty list (empty when unset). */
export function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** A comma-separated env var read straight from `process.env` ({@link csv}). */
export function csvEnv(key: string): string[] {
  return csv(process.env[key]);
}
