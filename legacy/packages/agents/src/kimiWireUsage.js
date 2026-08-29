import { openSync, readSync, fstatSync, closeSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isRecord, asNumber } from "./BaseCliAgent/index.js";

/** @typedef {import("./BaseCliAgent/NormalizedTokenUsage.ts").NormalizedTokenUsage} NormalizedTokenUsage */

/** Default cap on bytes read from a wire log in one delta pass (8 MiB). */
export const KIMI_WIRE_USAGE_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
/** Default cap on usage entries processed in one delta pass. */
export const KIMI_WIRE_USAGE_DEFAULT_MAX_ENTRIES = 10000;
/** Default cap on directories visited while discovering wire logs under a home. */
export const KIMI_WIRE_WALK_DEFAULT_MAX_DIRECTORIES = 1000;
/** Default cap on wire logs read in one delta pass. */
export const KIMI_WIRE_WALK_DEFAULT_MAX_FILES = 200;

/**
 * @typedef {{
 *   maxBytes?: number;
 *   maxEntries?: number;
 *   maxDirectories?: number;
 *   maxFiles?: number;
 * }} KimiWireUsageReadOptions
 */

/**
 * @typedef {{
 *   usage: NormalizedTokenUsage;
 *   byteOffset: number;
 *   entries: number;
 *   truncated: boolean;
 * }} KimiWireUsageDelta
 */

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function counter(value) {
  const n = asNumber(value);
  return typeof n === "number" && n > 0 ? n : undefined;
}

/**
 * Normalize one `wire.jsonl` line into Smithers' usage shape.
 *
 * The Kimi stream JSON does not publish token usage. The CLI's wire log does,
 * as `StatusUpdate` messages carrying a `token_usage` object with per-step
 * (not cumulative) counters. Verified against the wire logs the vendor CLI
 * writes under `<home>/sessions/<workspace>/<session>/wire.jsonl`:
 *
 * ```json
 * {"timestamp": 1777166287.75, "message": {"type": "StatusUpdate", "payload": {
 *   "token_usage": {"input_other": 2715, "output": 36,
 *                   "input_cache_read": 9216, "input_cache_creation": 0}}}}
 * ```
 *
 * A `usage.record` envelope and a bare top-level `token_usage` object are also
 * accepted, so a wire-schema revision that moves the counters keeps reporting.
 * Every other line returns null.
 *
 * @param {Record<string, unknown>} payload
 * @returns {NormalizedTokenUsage | null}
 */
export function normalizeKimiWireUsageRecord(payload) {
  const raw = kimiWireUsageCounters(payload);
  if (!raw) return null;
  const cacheReadTokens =
    counter(raw.input_cache_read) ??
    counter(raw.cache_read_tokens) ??
    counter(raw.cacheReadTokens) ??
    counter(raw.cache_read);
  const cacheWriteTokens =
    counter(raw.input_cache_creation) ??
    counter(raw.cache_write_tokens) ??
    counter(raw.cacheWriteTokens) ??
    counter(raw.cache_write);
  const inputTokens =
    counter(raw.input_other) ??
    counter(raw.other_input_tokens) ??
    counter(raw.otherInputTokens) ??
    counter(raw.input_tokens);
  const outputTokens = counter(raw.output) ?? counter(raw.output_tokens) ?? counter(raw.outputTokens);
  /** @type {NormalizedTokenUsage} */
  const usage = {};
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (cacheReadTokens !== undefined) usage.cacheReadTokens = cacheReadTokens;
  if (cacheWriteTokens !== undefined) usage.cacheWriteTokens = cacheWriteTokens;
  return Object.keys(usage).length > 0 ? usage : null;
}

/**
 * Locate the counter object inside a wire line, or null when the line is not
 * a usage record. Matching on shape (rather than on any line having numeric
 * fields) keeps unrelated wire messages from being billed as usage.
 *
 * @param {Record<string, unknown>} payload
 * @returns {Record<string, unknown> | null}
 */
function kimiWireUsageCounters(payload) {
  const message = isRecord(payload.message) ? payload.message : undefined;
  if (message?.type === "StatusUpdate") {
    const inner = isRecord(message.payload) ? message.payload : undefined;
    return isRecord(inner?.token_usage) ? inner.token_usage : null;
  }
  if (payload.type === "usage.record") {
    if (isRecord(payload.usage)) return payload.usage;
    if (isRecord(payload.token_usage)) return payload.token_usage;
    return payload;
  }
  if (isRecord(payload.token_usage)) return payload.token_usage;
  return null;
}

/**
 * Return the current end position of a file, or 0 when it does not exist.
 *
 * @param {string} filePath
 * @returns {number}
 */
export function kimiWireLogPosition(filePath) {
  try {
    const fd = openSync(filePath, "r");
    try {
      return fstatSync(fd).size;
    } finally {
      closeSync(fd);
    }
  } catch {
    return 0;
  }
}

/**
 * Discover every `wire.jsonl` under a Kimi home. The vendor writes them at
 * `<home>/sessions/<workspace>/<session>/wire.jsonl`; a flat
 * `<home>/sessions/<session>/wire.jsonl` and a bare `<home>/wire.jsonl` are
 * also collected so an older or relocated layout still reports usage.
 *
 * The walk is bounded by `maxDirectories` and `maxFiles`.
 *
 * @param {string} homeDir
 * @param {KimiWireUsageReadOptions} [bounds]
 * @returns {string[]}
 */
