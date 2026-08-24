import { existsSync, readdirSync, statSync, cpSync, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/** Default cap on total bytes copied for one session's on-disk state (64 MiB). */
export const KIMI_SESSION_COPY_DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
/** Default cap on files copied for one session's on-disk state. */
export const KIMI_SESSION_COPY_DEFAULT_MAX_FILES = 5000;
/** Default cap on directories visited while discovering session state. */
export const KIMI_SESSION_WALK_DEFAULT_MAX_DIRECTORIES = 1000;

/**
 * Files the vendor CLI writes directly inside a session's state directory.
 * Their presence is what distinguishes a session directory from the
 * workspace-hash directory that contains it.
 */
const KIMI_SESSION_MARKER_FILES = ["state.json", "context.jsonl", "wire.jsonl"];

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
 * @param {string} dir
 * @returns {boolean}
 */
function hasSessionMarker(dir) {
  return KIMI_SESSION_MARKER_FILES.some((name) => existsSync(join(dir, name)));
}

/**
 * Walk `<home>/sessions` and yield candidate session state directories.
 *
 * The vendor CLI nests state one level deeper than the session id:
 * `<home>/sessions/<workspace-hash>/<session-id>/{state.json,context.jsonl,wire.jsonl}`.
 * Verified against the directories the CLI writes under `~/.kimi`. A flat
 * `<home>/sessions/<session-id>/` layout is also accepted so a relocated or
 * older home still resolves. Workspace-hash directories are skipped: they
 * carry no marker file and always contain subdirectories.
 *
 * The walk is bounded by `maxDirectories`.
 *
 * @param {string} homeDir
 * @param {KimiSessionIoBounds} [bounds]
 * @returns {Array<{ sessionId: string; stateDir: string; mtimeMs: number }>}
 */
function listKimiSessionStateDirs(homeDir, bounds = {}) {
  const maxDirectories = bounds.maxDirectories ?? KIMI_SESSION_WALK_DEFAULT_MAX_DIRECTORIES;
  const sessionsDir = join(homeDir, "sessions");
  /** @type {Array<{ sessionId: string; stateDir: string; mtimeMs: number }>} */
  const found = [];
  /** @type {Array<{ dir: string; depth: number }>} */
  const stack = [{ dir: sessionsDir, depth: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next) break;
    if (visited >= maxDirectories) break;
    visited += 1;
    let entries;
    try {
      entries = readdirSync(next.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const stateDir = join(next.dir, entry.name);
      if (!isPlausibleKimiSessionId(entry.name)) continue;
      const isSession = hasSessionMarker(stateDir) || !hasSubdirectory(stateDir);
      if (isSession) {
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(stateDir).mtimeMs;
        } catch {
          continue;
        }
        found.push({ sessionId: entry.name, stateDir, mtimeMs });
        continue;
      }
      // A workspace-hash directory. Its children are the session directories.
      if (next.depth < 1) stack.push({ dir: stateDir, depth: next.depth + 1 });
    }
  }
  return found;
}

/**
 * @param {string} dir
 * @returns {boolean}
 */
function hasSubdirectory(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).some((entry) => entry.isDirectory());
  } catch {
    return false;
  }
}

/**
 * Resolve the newest session recorded in a Kimi home's on-disk session index.
 * Returns the session id the CLI accepts for `kimi -r <id>`, never the
 * workspace-hash directory that contains it.
 *
 * @param {string} homeDir
 * @param {KimiSessionIoBounds} [bounds]
 * @returns {{ sessionId: string; stateDir: string } | undefined}
 */
export function resolveKimiSessionFromIndex(homeDir, bounds = {}) {
  let newest;
  for (const candidate of listKimiSessionStateDirs(homeDir, bounds)) {
    if (!newest || candidate.mtimeMs > newest.mtimeMs) newest = candidate;
  }
  return newest ? { sessionId: newest.sessionId, stateDir: newest.stateDir } : undefined;
}

/**
 * Locate one session's state directory inside a Kimi home, at either the
 * workspace-scoped or the flat layout.
 *
 * @param {string} homeDir
 * @param {string} sessionId
 * @param {KimiSessionIoBounds} [bounds]
 * @returns {string | undefined}
 */
export function findKimiSessionStateDir(homeDir, sessionId, bounds = {}) {
  if (!isPlausibleKimiSessionId(sessionId)) return undefined;
  const flat = join(homeDir, "sessions", sessionId);
  if (existsSync(flat)) return flat;
  for (const candidate of listKimiSessionStateDirs(homeDir, bounds)) {
    if (candidate.sessionId === sessionId) return candidate.stateDir;
  }
  return undefined;
}

/**
 * Copy one session's on-disk state between Kimi homes so a resume launched
 * in an isolated invocation home can find it. The path relative to
 * `<home>/sessions` is preserved, so a workspace-scoped session lands at the
 * same workspace-scoped path in the target home.
 *
 * Copying is bounded: at most `maxFiles` files, `maxBytes` total bytes, and
 * `maxDirectories` directories are visited; exceeding a cap throws instead of
 * silently producing a partial state copy that would resume a corrupted
 * session.
 *
 * @param {{ sourceHome: string; targetHome: string; sessionId: string }} params
 * @param {KimiSessionIoBounds} [bounds]
 * @returns {{ stateDir: string; files: number; bytes: number } | undefined}
 */
export function copyKimiSessionState(params, bounds = {}) {
  const maxBytes = bounds.maxBytes ?? KIMI_SESSION_COPY_DEFAULT_MAX_BYTES;
  const maxFiles = bounds.maxFiles ?? KIMI_SESSION_COPY_DEFAULT_MAX_FILES;
  const maxDirectories = bounds.maxDirectories ?? KIMI_SESSION_WALK_DEFAULT_MAX_DIRECTORIES;
  const sourceDir = findKimiSessionStateDir(params.sourceHome, params.sessionId, bounds);
  if (!sourceDir) return undefined;
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
  const relativePath = relative(join(params.sourceHome, "sessions"), sourceDir);
  const targetDir = join(params.targetHome, "sessions", relativePath);
  mkdirSync(dirname(targetDir), { recursive: true });
  cpSync(sourceDir, targetDir, { recursive: true });
  return { stateDir: targetDir, files, bytes };
}
