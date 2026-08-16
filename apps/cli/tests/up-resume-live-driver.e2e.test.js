// Issue #1056: `smithers up --resume --force` used to attach a second engine to
// a run whose driver process was still alive, splitting scheduling and racing
// state writes. `--force` is an overloaded escape hatch, so ownership now needs
// the separately named `--steal-ownership`.
//
// The CLI runs as a real subprocess against a real sqlite store, and the
// "other driver" is a real OS process this test spawns and reaps.
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { formatRuntimeOwnerId } from "@smthrs/db/runtime-owner";
import {
  createTempRepo,
  pinSqliteBackend,
  runSmithers,
  writeTestWorkflow,
} from "../../../packages/smithers/tests/e2e-helpers.js";

/** @type {Array<import("node:child_process").ChildProcess>} */
const spawned = [];
afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
});

function spawnLiveDriver() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  spawned.push(child);
  return child;
}

async function spawnDeadDriver() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  await new Promise((resolve) => child.once("exit", resolve));
  return pid;
}

function openRepoDb(repo) {
  const sqlite = new Database(repo.path("smithers.db"));
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
}

/**
 * Create a real completed run, then rewrite its row to look exactly like a run
 * being driven right now by `ownerPid` — the shape the guard must recognise.
 */
async function seedRunOwnedBy(repo, runId, ownerPid, { heartbeatAgeMs = 0 } = {}) {
  const created = runSmithers(["up", "workflow.tsx", "--run-id", runId], {
    cwd: repo.dir,
    format: "json",
    timeoutMs: 120_000,
  });
  expect(created.exitCode, `${created.stdout}\n${created.stderr}`).toBe(0);

  const { sqlite, adapter } = openRepoDb(repo);
  try {
    const runtimeOwnerId = formatRuntimeOwnerId(ownerPid, hostname(), "other-driver");
    const heartbeatAtMs = Date.now() - heartbeatAgeMs;
    await adapter.updateRun(runId, { status: "running", runtimeOwnerId, heartbeatAtMs });
    const seeded = await adapter.getRun(runId);
    const attempts = await adapter.listAttempts(runId, "write-result", 0);
    return { runtimeOwnerId, heartbeatAtMs, seeded, attempts };
  } finally {
    sqlite.close();
  }
}

async function readRunState(repo, runId) {
  const { sqlite, adapter } = openRepoDb(repo);
  try {
    return {
      run: await adapter.getRun(runId),
      attempts: await adapter.listAttempts(runId, "write-result", 0),
    };
  } finally {
    sqlite.close();
  }
}

