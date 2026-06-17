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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// packages/electric-proxy/tests/fixtures -> repo root
const repoRoot = join(here, "..", "..", "..", "..");
const composeFile = join(repoRoot, "deploy", "electric", "docker-compose.yml");
const PROJECT = process.env.SMITHERS_ELECTRIC_TEST_PROJECT ?? "smithers-electric-test";
const ELECTRIC_PORT = process.env.SMITHERS_ELECTRIC_PORT ?? "30001";
const ELECTRIC_BASE = `http://localhost:${ELECTRIC_PORT}`;

function run(cmd: string, args: readonly string[], timeoutMs = 120_000): string {
  return execFileSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
}

function tryRun(cmd: string, args: readonly string[], timeoutMs = 120_000): { ok: boolean; out: string } {
  try {
    return { ok: true, out: run(cmd, args, timeoutMs) };
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

function psql(sql: string): string {
  return run("docker", [
    ...compose("exec", "-T", "postgres", "psql", "-U", "smithers", "-d", "smithers", "-v", "ON_ERROR_STOP=1", "-c", sql),
  ]);
}

async function waitForElectricHealthy(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${ELECTRIC_BASE}/v1/health`);
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
  // A fresh start each time keeps the replication slot + seeded data clean.
  tryRun("docker", [...compose("down", "-v")], 60_000);
  run("docker", [...compose("up", "-d", "--wait")], 180_000);
  await waitForElectricHealthy();

  return {
    shapeUrl: `${ELECTRIC_BASE}/v1/shape`,
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
      tryRun("docker", [...compose("down", "-v")], 60_000);
    },
  };
}
