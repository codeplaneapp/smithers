import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, rmSync } from "node:fs";

/** Tear down the seed Gateway + concierge started by globalSetup. */
const here = dirname(fileURLToPath(import.meta.url));

function killPidFile(name: string): void {
  const pidFile = resolve(here, name);
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (pid) {
    try {
      // Detached children run in their own process group; kill the group.
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

export default async function globalTeardown(): Promise<void> {
  killPidFile(".gateway.pid");
  killPidFile(".concierge.pid");
}
