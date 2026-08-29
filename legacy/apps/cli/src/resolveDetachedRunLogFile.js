import { resolve } from "node:path";
import { resolveLaunchRootDir } from "./resolve-root.js";

/**
 * Resolve the stdout/stderr file used by a detached run.
 *
 * @param {string} runId
 * @param {{ logDir?: string | null; cwd?: string }} [options]
 * @returns {string}
 */
export function resolveDetachedRunLogFile(runId, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const logDir =
    options.logDir !== undefined && options.logDir !== null
      ? resolve(cwd, options.logDir)
      : resolve(resolveLaunchRootDir(undefined, cwd), ".smithers", "logs");
  return resolve(logDir, `${runId}.log`);
}
