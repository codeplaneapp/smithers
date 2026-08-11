import { fileURLToPath } from "node:url";

const WATCHDOG_PATH = fileURLToPath(new URL("./parentDeathWatchdog.js", import.meta.url));

/**
 * Route a POSIX agent command through the detached watchdog that owns its
 * process group. Custom spawn implementations are left untouched because
 * they may not create real operating-system processes.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {boolean} [enabled]
 * @returns {{ command: string; args: string[]; contained: boolean }}
 */
export function parentDeathCommand(command, args, enabled = true) {
  if (!enabled || process.platform === "win32") {
    return { command, args, contained: false };
  }
  return {
    command: process.execPath,
    args: [WATCHDOG_PATH, String(process.pid), command, ...args],
    contained: true,
  };
}
