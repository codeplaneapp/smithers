import { resolve } from "node:path";

const FALLBACK_CWD_ENV = "SMITHERS_INTERNAL_MANIFEST_FALLBACK_CWD";
let fallbackCwd;

export const cliWorkspace = {
  fallbackCwdEnv: FALLBACK_CWD_ENV,

  /** @returns {string} */
  cwd() {
    return resolve(fallbackCwd ?? process.cwd());
  },

  /** @returns {boolean} */
  restoreFromEnv() {
    const cwd = process.env[FALLBACK_CWD_ENV];
    if (!cwd) return false;
    fallbackCwd = resolve(cwd);
    // This marker describes only the exec-replaced process. Do not leak it
    // to gateway/agent children that start with the workspace as their real
    // cwd; each child must perform its own safe bootstrap.
    delete process.env[FALLBACK_CWD_ENV];
    return true;
  },

  /** @returns {boolean} */
  usesManifestFallback() {
    return fallbackCwd !== undefined;
  },
};
