import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE_FIXTURE = fileURLToPath(new URL("./fixtures/parent-death-engine.js", import.meta.url));
const cleanupPids = new Set();
const cleanupDirs = new Set();

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(25);
  }
  return predicate();
}

afterEach(() => {
  for (const pid of cleanupPids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  cleanupPids.clear();
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
  cleanupDirs.clear();
});

describe.skipIf(process.platform === "win32")("agent parent-death containment", () => {
  test("SIGKILL of the engine kills its agent process group on macOS and Linux (#1464 AWF-3)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-parent-death-"));
    cleanupDirs.add(dir);
    const agentPidFile = join(dir, "agent-pids");
    const spawnedPidFile = join(dir, "spawned-pid");
    const engine = spawn(process.execPath, [ENGINE_FIXTURE, agentPidFile, spawnedPidFile], {
      cwd: process.cwd(),
      stdio: "ignore",
    });
    expect(typeof engine.pid).toBe("number");
    cleanupPids.add(engine.pid);

    expect(
      await waitFor(() => {
        try {
          return readFileSync(agentPidFile, "utf8").includes(":") && Number(readFileSync(spawnedPidFile, "utf8")) > 0;
        } catch {
          return false;
        }
      }),
    ).toBe(true);

    const spawnedPid = Number(readFileSync(spawnedPidFile, "utf8"));
    const [agentPid, descendantPid] = readFileSync(agentPidFile, "utf8").split(":").map(Number);
    for (const pid of [spawnedPid, agentPid, descendantPid]) cleanupPids.add(pid);

    process.kill(engine.pid, "SIGKILL");
    expect(await waitFor(() => !alive(engine.pid))).toBe(true);
    expect(await waitFor(() => [spawnedPid, agentPid, descendantPid].every((pid) => !alive(pid)))).toBe(true);
  }, 20_000);
});
