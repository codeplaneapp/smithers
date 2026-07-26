import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const configPath = process.argv[2];

if (!configPath) {
  process.stderr.write("Missing e2e process runner config path.\n");
  process.exit(2);
}

const config = JSON.parse(readFileSync(configPath, "utf8"));
let child;
let finished = false;
let parentWatcher;

function append(chunks, state, chunk) {
  if (state.bytes >= MAX_OUTPUT_BYTES) return;
  const available = MAX_OUTPUT_BYTES - state.bytes;
  const value = Buffer.from(chunk).subarray(0, available);
  state.bytes += value.length;
  chunks.push(value);
}

function killChild(signal) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function removeTempDir() {
  if (!config.tempDir) return;
  try {
    rmSync(config.tempDir, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
  } catch {}
}

function reapAfterParentExit() {
  killChild("SIGKILL");
  removeTempDir();
}

function parentIsAlive() {
  try {
    process.kill(config.parentPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function finish(status, signal, stdout, stderr) {
  if (finished) return;
  finished = true;
  clearTimeout(termTimer);
  clearTimeout(killTimer);
  clearInterval(parentWatcher);
  writeFileSync(
    config.resultPath,
    JSON.stringify({
      status,
      signal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }),
    "utf8",
  );
}

const timeoutMs = Math.max(1, Number(config.timeoutMs) || 60_000);
const graceMs = Math.min(1_000, Math.max(50, Math.floor(timeoutMs / 10)));
const termTimer = setTimeout(() => killChild("SIGTERM"), Math.max(0, timeoutMs - graceMs));
const killTimer = setTimeout(() => killChild("SIGKILL"), timeoutMs);

process.on("SIGINT", () => {
  reapAfterParentExit();
  process.exit(130);
});
process.on("SIGTERM", () => {
  reapAfterParentExit();
  process.exit(143);
});
process.on("SIGHUP", () => {
  reapAfterParentExit();
  process.exit(129);
});
process.on("exit", () => {
  if (!finished) reapAfterParentExit();
});

child = spawn(config.command, config.args, {
  cwd: config.cwd,
  env: {
    ...process.env,
    ...config.env,
  },
  detached: process.platform !== "win32",
  stdio: ["pipe", "pipe", "pipe"],
});
writeFileSync(config.pidPath, String(child.pid), "utf8");

const stdout = [];
const stderr = [];
const stdoutState = { bytes: 0 };
const stderrState = { bytes: 0 };
child.stdout.on("data", (chunk) => append(stdout, stdoutState, chunk));
child.stderr.on("data", (chunk) => append(stderr, stderrState, chunk));
child.on("error", (error) => {
  append(stderr, stderrState, Buffer.from(`${error.message}\n`));
});
child.on("close", (status, signal) => finish(status, signal, stdout, stderr));
if (config.stdin !== undefined && config.stdin !== null) {
  child.stdin.end(config.stdin);
} else {
  child.stdin.end();
}

parentWatcher = setInterval(() => {
  if (!parentIsAlive()) {
    reapAfterParentExit();
    process.exit(1);
  }
}, 100);
