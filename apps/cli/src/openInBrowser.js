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
 * Best-effort "open this in the user's browser". Handles http(s) URLs and local
 * file paths (converted to a file:// URL). Detached + unref'd so it never keeps
 * the CLI alive, and swallows spawn errors so a headless box (no `open`/
 * `xdg-open`) degrades to "we wrote the file" instead of crashing the command.
 *
 * @param {string} target A URL or an absolute filesystem path.
 * @returns {boolean} true if a launcher was spawned, false if none is available.
 */
export function openInBrowser(target) {
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
