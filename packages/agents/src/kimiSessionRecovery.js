import { existsSync, readdirSync, statSync, cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Default cap on total bytes copied for one session's on-disk state (64 MiB). */
export const KIMI_SESSION_COPY_DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
/** Default cap on files copied for one session's on-disk state. */
export const KIMI_SESSION_COPY_DEFAULT_MAX_FILES = 5000;
/** Default cap on directories visited while discovering session state. */
export const KIMI_SESSION_WALK_DEFAULT_MAX_DIRECTORIES = 1000;

/**
 * @typedef {{
 *   maxBytes?: number;
 *   maxFiles?: number;
 *   maxDirectories?: number;
 * }} KimiSessionIoBounds
 */

const SESSION_ID_PATTERN = /^[0-9a-zA-Z][0-9a-zA-Z._-]{7,127}$/;

/**
 * Validate a candidate session id before it is published or used in a path.
 * Rejects path separators, traversal, and implausible shapes.
 *
 * @param {unknown} value
 * @returns {value is string}
 */
export function isPlausibleKimiSessionId(value) {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value) && !value.includes("..");
}

/**
 * Extract a session id from one line of Kimi CLI output. Matches the
 * CLI's own resume hint ("To resume this session: kimi -r <id>") and
 * structured `"session"` / `"session_id"` JSON fields.
 *
 * @param {string} line
 * @returns {string | undefined}
 */
export function extractKimiSessionIdFromLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  const hint = /kimi\s+-r\s+([0-9a-zA-Z][0-9a-zA-Z._-]{7,127})/i.exec(trimmed);
  if (hint && isPlausibleKimiSessionId(hint[1])) return hint[1];
  const sessionFlag = /--session\s+([0-9a-zA-Z][0-9a-zA-Z._-]{7,127})/.exec(trimmed);
  if (sessionFlag && isPlausibleKimiSessionId(sessionFlag[1])) return sessionFlag[1];
  if (trimmed.startsWith("{")) {
    try {
      const payload = JSON.parse(trimmed);
      if (payload && typeof payload === "object") {
        const record = /** @type {Record<string, unknown>} */ (payload);
        for (const key of ["session_id", "sessionId", "session"]) {
          const value = record[key];
          if (typeof value === "string" && isPlausibleKimiSessionId(value)) return value;
        }
      }
    } catch {
      // Not JSON; fall through.
    }
  }
  return undefined;
}

/**
 * Resolve the newest session id recorded in a Kimi home's on-disk session
 * index (`<home>/sessions/<id>/`). Directory walking is bounded by
 * `maxDirectories`; entries that fail validation are skipped.
 *
 * @param {string} homeDir
 * @param {KimiSessionIoBounds} [bounds]
 * @returns {{ sessionId: string; stateDir: string } | undefined}
 */
export function resolveKimiSessionFromIndex(homeDir, bounds = {}) {
  const maxDirectories = bounds.maxDirectories ?? KIMI_SESSION_WALK_DEFAULT_MAX_DIRECTORIES;
  const sessionsDir = join(homeDir, "sessions");
  let entries;
  try {
    entries = readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  let visited = 0;
  /** @type {{ sessionId: string; stateDir: string; mtimeMs: number } | undefined} */
  let newest;
  for (const entry of entries) {
    if (visited >= maxDirectories) break;
    if (!entry.isDirectory()) continue;
    visited += 1;
    if (!isPlausibleKimiSessionId(entry.name)) continue;
    const stateDir = join(sessionsDir, entry.name);
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(stateDir).mtimeMs;
    } catch {
      continue;
    }
    if (!newest || mtimeMs > newest.mtimeMs) {
      newest = { sessionId: entry.name, stateDir, mtimeMs };
    }
  }
  return newest ? { sessionId: newest.sessionId, stateDir: newest.stateDir } : undefined;
}

/**
 * Copy one session's on-disk state between Kimi homes so a resume launched
 * in an isolated invocation home can find it. Copying is bounded: at most
 * `maxFiles` files, `maxBytes` total bytes, and `maxDirectories` directories
 * are visited; exceeding a cap throws instead of silently producing a
 * partial state copy that would resume a corrupted session.
 *
 * @param {{ sourceHome: string; targetHome: string; sessionId: string }} params
 * @param {KimiSessionIoBounds} [bounds]
 * @returns {{ stateDir: string; files: number; bytes: number } | undefined}
 */
export function copyKimiSessionState(params, bounds = {}) {
  const maxBytes = bounds.maxBytes ?? KIMI_SESSION_COPY_DEFAULT_MAX_BYTES;
  const maxFiles = bounds.maxFiles ?? KIMI_SESSION_COPY_DEFAULT_MAX_FILES;
  const maxDirectories = bounds.maxDirectories ?? KIMI_SESSION_WALK_DEFAULT_MAX_DIRECTORIES;
  if (!isPlausibleKimiSessionId(params.sessionId)) return undefined;
  const sourceDir = join(params.sourceHome, "sessions", params.sessionId);
  if (!existsSync(sourceDir)) return undefined;
  // Measure first so an oversized session state never starts copying.
  let files = 0;
  let bytes = 0;
  let directories = 0;
  /** @type {string[]} */
  const stack = [sourceDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) break;
    directories += 1;
    if (directories > maxDirectories) {
      throw new Error(`kimi session state exceeds directory bound (${maxDirectories}): ${sourceDir}`);
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      files += 1;
      if (files > maxFiles) {
        throw new Error(`kimi session state exceeds file bound (${maxFiles}): ${sourceDir}`);
      }
      try {
        bytes += statSync(path).size;
      } catch {
        continue;
      }
      if (bytes > maxBytes) {
        throw new Error(`kimi session state exceeds byte bound (${maxBytes}): ${sourceDir}`);
      }
    }
  }
  const targetDir = join(params.targetHome, "sessions", params.sessionId);
  mkdirSync(targetDir, { recursive: true });
  cpSync(sourceDir, targetDir, { recursive: true });
  return { stateDir: targetDir, files, bytes };
}