export function findKimiWireLogs(homeDir, bounds = {}) {
  const maxDirectories = bounds.maxDirectories ?? KIMI_WIRE_WALK_DEFAULT_MAX_DIRECTORIES;
  const maxFiles = bounds.maxFiles ?? KIMI_WIRE_WALK_DEFAULT_MAX_FILES;
  /** @type {string[]} */
  const found = [];
  const rootLog = join(homeDir, "wire.jsonl");
  if (existsSync(rootLog)) found.push(rootLog);
  /** @type {Array<{ dir: string; depth: number }>} */
  const stack = [{ dir: join(homeDir, "sessions"), depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && found.length < maxFiles) {
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
      const path = join(next.dir, entry.name);
      if (entry.isDirectory()) {
        // Depth 2 is the session directory; nothing deeper holds a wire log.
        if (next.depth < 2) stack.push({ dir: path, depth: next.depth + 1 });
        continue;
      }
      if (entry.name === "wire.jsonl" && found.length < maxFiles) found.push(path);
    }
  }
  return found;
}

/**
 * Snapshot the end position of every wire log under a Kimi home. Taken at
 * invocation start (and again after resumed session state is seeded), so a
 * later delta pass bills only what this invocation appended. Logs created
 * after the snapshot are absent from it and therefore counted in full.
 *
 * @param {string} homeDir
 * @param {KimiWireUsageReadOptions} [bounds]
 * @returns {Map<string, number>}
 */
export function kimiWireBaseline(homeDir, bounds = {}) {
  /** @type {Map<string, number>} */
  const baseline = new Map();
  for (const path of findKimiWireLogs(homeDir, bounds)) {
    baseline.set(path, kimiWireLogPosition(path));
  }
  return baseline;
}

/**
 * Sum the invocation-local usage delta across every wire log under a Kimi
 * home, relative to a {@link kimiWireBaseline} snapshot. The returned
 * `baseline` supersedes the one passed in, so repeated passes never
 * double-count.
 *
 * @param {string} homeDir
 * @param {Map<string, number>} baseline
 * @param {KimiWireUsageReadOptions} [options]
 * @returns {{ usage: NormalizedTokenUsage; baseline: Map<string, number>; entries: number; truncated: boolean } | null}
 */
export function readKimiWireUsageDeltaForHome(homeDir, baseline, options = {}) {
  const paths = findKimiWireLogs(homeDir, options);
  if (paths.length === 0) return null;
  /** @type {NormalizedTokenUsage} */
  const usage = {};
  /** @type {Map<string, number>} */
  const nextBaseline = new Map(baseline);
  let entries = 0;
  let truncated = false;
  for (const path of paths) {
    const delta = readKimiWireUsageDelta(path, baseline.get(path) ?? 0, options);
    if (!delta) continue;
    nextBaseline.set(path, delta.byteOffset);
    entries += delta.entries;
    truncated ||= delta.truncated;
    addKimiUsage(usage, delta.usage);
  }
  return { usage, baseline: nextBaseline, entries, truncated };
}

/**
 * @param {NormalizedTokenUsage} target
 * @param {NormalizedTokenUsage} source
 */
function addKimiUsage(target, source) {
  for (const key of /** @type {const} */ (["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"])) {
    const value = source[key];
    if (typeof value === "number") target[key] = (target[key] ?? 0) + value;
  }
}

/**
 * Read the invocation-local usage delta from one Kimi `wire.jsonl`: only
 * usage entries appended after `byteOffset` are summed, so tokens from
 * earlier invocations (or seeded resume state) are never re-billed.
 *
 * Bounded read: at most `maxBytes` are read from the offset and at most
 * `maxEntries` records are processed. When either cap trips, the result is
 * marked `truncated` and the returned `byteOffset` stops at the last fully
 * parsed line so a later pass can continue.
 *
 * @param {string} filePath
 * @param {number} byteOffset
 * @param {KimiWireUsageReadOptions} [options]
 * @returns {KimiWireUsageDelta | null}
 */
export function readKimiWireUsageDelta(filePath, byteOffset, options = {}) {
  const maxBytes = options.maxBytes ?? KIMI_WIRE_USAGE_DEFAULT_MAX_BYTES;
  const maxEntries = options.maxEntries ?? KIMI_WIRE_USAGE_DEFAULT_MAX_ENTRIES;
  if (!existsSync(filePath)) return null;
  let fd;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return null;
  }
  /** @type {Buffer} */
  let chunk;
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, Math.min(byteOffset, size));
    const length = Math.min(size - start, maxBytes);
    chunk = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, chunk, read, length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    if (read < length) chunk = chunk.subarray(0, read);
  } finally {
    closeSync(fd);
  }
  /** @type {NormalizedTokenUsage} */
  const usage = {};
  let entries = 0;
  let consumed = 0;
  let truncated = chunk.length === maxBytes;
  const text = chunk.toString("utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    const isLastLine = i === lines.length - 1;
    if (isLastLine && !text.endsWith("\n")) {
      // Partial final line: leave it for the next pass.
      if (line.length > 0) truncated = true;
      break;
    }
    if (entries >= maxEntries) {
      truncated = true;
      break;
    }
    consumed += lineBytes;
    const trimmed = line.trim();
    if (!trimmed) continue;
    let payload;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(payload)) continue;
    const record = normalizeKimiWireUsageRecord(payload);
    if (!record) continue;
    entries += 1;
    addKimiUsage(usage, record);
  }
  return { usage, byteOffset: byteOffset + consumed, entries, truncated };
}
