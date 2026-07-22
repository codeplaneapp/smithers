import { spawn } from "node:child_process";
import { Effect, Metric } from "effect";
import { ignoreSyncError } from "./interop.js";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { toolOutputTruncatedTotal } from "@smithers-orchestrator/observability/metrics";
import { logDebug, logWarning } from "@smithers-orchestrator/observability/logging";
/** @typedef {import("./SpawnCaptureOptions.ts").SpawnCaptureOptions} SpawnCaptureOptions */
/** @typedef {import("./SpawnCaptureResult.ts").SpawnCaptureResult} SpawnCaptureResult */

// Bounds captured stdout/stderr per stream when the caller does not set maxOutputBytes.
const DEFAULT_MAX_OUTPUT_BYTES = 200_000;
// Bun can deliver child stdout/stderr chunks late on macOS; any configured idle
// timeout >= BUN_IDLE_FLOOR_MIN_CONFIGURED_MS is floored up to BUN_IDLE_FLOOR_MS
// under Bun so active CLI agents are not killed before their output reaches JS.
const BUN_IDLE_FLOOR_MS = 5000;
const BUN_IDLE_FLOOR_MIN_CONFIGURED_MS = 1000;
const SENSITIVE_FLAG = /(?:^|[-_])(api[-_]?key|token|secret|password)(?:$|[-_=])/i;

/** @param {unknown} cause @returns {unknown} */
function sanitizeSpawnCause(cause) {
    if (!(cause instanceof Error))
        return cause;
    const safe = new Error(cause.message);
    // Assign `name` only when it deviates from Error's inherited default:
    // an unconditional write would create an own property the original error
    // never had, changing its serialized shape beyond the spawnargs removal.
    if (cause.name !== safe.name)
        safe.name = cause.name;
    if (cause.stack)
        safe.stack = cause.stack;
    for (const key of Object.keys(cause)) {
        if (key !== "spawnargs" && key !== "name")
            safe[key] = cause[key];
    }
    return safe;
}

/** @param {string[]} args @returns {string[]} */
export function sanitizeCliArgs(args) {
    const sanitized = [];
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        const equals = arg.indexOf("=");
        const flag = equals >= 0 ? arg.slice(0, equals) : arg;
        if (SENSITIVE_FLAG.test(flag)) {
            sanitized.push(equals >= 0 ? `${flag}=[REDACTED]` : arg);
            if (equals < 0 && index + 1 < args.length) {
                sanitized.push("[REDACTED]");
                index += 1;
            }
        }
        else {
            sanitized.push(arg);
        }
    }
    return sanitized;
}

/**
 * @param {string} text
 * @param {number} maxBytes
 * @param {"head" | "tail"} [keep] Which end of the buffer to retain when truncating
 *   (default "head"; stderr always keeps the head so failure classification can
 *   read the leading error text).
 * @returns {string}
 */
function truncateToBytes(text, maxBytes, keep = "head") {
    const buf = Buffer.from(text, "utf8");
    if (buf.length <= maxBytes)
        return text;
    if (keep === "tail") {
        // Skip forward past UTF-8 continuation bytes (0b10xxxxxx) so the kept
        // tail starts on a codepoint boundary instead of decoding to U+FFFD.
        let start = buf.length - maxBytes;
        while (start < buf.length && (buf[start] & 0xc0) === 0x80)
            start++;
        return buf.subarray(start).toString("utf8");
    }
    // Back off any continuation bytes so the slice ends on a codepoint
    // boundary, then drop the lead byte if its sequence is incomplete.
    let end = maxBytes;
    while (end > 0 && (buf[end] & 0xc0) === 0x80)
        end--;
    if (end > 0) {
        const lead = buf[end - 1];
        let seqLen = 1;
        if ((lead & 0xe0) === 0xc0)
            seqLen = 2;
        else if ((lead & 0xf0) === 0xe0)
            seqLen = 3;
        else if ((lead & 0xf8) === 0xf0)
            seqLen = 4;
        if ((end - 1) + seqLen > maxBytes)
            end--;
    }
    return buf.subarray(0, end).toString("utf8");
}
/**
 * @param {import("node:child_process").ChildProcess} child
 * @param {boolean} detached
 */
