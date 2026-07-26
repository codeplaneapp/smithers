import { accessSync, constants as fsConstants } from "node:fs";

/**
 * Whether the operating system can execute a bundled `jj` candidate.
 *
 * POSIX requires the executable bit; Windows selects the vendored `.exe` and
 * does not use POSIX mode bits, so existence/readability is sufficient there.
 * This is deliberately a probe, not a chmod: an unusable automatic bundle must
 * not shadow a working `jj` on PATH.
 *
 * Internal: intentionally NOT re-exported from the package barrel.
 *
 * @param {string} binaryPath
 * @param {{ platform?: NodeJS.Platform, accessFile?: typeof accessSync }} [options]
 * @returns {boolean}
 */
export function isJjExecutable(binaryPath, { platform = process.platform, accessFile = accessSync } = {}) {
  try {
    accessFile(binaryPath, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
