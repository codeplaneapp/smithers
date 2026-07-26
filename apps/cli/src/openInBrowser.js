import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * True when `cmd` resolves to an executable on PATH. spawn() reports a missing
 * executable ASYNCHRONOUSLY via the child's `error` event (ENOENT), never by
 * throwing — so without this probe a headless box with no `xdg-open` would
 * "succeed" and callers would print "Opening <url>" when nothing opened.
 */
function launcherOnPath(cmd) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, cmd), constants.X_OK);
      return true;
    } catch {
      // Not in this directory; keep looking.
    }
  }
  return false;
}

/**
 * Whether a browser should be launched at all, independent of any per-command
 * `--open/--no-open` flag.
 *
 * The flag alone is not enough: it is per-invocation, so when an AGENT runs
 * `smithers monitor`/`ui`/`gui` on your behalf there is no way to pass it. When
 * you are already watching a terminal cockpit (`smithers supervisor` in a herdr
 * pane), hijacking the browser is noise, so suppress it by default there.
 *
 * Precedence (first match wins):
 *   1. `SMITHERS_NO_BROWSER=1|true`  → never open (works anywhere: plain tmux /
 *      iTerm splits with a supervisor, SSH, CI).
 *   2. `SMITHERS_NO_BROWSER=0|false` → always open, even inside herdr.
 *   3. `HERDR_ENV=1`                 → inside a herdr workspace you already have
 *      a TUI cockpit; print the URL instead of stealing focus.
 *   4. otherwise                     → open.
 *
 * Env beats the `--open` default deliberately: that option defaults to `true`,
 * so an explicitly-typed `--open` is indistinguishable from "not passed".
 * `SMITHERS_NO_BROWSER=0` is the explicit force-open escape hatch.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function shouldOpenBrowser(env = process.env) {
  const explicit = env.SMITHERS_NO_BROWSER;
  if (explicit === "1" || explicit === "true") return false;
  if (explicit === "0" || explicit === "false") return true;
  if (env.HERDR_ENV === "1") return false;
  return true;
}

/**
 * Best-effort "open this in the user's browser". Handles http(s) URLs and local
 * file paths (converted to a file:// URL). Detached + unref'd so it never keeps
 * the CLI alive, and swallows spawn errors so a headless box (no `open`/
 * `xdg-open`) degrades to "we wrote the file" instead of crashing the command.
 *
 * Returns false — without spawning — when {@link shouldOpenBrowser} says this
 * environment does not want a browser. Callers print the URL on a false return,
 * so suppression degrades to a copyable link rather than a silent no-op.
 *
 * @param {string} target A URL or an absolute filesystem path.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean} true if a launcher was spawned, false if suppressed or none is available.
 */
export function openInBrowser(target, env = process.env) {
  if (!shouldOpenBrowser(env)) return false;
  const url = /^[a-z]+:\/\//i.test(target) ? target : pathToFileURL(target).href;
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  // Windows resolves `cmd` via ComSpec rather than a plain PATH lookup (and the
  // probe would need PATHEXT handling), so only probe on posix — where `open`/
  // `xdg-open` are plain PATH executables and the probe matches spawn's own
  // resolution exactly.
  if (process.platform !== "win32" && !launcherOnPath(cmd)) return false;
  try {
    const proc = spawn(cmd, args, { stdio: "ignore", detached: true });
    proc.unref();
    proc.on("error", () => {});
    return true;
  } catch {
    return false;
  }
}