export function killChildTree(child, detached) {
    if (!child.pid) {
        child.kill("SIGKILL");
        return;
    }
    if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
        });
        killer.on("error", () => {
            try {
                child.kill("SIGKILL");
            }
            catch {
                // ignore
            }
        });
        killer.on("exit", (code) => {
            if (code === 0) {
                return;
            }
            try {
                child.kill("SIGKILL");
            }
            catch {
                // ignore
            }
        });
        return;
    }
    if (detached) {
        process.kill(-child.pid, "SIGKILL");
    }
    else {
        child.kill("SIGKILL");
    }
}
/**
 * @param {string} command
 * @param {string[]} args
 * @param {SpawnCaptureOptions} options
 * @returns {Effect.Effect<SpawnCaptureResult, SmithersError>}
 */
export function spawnCaptureEffect(command, args, options) {
    const { cwd, env, input, signal, timeoutMs, idleTimeoutMs, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES, truncateKeep = "head", detached = false, onStdout, onStderr, onProcess, } = options;
    const safeArgs = sanitizeCliArgs(args);
    const errorDetails = {
        command,
        args: safeArgs,
        cwd,
        timeoutMs,
        idleTimeoutMs,
    };
    const logAnnotations = {
        command,
        args: safeArgs.join(" "),
        cwd,
        timeoutMs: timeoutMs ?? null,
        idleTimeoutMs: idleTimeoutMs ?? null,
    };
    const span = `process:${command}`;
    return (Effect.async((resume) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        let stdoutTruncated = false;
        let stderrTruncated = false;
        logDebug("spawning child process", logAnnotations, span);
        const child = spawn(command, args, {
            cwd,
            env,
            detached,
            stdio: ["pipe", "pipe", "pipe"],
        });
        onProcess?.({ phase: "started", pid: child.pid });
        /**
     * @param {string} reason
     * @param {"PROCESS_ABORTED" | "PROCESS_TIMEOUT" | "PROCESS_IDLE_TIMEOUT"} code
     */
        const kill = (reason, code) => {
            logWarning("child process interrupted", {
                ...logAnnotations,
                reason,
                errorCode: code,
            }, span);
            try {
                killChildTree(child, detached);
            }
            catch {
                try {
                    child.kill("SIGKILL");
                }
                catch {
                    // ignore
                }
            }
            if (!settled) {
                settled = true;
                onProcess?.({ phase: "exited", pid: child.pid });
                resume(Effect.fail(new SmithersError(code, reason, errorDetails)));
            }
        };
        let totalTimer;
        let idleTimer;
        let idleGeneration = 0;
        const effectiveIdleTimeoutMs = typeof process.versions.bun === "string" && idleTimeoutMs >= BUN_IDLE_FLOOR_MIN_CONFIGURED_MS
            ? Math.max(idleTimeoutMs, BUN_IDLE_FLOOR_MS)
            : idleTimeoutMs;
        const resetIdle = () => {
            if (idleTimer)
                clearTimeout(idleTimer);
            if (effectiveIdleTimeoutMs) {
                idleGeneration += 1;
                const generation = idleGeneration;
                idleTimer = setTimeout(() => {
                    if (generation !== idleGeneration) {
                        return;
                    }
                    kill(`CLI idle timed out after ${effectiveIdleTimeoutMs}ms`, "PROCESS_IDLE_TIMEOUT");
                }, effectiveIdleTimeoutMs);
            }
        };
        if (timeoutMs) {
            totalTimer = setTimeout(() => {
                kill(`CLI timed out after ${timeoutMs}ms`, "PROCESS_TIMEOUT");
            }, timeoutMs);
        }
        resetIdle();
        /**
     * @param {SpawnCaptureResult} result
     */
        const finalize = (result) => {
            if (settled)
                return;
            settled = true;
            onProcess?.({ phase: "exited", pid: child.pid });
            if (totalTimer)
                clearTimeout(totalTimer);
            if (idleTimer)
                clearTimeout(idleTimer);
            logDebug("child process completed", {
                ...logAnnotations,
                exitCode: result.exitCode,
                stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
                stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
            }, span);
            let truncationCount = 0;
            if (stdoutTruncated)
                truncationCount++;
            if (stderrTruncated)
                truncationCount++;
            resume(Effect.succeed({ result, truncationCount }));
        };
        if (signal) {
            if (signal.aborted) {
                kill("CLI aborted", "PROCESS_ABORTED");
            }
            else {
                signal.addEventListener("abort", () => kill("CLI aborted", "PROCESS_ABORTED"), {
                    once: true,
                });
            }
        }
        child.stdout?.on("data", (chunk) => {
            resetIdle();
            const text = chunk.toString("utf8");
            const nextStdout = stdout + text;
            if (!stdoutTruncated && Buffer.byteLength(nextStdout, "utf8") > maxOutputBytes) {
                stdoutTruncated = true;
                logWarning("child process stdout truncated", {
                    ...logAnnotations,
                    maxOutputBytes,
                    stream: "stdout",
                }, span);
            }
            stdout = truncateToBytes(nextStdout, maxOutputBytes, truncateKeep);
            onStdout?.(text);
        });
        child.stderr?.on("data", (chunk) => {
            resetIdle();
            const text = chunk.toString("utf8");
            const nextStderr = stderr + text;
            if (!stderrTruncated && Buffer.byteLength(nextStderr, "utf8") > maxOutputBytes) {
                stderrTruncated = true;
                logWarning("child process stderr truncated", {
                    ...logAnnotations,
                    maxOutputBytes,
                    stream: "stderr",
                }, span);
            }
            stderr = truncateToBytes(nextStderr, maxOutputBytes);
            onStderr?.(text);
        });
        child.on("error", (error) => {
            if (totalTimer)
                clearTimeout(totalTimer);
            if (idleTimer)
                clearTimeout(idleTimer);
            if (!settled) {
                settled = true;
                const smithersError = toSmithersError(sanitizeSpawnCause(error), `spawn ${command}`, {
                    code: "PROCESS_SPAWN_FAILED",
                    details: errorDetails,
                });
                logWarning("failed to spawn child process", {
                    ...logAnnotations,
                    error: smithersError.message,
                }, span);
                resume(Effect.fail(smithersError));
            }
        });
        child.on("close", (code) => {
            finalize({ stdout, stderr, exitCode: code ?? null, stdoutTruncated, stderrTruncated });
        });
        child.stdin?.on("error", (error) => {
            logWarning("child process stdin error", {
                ...logAnnotations,
                error: error instanceof Error ? error.message : String(error),
            }, span);
        });
        if (input) {
            child.stdin?.write(input);
        }
        child.stdin?.end();
        return Effect.gen(function* () {
            if (totalTimer)
                clearTimeout(totalTimer);
            if (idleTimer)
                clearTimeout(idleTimer);
            if (!settled) {
                yield* Effect.try({
                    try: () => {
                        killChildTree(child, detached);
                    },
                    catch: (cause) => toSmithersError(cause, "kill process group", {
                        code: "PROCESS_ABORTED",
                        details: errorDetails,
                    }),
                }).pipe(Effect.catchAll(() => ignoreSyncError("kill fallback", () => child.kill("SIGKILL"))));
            }
        });
    })).pipe(Effect.tap(({ truncationCount }) => truncationCount > 0
        ? Metric.incrementBy(toolOutputTruncatedTotal, truncationCount)
        : Effect.void), Effect.map(({ result }) => result), Effect.annotateLogs(logAnnotations), Effect.withLogSpan(span));
}
