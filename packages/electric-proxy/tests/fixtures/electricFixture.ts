/**
 * Real (no-mocks) ElectricSQL + Postgres fixture for the electric-proxy tests.
 *
 * Brings up `deploy/electric/docker-compose.yml` (real Postgres with
 * wal_level=logical + electricsql/electric), seeds rows, and exposes the live
 * Electric shape URL. Tests gate on `isDockerFixtureAvailable()` so the suite
 * SKIPS (never fails) on a host without Docker, while running for real where
 * Docker is present. This is the NO-MOCKS backend the design (§5.3, §13)
 * requires for the Electric path.
 */
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// packages/electric-proxy/tests/fixtures -> repo root
const repoRoot = join(here, "..", "..", "..", "..");
const composeFile = join(repoRoot, "deploy", "electric", "docker-compose.yml");
const PROJECT = process.env.SMITHERS_ELECTRIC_TEST_PROJECT ?? `smithers-electric-test-${process.pid}`;

type ComposeEnv = {
  SMITHERS_ELECTRIC_PORT: string;
  SMITHERS_PG_PORT: string;
};

function run(cmd: string, args: readonly string[], timeoutMs = 120_000, env?: Partial<ComposeEnv>): string {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function tryRun(
  cmd: string,
  args: readonly string[],
  timeoutMs = 120_000,
  env?: Partial<ComposeEnv>,
): { ok: boolean; out: string } {
  try {
    return { ok: true, out: run(cmd, args, timeoutMs, env) };
  } catch (error) {
    return { ok: false, out: error instanceof Error ? error.message : String(error) };
  }
}

/** True only when Docker is installed AND the daemon is responsive. */
export function isDockerFixtureAvailable(): boolean {
  if (process.env.SMITHERS_SKIP_ELECTRIC_FIXTURE === "1") return false;
  return tryRun("docker", ["info"], 10_000).ok;
}

const compose = (...args: string[]) => ["compose", "-f", composeFile, "-p", PROJECT, ...args];

async function findFreeTcpPort(): Promise<string> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(String(address.port));
        } else {
          reject(new Error("Failed to allocate a free TCP port"));
        }
      });
    });
  });
}

function psql(sql: string): string {
  return run("docker", [
    ...compose("exec", "-T", "postgres", "psql", "-U", "smithers", "-d", "smithers", "-v", "ON_ERROR_STOP=1", "-c", sql),
  ]);
}

async function waitForElectricHealthy(electricBase: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${electricBase}/v1/health`);
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { status?: string };
        if (body.status === "active") return;
      }
      lastError = `health status ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Electric did not become healthy within ${timeoutMs}ms (${lastError})`);
}

export type ElectricFixture = {
  /** Base Electric shape URL the proxy fronts: `${base}/v1/shape`. */
  shapeUrl: string;
  /** Seed `_smithers_runs` rows (run_id, status). */
  seedRuns(rows: ReadonlyArray<{ runId: string; status: string; workflow?: string }>): void;
  teardown(): void;
};

/**
 * Bring the stack up, wait for health, and return a handle. Always tear down in
 * an `afterAll` (even on failure) — it removes containers + the data volume.
 */
export async function startElectricFixture(): Promise<ElectricFixture> {
  const composeEnv: ComposeEnv = {
    SMITHERS_ELECTRIC_PORT: process.env.SMITHERS_ELECTRIC_PORT ?? (await findFreeTcpPort()),
    SMITHERS_PG_PORT: process.env.SMITHERS_PG_PORT ?? (await findFreeTcpPort()),
  };
  const electricBase = `http://localhost:${composeEnv.SMITHERS_ELECTRIC_PORT}`;

  // A fresh start each time keeps the replication slot + seeded data clean.
  tryRun("docker", [...compose("down", "-v")], 60_000, composeEnv);
  run("docker", [...compose("up", "-d", "--wait")], 180_000, composeEnv);
  await waitForElectricHealthy(electricBase);

  return {
    shapeUrl: `${electricBase}/v1/shape`,
    seedRuns(rows) {
      for (const row of rows) {
        const workflow = (row.workflow ?? "hello").replaceAll("'", "''");
        const status = row.status.replaceAll("'", "''");
        const runId = row.runId.replaceAll("'", "''");
        psql(
          `INSERT INTO _smithers_runs (run_id, workflow_name, status, created_at_ms, config_json) ` +
            `VALUES ('${runId}', '${workflow}', '${status}', 1718000000000, '{}') ` +
            `ON CONFLICT (run_id) DO UPDATE SET status = EXCLUDED.status`,
        );
      }
    },
    teardown() {
      tryRun("docker", [...compose("down", "-v")], 60_000, composeEnv);
    },
  };
}
