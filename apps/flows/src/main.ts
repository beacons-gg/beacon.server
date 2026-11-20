/**
 * `beacon-flows`: run the five flows against a server.
 *
 *   BEACON_FLOWS_SERVER=http://localhost:3001 beacon-flows
 *
 * Optional: BEACON_FLOWS_LOCK_SEC and BEACON_FLOWS_UNLOCK_SEC (the pot's windows, default 4 and 1),
 * BEACON_FLOWS_WAIT_MS (the deadline per awaited event, default 15000). Output is one line per flow,
 * `ok` or `FAIL`, with what happened.
 *
 * Exit codes: 0 every flow passed; 1 at least one flow failed (the lines say which); 2 the
 * environment is wrong; 3 the run could not start, since the server was unreachable or its
 * descriptor did not verify, so there is no flow to report.
 */
import { io } from "socket.io-client";
import { runFlows, type FlowsOptions } from "./driver";

export class UsageError extends Error {}

/** The options the environment names, checked; the rest take the driver's defaults. */
export function parseEnv(env: NodeJS.ProcessEnv): Omit<FlowsOptions, "connect"> {
  const server = env["BEACON_FLOWS_SERVER"];
  if (!server) throw new UsageError("BEACON_FLOWS_SERVER is not set (the server's origin)");
  const seconds = (name: string): number | undefined => {
    const raw = env[name];
    if (raw === undefined || raw === "") return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0)
      throw new UsageError(`${name} must be a positive number, not "${raw}"`);
    return n;
  };
  const lockDelaySec = seconds("BEACON_FLOWS_LOCK_SEC");
  const unlockDelaySec = seconds("BEACON_FLOWS_UNLOCK_SEC");
  const waitMs = seconds("BEACON_FLOWS_WAIT_MS");
  return {
    server,
    ...(lockDelaySec !== undefined ? { lockDelaySec } : {}),
    ...(unlockDelaySec !== undefined ? { unlockDelaySec } : {}),
    ...(waitMs !== undefined ? { waitMs } : {}),
  };
}

export async function main(env: NodeJS.ProcessEnv, out: (line: string) => void): Promise<number> {
  const options = parseEnv(env);
  const reports = await runFlows({ ...options, connect: io, log: (line) => out(`  ${line}`) });
  for (const r of reports) out(`${r.ok ? "ok  " : "FAIL"} ${r.flow}: ${r.detail}`);
  return reports.filter((r) => !r.ok).length;
}

if (require.main === module) {
  main(process.env, (line) => console.log(line)).then(
    (failed) => process.exit(failed > 0 ? 1 : 0),
    (err) => {
      console.error(err instanceof UsageError ? err.message : err);
      process.exit(err instanceof UsageError ? 2 : 3);
    },
  );
}
