import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
/** @typedef {import("./getDiagnosticStrategy.js").AgentDiagnosticStrategy} AgentDiagnosticStrategy */
/** @typedef {import("./DiagnosticCheck.ts").DiagnosticCheck} DiagnosticCheck */
/** @typedef {import("./getDiagnosticStrategy.js").DiagnosticCheckDef} DiagnosticCheckDef */
/** @typedef {import("./DiagnosticContext.ts").DiagnosticContext} DiagnosticContext */
/** @typedef {import("./DiagnosticReport.ts").DiagnosticReport} DiagnosticReport */

const PER_CHECK_TIMEOUT_MS = 5_000;
const ABORT_CLEANUP_TIMEOUT_MS = 500;
/**
 * @param {DiagnosticCheckDef} check
 * @param {DiagnosticContext} ctx
 * @returns {Promise<DiagnosticCheck>}
 */
async function runCheck(check, ctx) {
    const start = performance.now();
    const controller = new AbortController();
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timeoutHandle;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let cleanupHandle;
    /** @type {Promise<DiagnosticCheck> | undefined} */
    let execution;
    let timeoutStarted = false;
    try {
        const timeoutError = new SmithersError("AGENT_DIAGNOSTIC_TIMEOUT", "diagnostic check timed out", { timeoutMs: PER_CHECK_TIMEOUT_MS });
        const timeout = new Promise((_, reject) => {
            timeoutHandle = setTimeout(async () => {
                timeoutStarted = true;
                controller.abort(timeoutError);
                if (execution) {
                    await Promise.race([
                        execution.catch(() => undefined),
                        new Promise((resolve) => {
                            cleanupHandle = setTimeout(resolve, ABORT_CLEANUP_TIMEOUT_MS);
                        }),
                    ]);
                    clearTimeout(cleanupHandle);
                    cleanupHandle = undefined;
                }
                reject(timeoutError);
            }, PER_CHECK_TIMEOUT_MS);
            timeoutHandle.unref?.();
        });
        execution = Promise.resolve().then(() => check.run({
            ...ctx,
            signal: controller.signal,
        }));
        const executionBeforeTimeout = execution.then((result) => timeoutStarted
            ? new Promise(() => { })
            : result, (error) => timeoutStarted
            ? new Promise(() => { })
            : Promise.reject(error));
        return await Promise.race([
            executionBeforeTimeout,
            timeout,
        ]);
    }
    catch (err) {
        return {
            id: check.id,
            status: "error",
            message: err instanceof Error ? err.message : String(err),
            ...(err instanceof SmithersError ? { detail: { errorCode: err.code, ...err.details } } : {}),
            durationMs: performance.now() - start,
        };
    }
    finally {
        clearTimeout(timeoutHandle);
        clearTimeout(cleanupHandle);
        if (!controller.signal.aborted)
            controller.abort();
    }
}
/**
 * @param {AgentDiagnosticStrategy} strategy
 * @param {DiagnosticContext} ctx
 * @returns {Promise<DiagnosticReport>}
 */
export async function runDiagnostics(strategy, ctx) {
    const start = performance.now();
    const results = await Promise.all(strategy.checks.map((check) => runCheck(check, ctx)));
    return {
        agentId: strategy.agentId,
        command: strategy.command,
        timestamp: new Date().toISOString(),
        checks: results,
        durationMs: performance.now() - start,
    };
}
