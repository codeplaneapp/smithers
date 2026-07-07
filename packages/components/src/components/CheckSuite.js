// @smithers-type-exports-begin
/** @typedef {import("./CheckSuiteProps.ts").CheckSuiteProps} CheckSuiteProps */
// @smithers-type-exports-end

import React from "react";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { SmithersContext } from "@smithers-orchestrator/react-reconciler/context";
import { Sequence } from "./Sequence.js";
import { Parallel } from "./Parallel.js";
import { Task } from "./Task.js";
/** @typedef {import("./CheckConfig.ts").CheckConfig} CheckConfig */

const execAsync = promisify(exec);

/**
 * Whether a single check's output row counts as a pass. A missing row (the
 * check never produced output) or an explicit failure signal counts as a fail.
 * @param {unknown} row
 * @returns {boolean}
 */
function checkPassed(row) {
    if (row == null)
        return false;
    if (typeof row === "object") {
        const r = /** @type {Record<string, unknown>} */ (row);
        if (r.passed === false || r.ok === false || r.failed === true)
            return false;
        if (r.error != null && r.error !== false)
            return false;
    }
    return true;
}

/**
 * Resolve the overall pass/fail verdict from the per-check pass count.
 * @param {"all-pass" | "majority" | "any-pass"} strategy
 * @param {number} passCount
 * @param {number} total
 * @returns {boolean}
 */
function resolveVerdict(strategy, passCount, total) {
    if (strategy === "any-pass")
        return passCount > 0;
    if (strategy === "majority")
        return passCount * 2 > total;
    return total > 0 && passCount === total;
}

/**
 * @param {CheckConfig[] | Record<string, Omit<CheckConfig, "id">>} checks
 * @returns {CheckConfig[]}
 */
function normalizeChecks(checks) {
    if (Array.isArray(checks))
        return checks;
    return Object.entries(checks).map(([key, cfg]) => ({
        id: key,
        ...cfg,
    }));
}
/**
 * Execute a shell check and convert the process result into the same pass/fail
 * shape used by agent checks, without failing the whole suite on a non-zero
 * exit code.
 * @param {string} command
 * @returns {Promise<Record<string, unknown>>}
 */
async function runCommandCheck(command) {
    try {
        const result = await execAsync(command, { maxBuffer: 1024 * 1024 });
        return {
            passed: true,
            ok: true,
            command,
            exitCode: 0,
            stdout: result.stdout,
            stderr: result.stderr,
        };
    }
    catch (error) {
        const err = /** @type {Error & { code?: unknown; signal?: unknown; stdout?: unknown; stderr?: unknown }} */ (error);
        return {
            passed: false,
            ok: false,
            command,
            exitCode: typeof err.code === "number" ? err.code : null,
            signal: typeof err.signal === "string" ? err.signal : null,
            stdout: typeof err.stdout === "string" ? err.stdout : "",
            stderr: typeof err.stderr === "string" ? err.stderr : "",
            error: err.message,
        };
    }
}
/**
 * <CheckSuite> — Parallel checks with auto-aggregated pass/fail verdict.
 *
 * Composes: Sequence > Parallel[Task per check] > Task(verdict aggregator)
 * @param {CheckSuiteProps} props
 */
export function CheckSuite(props) {
    if (props.skipIf)
        return null;
    const ctx = React.useContext(SmithersContext);
    const { id, checks, verdictOutput, strategy = "all-pass", maxConcurrency, continueOnFail = true, } = props;
    const prefix = id ?? "checksuite";
    const normalized = normalizeChecks(checks);
    // Build parallel check tasks
    const checkTasks = normalized.map((check) => {
        const taskId = `${prefix}-${check.id}`;
        const taskProps = {
            key: taskId,
            id: taskId,
            output: verdictOutput,
            continueOnFail,
            label: check.label ?? check.id,
        };
        if (check.command) {
            return React.createElement(Task, taskProps, () => runCommandCheck(check.command ?? ""));
        }
        const childContent = `Run check: ${check.label ?? check.id}`;
        if (check.agent) {
            taskProps.agent = check.agent;
        }
        return React.createElement(Task, taskProps, childContent);
    });
    const parallelEl = React.createElement(Parallel, { maxConcurrency }, ...checkTasks);
    // The verdict depends on every check. We use dependsOn (the mechanism the
    // graph extractor honors) so the verdict only runs once all checks have
    // produced output — a `needs` map alone is ignored when no `deps` are set.
    const checkIds = normalized.map((check) => `${prefix}-${check.id}`);
    // Compute the aggregate verdict from the per-check outputs. Reads are taken
    // from the workflow context at render time and captured in the closure; the
    // component re-renders reactively as each check's output becomes available,
    // and the engine defers execution until every dependency has completed.
    const verdictTask = React.createElement(Task, {
        id: `${prefix}-verdict`,
        output: verdictOutput,
        dependsOn: checkIds,
        label: "verdict",
    }, () => {
        let passCount = 0;
        const results = {};
        for (const check of normalized) {
            const checkId = `${prefix}-${check.id}`;
            const row = ctx?.outputMaybe(verdictOutput, { nodeId: checkId });
            const passed = checkPassed(row);
            results[check.id] = passed;
            if (passed)
                passCount += 1;
        }
        const total = normalized.length;
        return {
            passed: resolveVerdict(strategy, passCount, total),
            passCount,
            total,
            strategy,
            results,
        };
    });
    return React.createElement(Sequence, null, parallelEl, verdictTask);
}
