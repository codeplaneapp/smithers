import { spawnSync } from "node:child_process";

const DEFAULT_FORCE_KILL_TIMEOUT_MS = 2_000;

function hasExited(child) {
  return typeof child?.exitCode === "number" || typeof child?.signalCode === "string";
}

function observeExit(child) {
  let settled = false;
  let resolveExit;
  const promise = new Promise((resolve) => { resolveExit = resolve; });
  const dispose = () => {
    child.off?.("exit", onExit);
    child.off?.("close", onExit);
    child.off?.("error", onExit);
  };
  const onExit = () => {
    if (settled) return;
    settled = true;
    dispose();
    resolveExit();
  };
  child.once("exit", onExit);
  child.once("close", onExit);
  child.once("error", onExit);
  if (hasExited(child)) queueMicrotask(onExit);
  return { promise, dispose };
}

async function exitsWithin(exited, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
      }),
    ]);
  }
  finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function taskkillProcessTree(pid, timeoutMs) {
  try {
    return spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: Math.max(1, timeoutMs),
    }).status === 0;
  }
  catch {
    return false;
  }
}

/**
 * Terminate a child process (optionally its whole POSIX process group) and wait
 * for it to exit. Windows always uses `taskkill /T /F` so descendants cannot
 * survive. Every wait is bounded, including the post-SIGKILL wait.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {{
 *   timeoutMs?: number;
 *   killTimeoutMs?: number;
 *   killProcessGroup?: boolean;
 *   platform?: NodeJS.Platform;
 *   kill?: (pid: number, signal: NodeJS.Signals) => void;
 *   runTaskkill?: (pid: number, timeoutMs: number) => boolean | Promise<boolean>;
 * }} [options]
 */
export async function terminateChild(child, {
  timeoutMs = 5_000,
  killTimeoutMs = DEFAULT_FORCE_KILL_TIMEOUT_MS,
  killProcessGroup = false,
  platform = process.platform,
  kill = (target, signal) => process.kill(target, signal),
  runTaskkill = taskkillProcessTree,
} = {}) {
  if (hasExited(child)) return;
  const pid = child?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return;

  const exit = observeExit(child);
  try {
    if (platform === "win32") {
      const treeKilled = await runTaskkill(pid, killTimeoutMs);
      if (!treeKilled && !hasExited(child)) {
        try { kill(pid, "SIGKILL"); }
        catch { try { child.kill?.("SIGKILL"); } catch {} }
      }
      await exitsWithin(exit.promise, killTimeoutMs);
      return;
    }

    const target = killProcessGroup ? -pid : pid;
    const signal = (name) => {
      try {
        kill(target, name);
        return true;
      }
      catch {
        if (target === pid) return false;
      }
      try {
        kill(pid, name);
        return true;
      }
      catch {
        return false;
      }
    };

    if (!signal("SIGTERM")) return;
    if (await exitsWithin(exit.promise, timeoutMs)) return;
    signal("SIGKILL");
    await exitsWithin(exit.promise, killTimeoutMs);
  }
  finally {
    exit.dispose();
  }
}
