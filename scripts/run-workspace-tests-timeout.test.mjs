import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, test } from "bun:test";

const runner = resolve(import.meta.dirname, "run-workspace-tests.mjs");
const FIXTURE_TIMEOUT_MINUTES = "0.1";
const FIXTURE_START_TIMEOUT_MS = 10_000;
const RUNNER_EXIT_TIMEOUT_MS = 30_000;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      return;
    }
    await wait(25);
  }
  throw new Error(`Timed out waiting for ${file}`);
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for workspace test runner after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function forceKill(pid) {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process already exited.
    }
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") {
        return;
      }
      throw error;
    }
    await wait(25);
  }
  throw new Error(`Timed out waiting for process ${pid} to exit`);
}

describe.skipIf(process.platform === "win32")("run-workspace-tests timeout", () => {
  test(
    "escalates to SIGKILL when a package test traps SIGTERM",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "smithers-workspace-tests-timeout-"));
      const binDir = join(root, "bin");
      const packageDir = join(root, "packages", "hung");
      const pidFile = join(root, "hung.pid");
      const termFile = join(root, "hung.sigterm");
      let child;
      let hungPid;
      let runnerExited = false;
      let hungExited = false;

      try {
        mkdirSync(binDir, { recursive: true });
        mkdirSync(packageDir, { recursive: true });
        writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, workspaces: ["packages/*"] }));
        writeFileSync(
          join(packageDir, "package.json"),
          JSON.stringify({ name: "@fixture/hung", scripts: { test: "unused" } }),
        );
        const fakePnpm = join(binDir, "pnpm");
        writeFileSync(
          fakePnpm,
          `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
process.on("SIGTERM", () => writeFileSync(process.env.WORKSPACE_TEST_TERM_FILE, "received"));
writeFileSync(process.env.WORKSPACE_TEST_PID_FILE, String(process.pid));
setInterval(() => {}, 1_000);
`,
        );
        chmodSync(fakePnpm, 0o755);

        child = spawn(process.execPath, [runner, "--timeout-minutes", FIXTURE_TIMEOUT_MINUTES], {
          cwd: root,
          env: {
            ...process.env,
            PATH: `${binDir}${delimiter}${process.env.PATH}`,
            WORKSPACE_TEST_PID_FILE: pidFile,
            WORKSPACE_TEST_TERM_FILE: termFile,
          },
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
        const resultPromise = waitForExit(child, RUNNER_EXIT_TIMEOUT_MS);
        const readyOrExit = await Promise.race([
          waitForFile(pidFile, FIXTURE_START_TIMEOUT_MS).then(() => ({ ready: true })),
          resultPromise.then((result) => ({ result })),
        ]);
        if ("result" in readyOrExit) {
          runnerExited = true;
          throw new Error(
            `Workspace test runner exited before starting its test command: ${readyOrExit.result.stderr}`,
          );
        }
        hungPid = Number(readFileSync(pidFile, "utf8"));

        const result = await resultPromise;
        runnerExited = true;
        expect(result.code).toBe(1);
        expect(result.signal).toBeNull();
        expect(result.stderr).toContain(`exceeded ${FIXTURE_TIMEOUT_MINUTES} minutes`);
        expect(result.stderr).toContain("did not exit after SIGTERM; sending SIGKILL");
        expect(result.stdout).toContain("timed out");
        expect(result.stdout).toContain("packages/hung");
        expect(existsSync(termFile)).toBe(true);
        await waitForProcessExit(hungPid, 2_000);
        hungExited = true;
      } finally {
        if (!runnerExited) {
          forceKill(child?.pid);
        }
        if (!hungExited) {
          if (hungPid === undefined && existsSync(pidFile)) {
            hungPid = Number(readFileSync(pidFile, "utf8"));
          }
          forceKill(hungPid);
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
    RUNNER_EXIT_TIMEOUT_MS + 5_000,
  );
});
