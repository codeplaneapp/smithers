import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const E2E_HELPERS_URL = pathToFileURL(resolve(import.meta.dir, "e2e-helpers.js")).href;
const dirs = new Set();
const processGroups = new Set();

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcessGroup(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      return;
    }
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

async function waitFor(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(25);
  }
  throw new Error("Timed out waiting for condition.");
}

afterEach(() => {
  for (const pid of processGroups) killProcessGroup(pid);
  processGroups.clear();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.clear();
});

describe("e2e harness detached process reaping", () => {
  test("kills an admitted detached engine and its descendant before removing the temp repo", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "smithers-e2e-detached-reaper-test-"));
    dirs.add(dir);
    const resultPath = join(dir, "result.json");
    const descendantPidPath = join(dir, "descendant.pid");
    const nestedTestPath = join(dir, "nested.test.js");
    writeFileSync(
      nestedTestPath,
      [
        'import { expect, test } from "bun:test";',
        'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
        `import { createTempRepo, pinSqliteBackend, runSmithers } from ${JSON.stringify(E2E_HELPERS_URL)};`,
        `const resultPath = ${JSON.stringify(resultPath)};`,
        `const descendantPidPath = ${JSON.stringify(descendantPidPath)};`,
        "async function waitFor(check) {",
        "  const deadline = Date.now() + 10_000;",
        "  while (Date.now() < deadline) {",
        "    if (check()) return;",
        "    await Bun.sleep(25);",
        "  }",
        '  throw new Error("detached workflow did not start its descendant");',
        "}",
        'test("launches a detached engine", async () => {',
        "  const repo = createTempRepo();",
        "  pinSqliteBackend(repo.dir);",
        '  repo.write("workflow.tsx", [',
        '    "/** @jsxImportSource smthrs */",',
        "    'import { spawn } from \"node:child_process\";',",
        "    'import { writeFileSync } from \"node:fs\";',",
        "    'import { createSmithers, Workflow, Task } from \"smthrs\";',",
        "    'import { z } from \"zod\";',",
        '    "const { smithers, outputs } = createSmithers({ result: z.object({ ok: z.boolean() }) });",',
        '    "export default smithers(() => (",',
        '    \'  <Workflow name="detached-reaping"><Task id="slow" output={outputs.result}>{async () => {\',',
        '    \'    const descendant = spawn("/bin/sleep", ["60"], { stdio: "ignore" });\',',
        '    "    writeFileSync(process.env.SMITHERS_TEST_DESCENDANT_PID_PATH, String(descendant.pid));",',
        '    "    await Bun.sleep(60_000);",',
        '    "    return { ok: true };",',
        '    "  }}</Task></Workflow>",',
        '    "));",',
        '    "",',
        '  ].join("\\n"));',
        '  const result = runSmithers(["up", "workflow.tsx", "--detach", "--run-id", "detached-reaper"], {',
        "    cwd: repo.dir,",
        '    env: { SMITHERS_TEST_DESCENDANT_PID_PATH: descendantPidPath, SMITHERS_NO_UPDATE_CHECK: "1" },',
        '    format: "json",',
        "    timeoutMs: 30_000,",
        "  });",
        "  expect(result.exitCode, `${result.stdout}\\n${result.stderr}`).toBe(0);",
        "  expect(Number.isInteger(result.json?.pid)).toBe(true);",
        "  await waitFor(() => existsSync(descendantPidPath));",
        "  writeFileSync(resultPath, JSON.stringify({",
        "    enginePid: result.json.pid,",
        '    descendantPid: Number(readFileSync(descendantPidPath, "utf8")),',
        "    repoDir: repo.dir,",
        "  }));",
        "});",
      ].join("\n"),
      "utf8",
    );

    const nested = spawnSync(process.execPath, ["test", "--timeout=120000", nestedTestPath], {
      cwd: REPO_ROOT,
      env: { ...process.env, SMITHERS_NO_UPDATE_CHECK: "1", SMITHERS_NO_SKILL_REFRESH: "1" },
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(nested.status, `${nested.stdout}\n${nested.stderr}`).toBe(0);
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    processGroups.add(result.enginePid);

    await waitFor(
      () => !isAlive(result.enginePid) && !isAlive(result.descendantPid) && !existsSync(result.repoDir),
      10_000,
    );
  }, 120_000);
});
