import { diagnosticApiKeyEnv, getDiagnosticStrategy } from "./getDiagnosticStrategy.js";
import { runDiagnostics } from "./runDiagnostics.js";
/** @typedef {import("./DiagnosticReport.ts").DiagnosticReport} DiagnosticReport */

/**
 * @param {string} command
 * @param {Record<string, string>} env
 * @param {string} cwd
 * @param {{ provider?: string; model?: string; apiKey?: string }} [hints]
 * @param {typeof runDiagnostics} [run] injectable runner (defaults to
 *   runDiagnostics); overridable so the never-rejects-in-practice failure path
 *   can be exercised in tests.
 * @returns {Promise<DiagnosticReport | null> | null}
 */
export function launchDiagnostics(command, env, cwd, hints, run = runDiagnostics) {
  const strategy = getDiagnosticStrategy(command, hints);
  if (!strategy) return null;
  const apiKeyEnv = diagnosticApiKeyEnv(command, hints);
  const effectiveEnv = apiKeyEnv ? { ...env, ...apiKeyEnv } : env;
  return Promise.resolve()
    .then(() => run(strategy, { env: effectiveEnv, cwd }))
    .catch(() => null);
}
