import { spawn } from "node:child_process";

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_KILL_GRACE_MS = 250;

/**
 * @typedef {{
 *   status: number | null;
 *   signal: NodeJS.Signals | null;
 *   spawnError: Error | null;
 *   stdout: string;
 *   stderr: string;
 *   stdoutTruncated: boolean;
 *   stderrTruncated: boolean;
 *   aborted: boolean;
 *   timedOut: boolean;
 * }} DiagnosticCommandResult
 */

/**
 * @typedef {{
 *   env?: Record<string, string>;
 *   cwd?: string;
 *   signal?: AbortSignal;
 *   timeoutMs?: number;
 *   maxOutputBytes?: number;
 *   killGraceMs?: number;
 * }} DiagnosticCommandOptions
 */

/**
 * @param {number} maxBytes
 */
function createBoundedCapture(maxBytes) {
    /** @type {Buffer[]} */
    const chunks = [];
    let capturedBytes = 0;
    let truncated = false;

    /** @param {Buffer | string} chunk */
    function append(chunk) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = Math.max(0, maxBytes - capturedBytes);
        if (remaining > 0) {
            const captured = buffer.subarray(0, remaining);
            chunks.push(captured);
            capturedBytes += captured.byteLength;
        }
        if (buffer.byteLength > remaining) {
            truncated = true;
        }
    }

    return {
        append,
        text: () => Buffer.concat(chunks, capturedBytes).toString("utf8"),
        truncated: () => truncated,
    };
}

/**
 * Kill the whole process group on POSIX so a diagnostic executable cannot
 * leave descendants behind. Windows' child.kill() terminates the process.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {NodeJS.Signals} signal
 */
function killDiagnosticProcess(child, signal) {
    if (child.pid == null)
        return;
    if (process.platform !== "win32") {
        try {
            process.kill(-child.pid, signal);
            return;
        }
        catch {
            // The child may still exist when its detached process group is not
            // observable yet, so always fall back to killing the direct PID.
        }
    }
    try {
        child.kill(signal);
    }
    catch {
        // The process may have exited between the close check and kill call.
    }
}

/**
 * Run a diagnostic subprocess without a shell. Output is always drained but
 * only a bounded prefix is retained. Aborts and command timeouts terminate the
 * process with SIGTERM, escalate to SIGKILL after a short grace period, and
 * resolve only after the child has closed.
 *
 * @param {string} command
 * @param {string[]} [args]
 * @param {DiagnosticCommandOptions} [options]
 * @returns {Promise<DiagnosticCommandResult>}
 */
export function runDiagnosticCommand(command, args = [], options = {}) {
    const maxOutputBytes = Number.isFinite(options.maxOutputBytes)
        ? Math.max(0, Math.floor(options.maxOutputBytes ?? 0))
        : DEFAULT_MAX_OUTPUT_BYTES;
    const killGraceMs = Number.isFinite(options.killGraceMs)
        ? Math.max(0, Math.floor(options.killGraceMs ?? 0))
        : DEFAULT_KILL_GRACE_MS;
    const emptyResult = {
        status: null,
        signal: null,
        spawnError: null,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        aborted: options.signal?.aborted === true,
        timedOut: false,
    };
    if (options.signal?.aborted) {
        return Promise.resolve(emptyResult);
    }

    return new Promise((resolve) => {
        const stdout = createBoundedCapture(maxOutputBytes);
        const stderr = createBoundedCapture(maxOutputBytes);
        let child;
        try {
            child = spawn(command, args, {
                cwd: options.cwd,
                env: options.env,
                shell: false,
                detached: process.platform !== "win32",
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
            });
        }
        catch (error) {
            resolve({
                ...emptyResult,
                spawnError: error instanceof Error ? error : new Error(String(error)),
            });
            return;
        }

        let spawnError = null;
        let aborted = false;
        let timedOut = false;
        let closed = false;
        let terminating = false;
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let timeoutHandle;
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let killHandle;

        const onStdout = (/** @type {Buffer} */ chunk) => stdout.append(chunk);
        const onStderr = (/** @type {Buffer} */ chunk) => stderr.append(chunk);
        child.stdout.on("data", onStdout);
        child.stderr.on("data", onStderr);

        const cleanup = () => {
            clearTimeout(timeoutHandle);
            clearTimeout(killHandle);
            options.signal?.removeEventListener("abort", onAbort);
            child.stdout.removeListener("data", onStdout);
            child.stderr.removeListener("data", onStderr);
            child.removeListener("error", onError);
            child.removeListener("close", onClose);
        };

        const terminate = () => {
            if (closed || terminating || child.pid == null)
                return;
            terminating = true;
            killDiagnosticProcess(child, "SIGTERM");
            killHandle = setTimeout(() => {
                if (!closed)
                    killDiagnosticProcess(child, "SIGKILL");
            }, killGraceMs);
            killHandle.unref?.();
        };

        const onAbort = () => {
            if (aborted)
                return;
            aborted = true;
            terminate();
        };
        const onError = (/** @type {Error} */ error) => {
            spawnError = error;
        };
        const onClose = (/** @type {number | null} */ status, /** @type {NodeJS.Signals | null} */ signal) => {
            closed = true;
            cleanup();
            resolve({
                status: spawnError ? null : status,
                signal: spawnError ? null : (signal ?? null),
                spawnError,
                stdout: stdout.text(),
                stderr: stderr.text(),
                stdoutTruncated: stdout.truncated(),
                stderrTruncated: stderr.truncated(),
                aborted,
                timedOut,
            });
        };

        child.once("error", onError);
        child.once("close", onClose);
        options.signal?.addEventListener("abort", onAbort, { once: true });

        if (options.timeoutMs != null && Number.isFinite(options.timeoutMs)) {
            timeoutHandle = setTimeout(() => {
                timedOut = true;
                terminate();
            }, Math.max(0, options.timeoutMs));
            timeoutHandle.unref?.();
        }

        // The signal can flip between the pre-spawn check and listener setup.
        if (options.signal?.aborted)
            onAbort();
    });
}
