import { diagnosticApiKeyEnv, getDiagnosticStrategy } from "./getDiagnosticStrategy.js";
import { runDiagnostics } from "./runDiagnostics.js";
/** @typedef {import("./DiagnosticReport.ts").DiagnosticReport} DiagnosticReport */

/**
 * @param {string} command
 * @param {Record<string, string>} env
 * @param {string} cwd
 * @param {{ provider?: string; model?: string; apiKey?: string }} [hints]
 * @returns {Promise<DiagnosticReport> | null}
 */
export function launchDiagnostics(command, env, cwd, hints) {
    const strategy = getDiagnosticStrategy(command, hints);
    if (!strategy)
        return null;
    const apiKeyEnv = diagnosticApiKeyEnv(command, hints);
    const effectiveEnv = apiKeyEnv ? { ...env, ...apiKeyEnv } : env;
    return runDiagnostics(strategy, { env: effectiveEnv, cwd }).catch(() => null);
}
