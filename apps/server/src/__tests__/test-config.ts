import { loadConfig, type ServerConfig } from "../config";

/**
 * A DSN for a config that is parsed and never connected. `loadConfig` refuses to run without
 * `BEACON_DATABASE_URL`, and most suites are about everything but the database.
 */
const UNUSED_DATABASE_URL = "postgres://unused@127.0.0.1:1/unused";

/** {@link loadConfig} over `env`, with {@link UNUSED_DATABASE_URL} unless `env` names its own. */
export function testConfig(env: NodeJS.ProcessEnv = {}): ServerConfig {
  return loadConfig({ BEACON_DATABASE_URL: UNUSED_DATABASE_URL, ...env });
}
