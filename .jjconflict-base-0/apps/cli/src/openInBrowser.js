import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

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
    try {
        const proc = spawn(cmd, args, { stdio: "ignore", detached: true });
        proc.unref();
        proc.on("error", () => { });
        return true;
    }
    catch {
        return false;
    }
}
