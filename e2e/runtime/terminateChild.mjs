import { setTimeout as delay } from "node:timers/promises";

/**
 * Terminate a child process (optionally its whole process group) and wait
 * for it to actually exit, escalating to SIGKILL if it doesn't within
 * `timeoutMs`. `child.kill()` only proves a signal was sent, not that the
 * process (or its descendants) actually died -- this awaits the real exit.
 */
export async function terminateChild(child, { timeoutMs = 5000, killProcessGroup = false } = {}) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const target = killProcessGroup && child.pid ? -child.pid : child.pid;
  try { process.kill(target, "SIGTERM"); } catch {}
  const timedOut = await Promise.race([exited.then(() => false), delay(timeoutMs).then(() => true)]);
  if (timedOut) {
    try { process.kill(target, "SIGKILL"); } catch {}
    await exited;
  }
}
