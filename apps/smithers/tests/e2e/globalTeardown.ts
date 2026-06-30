import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, rmSync } from "node:fs";

/** Tear down the seed Gateway started by globalSetup. */
const here = dirname(fileURLToPath(import.meta.url));

export default async function globalTeardown(): Promise<void> {
  const pidFile = resolve(here, ".gateway.pid");
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (pid) {
    try {
      // The gateway is detached (its own process group); kill the group.
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  rmSync(pidFile, { force: true });
}