describe("up --resume against a live driver (#1056)", () => {
  test("--force is refused, and the refusal leaves owner, run state, and attempts untouched", async () => {
    const repo = createTempRepo();
    pinSqliteBackend(repo.dir);
    writeTestWorkflow(repo);
    const driver = spawnLiveDriver();
    const seeded = await seedRunOwnedBy(repo, "live-driver-force", driver.pid);

    const blocked = runSmithers(["up", "workflow.tsx", "--resume", "--run-id", "live-driver-force", "--force"], {
      cwd: repo.dir,
      format: "json",
      timeoutMs: 120_000,
    });
    expect(blocked.exitCode, `${blocked.stdout}\n${blocked.stderr}`).toBe(4);
    expect(blocked.json.code).toBe("RUN_OWNER_ALIVE");
    expect(blocked.json.message).toContain("--steal-ownership");
    expect(blocked.json.message).toContain(String(driver.pid));

    const after = await readRunState(repo, "live-driver-force");
    expect(after.run?.status).toBe("running");
    expect(after.run?.runtimeOwnerId).toBe(seeded.runtimeOwnerId);
    expect(after.run?.heartbeatAtMs).toBe(seeded.heartbeatAtMs);
    expect(after.run?.finishedAtMs).toBe(seeded.seeded?.finishedAtMs ?? null);
    expect(after.attempts).toEqual(seeded.attempts);
  }, 180_000);

  test("detached `up -d --resume --force` refuses before it spawns anything", async () => {
    const repo = createTempRepo();
    pinSqliteBackend(repo.dir);
    writeTestWorkflow(repo);
    const driver = spawnLiveDriver();
    const seeded = await seedRunOwnedBy(repo, "live-driver-detached", driver.pid);

    const blocked = runSmithers(
      ["up", "workflow.tsx", "--resume", "--run-id", "live-driver-detached", "--force", "-d"],
      { cwd: repo.dir, format: "json", timeoutMs: 120_000 },
    );
    expect(blocked.exitCode, `${blocked.stdout}\n${blocked.stderr}`).toBe(4);
    expect(blocked.json.code).toBe("RUN_OWNER_ALIVE");
    expect(blocked.json.message).toContain("--steal-ownership");

    const after = await readRunState(repo, "live-driver-detached");
    expect(after.run?.runtimeOwnerId).toBe(seeded.runtimeOwnerId);
    expect(after.run?.heartbeatAtMs).toBe(seeded.heartbeatAtMs);
    expect(after.attempts).toEqual(seeded.attempts);
  }, 180_000);

  test("--steal-ownership attaches to that same live driver", async () => {
    const repo = createTempRepo();
    pinSqliteBackend(repo.dir);
    writeTestWorkflow(repo);
    const driver = spawnLiveDriver();
    await seedRunOwnedBy(repo, "live-driver-steal", driver.pid);

    const stolen = runSmithers(
      ["up", "workflow.tsx", "--resume", "--run-id", "live-driver-steal", "--steal-ownership"],
      { cwd: repo.dir, format: "json", timeoutMs: 120_000 },
    );
    expect(stolen.exitCode, `${stolen.stdout}\n${stolen.stderr}`).toBe(0);
    expect(stolen.json.runId).toBe("live-driver-steal");
  }, 180_000);

  test("a dead driver resumes with no extra flag at all (crash recovery must not regress)", async () => {
    const repo = createTempRepo();
    pinSqliteBackend(repo.dir);
    writeTestWorkflow(repo);
    const deadPid = await spawnDeadDriver();
    await seedRunOwnedBy(repo, "dead-driver-recovers", deadPid, { heartbeatAgeMs: 120_000 });

    const recovered = runSmithers(["up", "workflow.tsx", "--resume", "--run-id", "dead-driver-recovers"], {
      cwd: repo.dir,
      format: "json",
      timeoutMs: 120_000,
    });
    expect(recovered.exitCode, `${recovered.stdout}\n${recovered.stderr}`).toBe(0);
    expect(recovered.json.runId).toBe("dead-driver-recovers");
  }, 180_000);

  test("retry-task --force is refused against a live driver and resets nothing", async () => {
    const repo = createTempRepo();
    pinSqliteBackend(repo.dir);
    writeTestWorkflow(repo);
    const driver = spawnLiveDriver();
    const seeded = await seedRunOwnedBy(repo, "live-driver-retry", driver.pid);

    const blocked = runSmithers(
      [
        "retry-task",
        "workflow.tsx",
        "--run-id",
        "live-driver-retry",
        "--node-id",
        "write-result",
        "--force",
        "--accept-workflow-change",
      ],
      { cwd: repo.dir, format: "json", timeoutMs: 120_000 },
    );
    expect(blocked.exitCode).not.toBe(0);
    const output = `${blocked.stdout}\n${blocked.stderr}`;
    expect(output).toContain("--steal-ownership");

    const after = await readRunState(repo, "live-driver-retry");
    expect(after.run?.status).toBe("running");
    expect(after.run?.runtimeOwnerId).toBe(seeded.runtimeOwnerId);
    expect(after.run?.heartbeatAtMs).toBe(seeded.heartbeatAtMs);
    expect(after.attempts).toEqual(seeded.attempts);
  }, 180_000);

  test("timetravel --force is refused against a live driver", async () => {
    const repo = createTempRepo();
    pinSqliteBackend(repo.dir);
    writeTestWorkflow(repo);
    const driver = spawnLiveDriver();
    const seeded = await seedRunOwnedBy(repo, "live-driver-timetravel", driver.pid);

    const blocked = runSmithers(
      [
        "timetravel",
        "workflow.tsx",
        "--run-id",
        "live-driver-timetravel",
        "--node-id",
        "write-result",
        "--force",
        "--no-vcs",
      ],
      { cwd: repo.dir, format: "json", timeoutMs: 120_000 },
    );
    expect(blocked.exitCode).toBe(4);
    expect(blocked.json.code).toBe("RUN_OWNER_ALIVE");
    expect(blocked.json.message).toContain("--steal-ownership");

    const after = await readRunState(repo, "live-driver-timetravel");
    expect(after.run?.status).toBe("running");
    expect(after.run?.runtimeOwnerId).toBe(seeded.runtimeOwnerId);
    expect(after.attempts).toEqual(seeded.attempts);
  }, 180_000);
});
