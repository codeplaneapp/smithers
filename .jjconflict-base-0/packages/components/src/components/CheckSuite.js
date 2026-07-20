// @smithers-type-exports-begin
/** @typedef {import("./CheckSuiteProps.ts").CheckSuiteProps} CheckSuiteProps */
// @smithers-type-exports-end

import React from "react";
import { spawn } from "node:child_process";
import { SmithersContext } from "@smithers-orchestrator/react-reconciler/context";
import { getTaskRuntime } from "@smithers-orchestrator/driver/task-runtime";
import { Sequence } from "./Sequence.js";
import { Parallel } from "./Parallel.js";
import { Task } from "./Task.js";
/** @typedef {import("./CheckConfig.ts").CheckConfig} CheckConfig */

const COMMAND_MAX_BUFFER = 16 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Keep the most recent bytes from a process stream without retaining the
 * entire output in memory. The child process must keep running after the cap
 * is reached so its eventual exit code remains trustworthy.
 * @param {number} maxBytes
 * @returns {{append: (chunk: Uint8Array | string) => void, toString: () => string, truncated: boolean}}
 */
function createTailBuffer(maxBytes) {
    const buffer = Buffer.allocUnsafe(maxBytes);
    let start = 0;
    let length = 0;
    let totalBytes = 0;
    let truncated = false;

    return {
        append(chunk) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            totalBytes += bytes.length;
            if (bytes.length === 0)
                return;
            if (maxBytes === 0) {
                truncated = true;
                return;
            }
            if (bytes.length >= maxBytes) {
                bytes.subarray(bytes.length - maxBytes).copy(buffer);
                start = 0;
                length = maxBytes;
                if (totalBytes > maxBytes)
                    truncated = true;
                return;
            }
            const writeAt = (start + length) % maxBytes;
            const firstLength = Math.min(bytes.length, maxBytes - writeAt);
            bytes.copy(buffer, writeAt, 0, firstLength);
            if (firstLength < bytes.length)
                bytes.copy(buffer, 0, firstLength);
            if (length + bytes.length > maxBytes) {
                start = (start + length + bytes.length - maxBytes) % maxBytes;
                length = maxBytes;
                truncated = true;
            }
            else {
                length += bytes.length;
            }
            if (totalBytes > maxBytes)
                truncated = true;
        },
        toString() {
            if (length === 0)
                return "";
            const output = Buffer.allocUnsafe(length);
            const firstLength = Math.min(length, maxBytes - start);
            buffer.copy(output, 0, start, start + firstLength);
            if (firstLength < length)
                buffer.copy(output, firstLength, 0, length - firstLength);
            // A byte stream can be cut at an arbitrary UTF-8 boundary when the
            // tail rolls over. Drop continuation bytes at the front rather
            // than returning a replacement character for a partial codepoint.
            let boundary = 0;
            while (boundary < output.length && (output[boundary] & 0xc0) === 0x80)
                boundary++;
            return output.subarray(boundary).toString("utf8");
        },
        get truncated() {
            return truncated;
        },
    };
}

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
 * @param {number} [timeoutMs] - Kill the command after this many milliseconds; `0` disables the timeout.
 * @returns {Promise<Record<string, unknown>>}
 */
async function runCommandCheck(command, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    const runtime = getTaskRuntime();
    const cwd = runtime?.rootDir ?? process.cwd();
    return await new Promise((resolve) => {
        const stdout = createTailBuffer(COMMAND_MAX_BUFFER);
        const stderr = createTailBuffer(COMMAND_MAX_BUFFER);
        let child;
        try {
            child = spawn(command, {
                cwd,
                shell: true,
                stdio: ["ignore", "pipe", "pipe"],
            });
        }
        catch (error) {
            const err = /** @type {Error} */ (error);
            resolve({
                passed: false,
                ok: false,
                command,
                exitCode: null,
                signal: null,
                stdout: "",
                stderr: "",
                error: err.message,
            });
            return;
        }
        let spawnError = null;
        let timedOut = false;
        const timer = timeoutMs > 0
            ? setTimeout(() => {
                timedOut = true;
                child.kill("SIGTERM");
                const hardKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
                hardKill.unref?.();
            }, timeoutMs)
            : null;
        timer?.unref?.();
        const onAbort = () => child.kill("SIGTERM");
        runtime?.signal?.addEventListener?.("abort", onAbort, { once: true });
        child.stdout?.on("data", (chunk) => stdout.append(chunk));
        child.stderr?.on("data", (chunk) => stderr.append(chunk));
        child.on("error", (error) => {
            spawnError = /** @type {Error} */ (error);
        });
        child.on("close", (exitCode, signal) => {
            if (timer) clearTimeout(timer);
            runtime?.signal?.removeEventListener?.("abort", onAbort);
            const actualExitCode = typeof exitCode === "number" ? exitCode : null;
            const actualSignal = typeof signal === "string" ? signal : null;
            const passed = spawnError == null && actualExitCode === 0 && actualSignal == null;
            const result = {
                passed,
                ok: passed,
                command,
                exitCode: actualExitCode,
                signal: actualSignal,
                stdout: stdout.toString(),
                stderr: stderr.toString(),
            };
            if (spawnError) {
                result.error = spawnError.message;
            }
            else if (!passed) {
                result.error = actualSignal
                    ? `Command terminated by ${actualSignal}`
                    : `Command exited with code ${actualExitCode ?? "unknown"}`;
            }
            if (timedOut) {
                result.passed = false;
                result.ok = false;
                result.timedOut = true;
                result.error = `Command exceeded the ${timeoutMs}ms timeout and was killed`;
            }
            if (stdout.truncated || stderr.truncated) {
                result.truncated = true;
                result.diagnostic = `Command output exceeded the ${COMMAND_MAX_BUFFER}-byte capture limit; only the tail was retained`;
            }
            resolve(result);
        });
    });
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
            return React.createElement(Task, taskProps, () => runCommandCheck(check.command ?? "", check.timeoutMs));
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
