import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { resolveDetachedRunLogFile } from "./resolveDetachedRunLogFile.js";

/**
 * Remove one run's detached stdout/stderr log. Cleanup is best-effort: an
 * unlink failure is reported but never allowed to fail cancellation/deletion.
 *
 * @param {{ runId: string; configJson?: string | null }} run
 * @param {{ cwd?: string; warn?: (line: string) => void }} [options]
 * @returns {{ removed: boolean; logFile: string }}
 */
export function removeDetachedRunLog(run, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const warn = options.warn ?? ((line) => process.stderr.write(line));
  let recordedLogFile;
  if (run.configJson) {
    try {
      const config = JSON.parse(run.configJson);
      if (typeof config?.logFile === "string" && config.logFile.trim().length > 0) {
        recordedLogFile = resolve(cwd, config.logFile);
      }
    } catch {
      // Older or malformed config rows fall back to the managed path.
    }
  }
  const logFile = recordedLogFile ?? resolveDetachedRunLogFile(run.runId, { cwd });
  if (!existsSync(logFile)) {
    return { removed: false, logFile };
  }
  try {
    unlinkSync(logFile);
    return { removed: true, logFile };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      warn(`[smithers] Warning: could not remove detached run log ${logFile}: ${message}\n`);
    } catch {
      // Warning output is best-effort too.
    }
    return { removed: false, logFile };
  }
}
