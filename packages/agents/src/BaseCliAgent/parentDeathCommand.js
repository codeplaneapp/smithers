import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WATCHDOG_PATH = fileURLToPath(new URL("./parentDeathWatchdog.js", import.meta.url));
/**
 * Where the watchdog process itself runs. Deliberately *not* the agent's cwd:
 * `process.execPath` is Bun whenever the engine runs under Bun, and Bun reads
 * `bunfig.toml` from its own cwd. Booting the watchdog inside a checkout that
 * declares a `preload` makes Bun evaluate that preload — and if the checkout
 * has no `node_modules` (the review action clones the PR repo without
 * installing it) Bun falls back to auto-installing the preload's imports out of
 * `~/.bun/install/cache`, which resolves intermittently and kills the watchdog
 * before the agent is ever spawned (#1546). The package's own directory carries
 * no bunfig, so the watchdog boots identically everywhere.
 */
const WATCHDOG_CWD = dirname(WATCHDOG_PATH);

/**
 * Route a POSIX agent command through the detached watchdog that owns its
 * process group. Custom spawn implementations are left untouched because
 * they may not create real operating-system processes.
 *
 * `cwd` is the directory the *agent* must run in; the watchdog forwards it to
 * the real command and is itself spawned in `invocation.cwd`. It is resolved
 * here, against the engine's cwd, because the watchdog no longer shares it.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {boolean} [enabled]
 * @param {string} [cwd]
 * @returns {{ command: string; args: string[]; contained: boolean; cwd: string | undefined }}
 */
export function parentDeathCommand(command, args, enabled = true, cwd = undefined) {
  if (!enabled || process.platform === "win32") {
    return { command, args, contained: false, cwd };
  }
  return {
    command: process.execPath,
    args: [WATCHDOG_PATH, String(process.pid), resolve(cwd ?? process.cwd()), command, ...args],
    contained: true,
    cwd: WATCHDOG_CWD,
  };
}
