// @smithers-type-exports-begin
/** @typedef {import("@smithers-orchestrator/driver/RuntimeAdapter").RuntimeAdapter} RuntimeAdapter */
// @smithers-type-exports-end

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolveWorktreePath } from "@smithers-orchestrator/graph";
import { RuntimeCapabilityError } from "@smithers-orchestrator/driver/RuntimeCapabilityError";
import { createUnsupportedCapability } from "@smithers-orchestrator/driver/unsupportedCapability";
import { defaultTaskExecutor } from "@smithers-orchestrator/driver/defaultTaskExecutor";

/**
 * Storage that intentionally does nothing: the concrete Node engine already
 * persists run/output state durably through its own session + database layer
 * (outside the portable driver's `RuntimeAdapter` seam). Wiring a real
 * `storage` here would make `WorkflowDriver` start double-writing/merging
 * output snapshots the Node session already tracks, changing existing
 * behavior. `RuntimeAdapter.storage` is a required field, so this adapter
 * still exposes a spec-conformant (present, callable, void-returning)
 * implementation — it is simply a deliberate no-op for Node.
 * @returns {import("@smithers-orchestrator/driver/RuntimeAdapter").RuntimeStorage}
 */
function createNoopStorage() {
    return {
        async loadRun() {
            return undefined;
        },
        async saveRun() {},
        async loadOutputs() {
            return undefined;
        },
        async saveOutputs() {},
    };
}

/**
 * @param {string} command
 * @param {readonly string[]} [args]
 * @param {{ cwd?: string; env?: Record<string, string> }} [opts]
 * @returns {Promise<import("@smithers-orchestrator/driver/RuntimeAdapter").RuntimeSubprocessResult>}
 */
function runSubprocess(command, args = [], opts) {
    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(command, [...args], {
            cwd: opts?.cwd,
            env: opts?.env ? { ...process.env, ...opts.env } : process.env,
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr?.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        child.once("error", rejectPromise);
        child.once("close", (exitCode) => {
            resolvePromise({ stdout, stderr, exitCode: exitCode ?? 0 });
        });
    });
}

/**
 * Build the concrete Node `RuntimeAdapter` used by the production engine: a
 * `worktree.resolve` that wraps the real, untouched
 * `resolveWorktreePath` (so `<Worktree>` resolution behaves exactly as it did
 * before `RuntimeAdapter` existed), real `node:fs`/`node:child_process`
 * filesystem and subprocess capabilities, `crypto.randomUUID`, and real
 * `Date`/`performance` timing. `storage` is a deliberate no-op (see
 * {@link createNoopStorage}) and `sandbox` is not yet bridged to
 * `@smithers-orchestrator/sandbox` from this seam, so it fails closed with a
 * typed `RuntimeCapabilityError` rather than silently doing nothing.
 * @returns {RuntimeAdapter}
 */
export function createNodeRuntime() {
    const runtimeName = "node";
    return {
        name: runtimeName,
        clock: {
            now: () => Date.now(),
            monotonicNow: () => performance.now(),
            sleep(ms, signal) {
                if (signal?.aborted) {
                    const error = new Error("Task aborted");
                    error.name = "AbortError";
                    return Promise.reject(error);
                }
                if (ms <= 0)
                    return Promise.resolve();
                return new Promise((resolvePromise, rejectPromise) => {
                    const timer = setTimeout(() => {
                        signal?.removeEventListener("abort", onAbort);
                        resolvePromise();
                    }, ms);
                    function onAbort() {
                        clearTimeout(timer);
                        const error = new Error("Task aborted");
                        error.name = "AbortError";
                        rejectPromise(error);
                    }
                    signal?.addEventListener("abort", onAbort, { once: true });
                });
            },
        },
        storage: createNoopStorage(),
        uuid: () => randomUUID(),
        executeTask: defaultTaskExecutor,
        filesystem: {
            readFile: (path) => readFile(path, "utf8"),
            writeFile: (path, contents) => writeFile(path, contents, "utf8"),
            async exists(path) {
                return existsSync(path);
            },
            mkdir: (path, opts) => mkdir(path, { recursive: opts?.recursive ?? false }).then(() => undefined),
        },
        subprocess: {
            spawn: (command, args, opts) => runSubprocess(command, args, opts),
        },
        worktree: {
            resolve: (path, opts) => resolveWorktreePath(path, opts),
        },
        sandbox: /** @type {import("@smithers-orchestrator/driver/RuntimeAdapter").RuntimeSandbox} */ (createUnsupportedCapability(runtimeName, "sandbox", ["run"], "async")),
    };
}
