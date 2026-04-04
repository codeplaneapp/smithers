import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resume an existing run by launching `smithers up ... --resume` as a detached process.
 * Returns the spawned PID when available.
 */
export function resumeRunDetached(workflowPath: string, runId: string) {
  const cliPath = fileURLToPath(new URL("./index.ts", import.meta.url));
  const child = spawn(
    "bun",
    [cliPath, "up", workflowPath, "--resume", "--run-id", runId, "-d", "--force"],
    {
      cwd: dirname(resolve(workflowPath)),
      stdio: "ignore",
      env: process.env,
      detached: true,
    },
  );
  child.unref();
  return child.pid ?? null;
}
