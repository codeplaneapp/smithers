import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";

export const DETACHED_ADMISSION_NONCE_ENV = "SMITHERS_DETACHED_ADMISSION_NONCE";
export const DETACHED_ADMISSION_TIMEOUT_MS = 10_000;

const LOG_TAIL_BYTES = 32 * 1024;
const POLL_INTERVAL_MS = 50;

/**
 * @param {string} nonce
 */
export function detachedAdmissionMarker(nonce) {
    return `SMITHERS_DETACHED_ADMISSION=run:${nonce}`;
}

/**
 * @param {string} logFile
 * @param {number} [maxBytes]
 */
export function readDetachedLogTail(logFile, maxBytes = LOG_TAIL_BYTES) {
    if (!existsSync(logFile)) return "";
    let fd;
    try {
        fd = openSync(logFile, "r");
        const size = fstatSync(fd).size;
        const length = Math.min(size, Math.max(1, maxBytes));
        const buffer = Buffer.alloc(length);
        readSync(fd, buffer, 0, length, Math.max(0, size - length));
        return buffer.toString("utf8");
    }
    catch {
        try {
            return readFileSync(logFile, "utf8").slice(-maxBytes);
        }
        catch {
            return "";
        }
    }
    finally {
        if (fd !== undefined) closeSync(fd);
    }
}

/**
 * Wait until the engine child proves it persisted the run row. The child emits
 * the nonce from its RunStarted progress event, which is published only after
 * insertRun/activateRunForResume completes.
 *
 * @param {{
 *   child: import("node:child_process").ChildProcess;
 *   logFile: string;
 *   nonce: string;
 *   timeoutMs?: number;
 *   intervalMs?: number;
 * }} options
 * @returns {Promise<
 *   { admitted: true; tail: string } |
 *   { admitted: false; reason: string; tail: string }
 * >}
 */
export async function waitForDetachedAdmission(options) {
    const timeoutMs = Math.max(1, options.timeoutMs ?? DETACHED_ADMISSION_TIMEOUT_MS);
    const intervalMs = Math.max(1, options.intervalMs ?? POLL_INTERVAL_MS);
    const marker = detachedAdmissionMarker(options.nonce);
    const startedAt = Date.now();
    let childError;
    let wake;

    const onError = (error) => {
        childError = error instanceof Error ? error : new Error(String(error));
        wake?.();
    };
    const onExit = () => wake?.();
    options.child.on("error", onError);
    options.child.on("exit", onExit);

    try {
        while (true) {
            const tail = readDetachedLogTail(options.logFile);
            // The readiness proof wins over a later child exit: once RunStarted
            // was persisted, subsequent child death is handled by stale/orphan
            // detection and is outside launch admission.
            if (tail.includes(marker)) return { admitted: true, tail };

            if (childError) {
                return { admitted: false, reason: `Detached engine could not start: ${childError.message}`, tail };
            }
            if (options.child.exitCode !== null || options.child.signalCode !== null) {
                const status = options.child.signalCode
                    ? `signal ${options.child.signalCode}`
                    : `exit ${options.child.exitCode ?? "unknown"}`;
                return { admitted: false, reason: `Detached engine exited before admission (${status}).`, tail };
            }
            const elapsedMs = Date.now() - startedAt;
            if (elapsedMs >= timeoutMs) {
                return { admitted: false, reason: `Detached engine did not reach admission within ${timeoutMs}ms.`, tail };
            }

            await new Promise((resolvePromise) => {
                let settled = false;
                const finish = () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    wake = undefined;
                    resolvePromise(undefined);
                };
                const timer = setTimeout(finish, Math.min(intervalMs, timeoutMs - elapsedMs));
                wake = finish;
            });
        }
    }
    finally {
        options.child.off("error", onError);
        options.child.off("exit", onExit);
    }
}

/**
 * @param {import("node:child_process").ChildProcess} child
 */
export function terminateUnadmittedChild(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
        if (child.pid && process.platform !== "win32") {
            process.kill(-child.pid, "SIGTERM");
            return;
        }
    }
    catch { }
    try {
        child.kill("SIGTERM");
    }
    catch { }
}
