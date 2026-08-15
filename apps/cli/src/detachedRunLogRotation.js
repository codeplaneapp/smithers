import { closeSync, fstatSync, ftruncateSync, openSync, readSync, statSync, writeSync } from "node:fs";
import { DETACHED_RUN_LOG_FILE_ENV } from "./detachedRunLogEnv.js";

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_CHECK_INTERVAL_MS = 5_000;
const MAX_PRESERVED_TAIL_BYTES = 1024 * 1024;
const INTERNAL_CHECK_INTERVAL_ENV = "SMITHERS_INTERNAL_DETACHED_LOG_CAP_INTERVAL_MS";

/** @param {string | undefined} raw @param {number} fallback */
function nonNegativeInteger(raw, fallback) {
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

/**
 * Keep one active detached run from filling the volume. The inherited stdout
 * descriptor is opened with O_APPEND, so truncating that descriptor keeps all
 * future output (including output from agent descendants) on the same inode.
 * A bounded tail is appended after the notice to retain the most useful recent
 * diagnostics without allocating a buffer as large as the configured cap.
 *
 * The path/inode check prevents a replaced path or a forged internal env value
 * from making the child truncate an unrelated file.
 *
 * @param {{
 *   logFile?: string;
 *   fd?: number;
 *   env?: NodeJS.ProcessEnv;
 *   warn?: (line: string) => void;
 * }} [options]
 */
export function capDetachedRunLog(options = {}) {
  const env = options.env ?? process.env;
  const logFile = options.logFile ?? env[DETACHED_RUN_LOG_FILE_ENV];
  const fd = options.fd ?? 1;
  const maxBytes = nonNegativeInteger(env.SMITHERS_LOG_MAX_BYTES, DEFAULT_MAX_BYTES);
  if (!logFile || maxBytes === 0) {
    return { capped: false, logFile: logFile ?? null, maxBytes, beforeBytes: 0, afterBytes: 0 };
  }

  let readFd;
  try {
    const descriptorStat = fstatSync(fd);
    const pathStat = statSync(logFile);
    if (
      !descriptorStat.isFile() ||
      !pathStat.isFile() ||
      descriptorStat.dev !== pathStat.dev ||
      descriptorStat.ino !== pathStat.ino
    ) {
      return { capped: false, logFile, maxBytes, beforeBytes: pathStat.size, afterBytes: pathStat.size };
    }
    const beforeBytes = descriptorStat.size;
    if (beforeBytes <= maxBytes) {
      return { capped: false, logFile, maxBytes, beforeBytes, afterBytes: beforeBytes };
    }

    const fullNotice = Buffer.from(
      `\n[smithers] Detached log exceeded ${maxBytes} bytes; older output was truncated.\n`,
      "utf8",
    );
    const notice = fullNotice.subarray(0, Math.min(fullNotice.length, maxBytes));
    const tailBytes = Math.min(MAX_PRESERVED_TAIL_BYTES, Math.floor(maxBytes / 2), maxBytes - notice.length);
    const tail = Buffer.allocUnsafe(Math.max(0, tailBytes));
    let tailLength = 0;
    if (tail.length > 0) {
      readFd = openSync(logFile, "r");
      const readStat = fstatSync(readFd);
      if (readStat.dev !== descriptorStat.dev || readStat.ino !== descriptorStat.ino) {
        return { capped: false, logFile, maxBytes, beforeBytes, afterBytes: beforeBytes };
      }
      let position = Math.max(0, beforeBytes - tail.length);
      while (tailLength < tail.length) {
        const count = readSync(readFd, tail, tailLength, tail.length - tailLength, position + tailLength);
        if (count === 0) break;
        tailLength += count;
      }
    }

    ftruncateSync(fd, 0);
    if (notice.length > 0) writeSync(fd, notice);
    if (tailLength > 0) writeSync(fd, tail.subarray(0, tailLength));
    const afterBytes = fstatSync(fd).size;
    return { capped: true, logFile, maxBytes, beforeBytes, afterBytes };
  } catch (error) {
    try {
      options.warn?.(
        `[smithers] Warning: detached log cap could not inspect ${logFile}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    } catch {}
    return { capped: false, logFile, maxBytes, beforeBytes: 0, afterBytes: 0 };
  } finally {
    if (readFd !== undefined) {
      try {
        closeSync(readFd);
      } catch {}
    }
  }
}

/**
 * Start best-effort active-log rotation in a detached child. The unref'd timer
 * follows the run process lifetime but never keeps a completed run alive.
 *
 * @param {{
 *   logFile?: string;
 *   fd?: number;
 *   env?: NodeJS.ProcessEnv;
 *   intervalMs?: number;
 *   warn?: (line: string) => void;
 * }} [options]
 */
export function startDetachedRunLogRotation(options = {}) {
  const env = options.env ?? process.env;
  const logFile = options.logFile ?? env[DETACHED_RUN_LOG_FILE_ENV];
  const maxBytes = nonNegativeInteger(env.SMITHERS_LOG_MAX_BYTES, DEFAULT_MAX_BYTES);
  if (!logFile || maxBytes === 0) return null;
  const rotate = () => capDetachedRunLog({ ...options, env, logFile });
  rotate();
  const intervalMs = Math.max(
    100,
    options.intervalMs ?? nonNegativeInteger(env[INTERNAL_CHECK_INTERVAL_ENV], DEFAULT_CHECK_INTERVAL_MS),
  );
  const timer = setInterval(rotate, intervalMs);
  timer.unref?.();
  process.once("exit", rotate);
  return timer;
}
