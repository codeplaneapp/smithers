import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const RUNNER = resolve(import.meta.dir, "e2e-process-runner.js");
const dirs = new Set();
const pids = new Set();

function makeDir() {
  const dir = mkdtempSync(join(tmpdir(), "smithers-e2e-runner-test-"));
  dirs.add(dir);
  return dir;
}

function killGroup(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {}
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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

function runRunner(config) {
  const dir = makeDir();
  const configPath = join(dir, "config.json");
  const resultPath = join(dir, "result.json");
  const pidPath = join(dir, "pid");
  writeFileSync(
    configPath,
    JSON.stringify({
      ...config,
      parentPid: process.pid,
      pidPath,
      resultPath,
    }),
    "utf8",
  );
  const worker = spawnSync(process.execPath, ["run", RUNNER, configPath], {
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(worker.status).toBe(0);
  return JSON.parse(readFileSync(resultPath, "utf8"));
}

afterEach(() => {
  for (const pid of pids) killGroup(pid);
  pids.clear();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.clear();
});

describe("e2e process runner", () => {
  test("preserves stdin, stdout, stderr, and exit status", () => {
    const dir = makeDir();
    const command = join(dir, "command.js");
    writeFileSync(
      command,
      [
        'process.stdin.on("data", (chunk) => process.stdout.write(`in:${chunk}`));',
        'process.stderr.write("diagnostic\\n");',
        'process.stdin.on("end", () => process.exit(7));',
      ].join("\n"),
      "utf8",
    );
    const result = runRunner({
      command: process.execPath,
      args: ["run", command],
      cwd: dir,
      env: process.env,
      stdin: "hello",
      timeoutMs: 5_000,
    });
    expect(result).toEqual({
      status: 7,
      signal: null,
      stdout: "in:hello",
      stderr: "diagnostic\n",
    });
  });

  test("hard-kills a SIGTERM-ignoring process group at its deadline", async () => {
    if (process.platform === "win32") return;
    const dir = makeDir();
    const pidsPath = join(dir, "pids");
    const command = join(dir, "ignore-term.js");
    writeFileSync(
      command,
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore" });',
        "writeFileSync(process.argv[2], `${process.pid} ${grandchild.pid}`);",
        'process.on("SIGTERM", () => {});',
        "setInterval(() => {}, 1_000);",
      ].join("\n"),
      "utf8",
    );
    const result = runRunner({
      command: process.execPath,
      args: ["run", command, pidsPath],
      cwd: dir,
      env: process.env,
      timeoutMs: 700,
    });
    const [parentPid, grandchildPid] = readFileSync(pidsPath, "utf8").split(" ").map(Number);
    pids.add(parentPid);
    expect(result.signal).toBe("SIGKILL");
    await waitFor(() => !isAlive(parentPid) && !isAlive(grandchildPid));
  });

  test("reaps a child group and its workspace when the harness dies", async () => {
    if (process.platform === "win32") return;
    const dir = makeDir();
    const workspace = join(dir, "smithers-e2e-workspace");
    const control = join(dir, "control");
    const pidsPath = join(dir, "pids");
    const command = join(dir, "ignore-term.js");
    const harness = join(dir, "harness.js");
    writeFileSync(
      command,
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore" });',
        "writeFileSync(process.argv[2], `${process.pid} ${grandchild.pid}`);",
        'process.on("SIGTERM", () => {});',
        "setInterval(() => {}, 1_000);",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      harness,
      [
        'import { mkdirSync, writeFileSync } from "node:fs";',
        'import { spawnSync } from "node:child_process";',
        "const [runner, command, workspace, control, pidsPath] = process.argv.slice(2);",
        "mkdirSync(workspace, { recursive: true });",
        "mkdirSync(control, { recursive: true });",
        "const configPath = `${control}/config.json`;",
        'writeFileSync(configPath, JSON.stringify({ command: process.execPath, args: ["run", command, pidsPath], cwd: workspace, env: process.env, timeoutMs: 30_000, parentPid: process.pid, pidPath: `${control}/pid`, resultPath: `${control}/result.json`, tempDir: workspace }));',
        'spawnSync(process.execPath, ["run", runner, configPath], { stdio: "ignore" });',
      ].join("\n"),
      "utf8",
    );
    const child = spawn(process.execPath, ["run", harness, RUNNER, command, workspace, control, pidsPath], {
      stdio: "ignore",
    });
    pids.add(child.pid);
    await waitFor(() => existsSync(join(control, "pid")) && existsSync(pidsPath));
    const [parentPid, grandchildPid] = readFileSync(pidsPath, "utf8").split(" ").map(Number);
    pids.add(parentPid);
    process.kill(child.pid, "SIGKILL");
    await waitFor(() => !isAlive(parentPid) && !isAlive(grandchildPid) && !existsSync(workspace));
  });
});
