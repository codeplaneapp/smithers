import { openSync, readSync, fstatSync, closeSync, existsSync } from "node:fs";
import { isRecord, asNumber } from "./BaseCliAgent/index.js";

/** @typedef {import("./BaseCliAgent/NormalizedTokenUsage.ts").NormalizedTokenUsage} NormalizedTokenUsage */

/** Default cap on bytes read from a wire log in one delta pass (8 MiB). */
export const KIMI_WIRE_USAGE_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
/** Default cap on usage.record entries processed in one delta pass. */
export const KIMI_WIRE_USAGE_DEFAULT_MAX_ENTRIES = 10000;

/**
 * @typedef {{
 *   maxBytes?: number;
 *   maxEntries?: number;
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
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Normalize one wire.jsonl `usage.record` entry. The Kimi stream JSON does
 * not publish token usage; the CLI's wire log records cache-read,
 * cache-write, other-input, and output counters per step. Field names are
 * read tolerantly (snake_case and camelCase) because the wire schema is
 * versioned separately from the stream schema.
 *
 * @param {Record<string, unknown>} payload
 * @returns {NormalizedTokenUsage | null}
 */
export function normalizeKimiWireUsageRecord(payload) {
  const raw = isRecord(payload.usage) ? payload.usage : payload;
  const cacheReadTokens = counter(raw.cache_read_tokens) ?? counter(raw.cacheReadTokens) ?? counter(raw.cache_read);
  const cacheWriteTokens = counter(raw.cache_write_tokens) ?? counter(raw.cacheWriteTokens) ?? counter(raw.cache_write);
  const inputTokens = counter(raw.other_input_tokens) ?? counter(raw.otherInputTokens) ?? counter(raw.input_tokens);
  const outputTokens = counter(raw.output_tokens) ?? counter(raw.outputTokens);
  /** @type {NormalizedTokenUsage} */
  const usage = {};
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (cacheReadTokens !== undefined) usage.cacheReadTokens = cacheReadTokens;
  if (cacheWriteTokens !== undefined) usage.cacheWriteTokens = cacheWriteTokens;
  return Object.keys(usage).length > 0 ? usage : null;
}

/**
 * Return the current end position of a file, or 0 when it does not exist.
 * Used to baseline a wire log before an invocation starts (and to
 * re-baseline after resumed session state is seeded, so historical tokens
 * are not re-billed to the new invocation).
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
 * Read the invocation-local usage delta from a Kimi `wire.jsonl`: only
 * `usage.record` entries appended after `byteOffset` are summed, so tokens
 * from earlier invocations (or seeded resume state) are never re-billed.
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
    if (length > 0) {
      readSync(fd, chunk, 0, length, start);
    }
  } finally {
    closeSync(fd);
  }
  /** @type {NormalizedTokenUsage} */
  const usage = {};
  let entries = 0;
  let consumed = 0;
  let truncated = false;
  const text = chunk.toString("utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    const isLastLine = i === lines.length - 1;
    if (isLastLine && !text.endsWith("\n")) {
      // Partial final line: leave it for the next pass.
      truncated = true;
      break;
    }
    consumed += lineBytes;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (entries >= maxEntries) {
      truncated = true;
      consumed -= lineBytes;
      break;
    }
    let payload;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(payload)) continue;
    if (payload.type !== "usage.record") continue;
    const record = normalizeKimiWireUsageRecord(payload);
    if (!record) continue;
    entries += 1;
    for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]) {
      const value = record[key];
      if (typeof value === "number") {
        usage[key] = (usage[key] ?? 0) + value;
      }
    }
  }
  if (chunk.length === maxBytes) {
    truncated = true;
  }
  if (entries === 0 && !truncated) {
    return { usage: {}, byteOffset: byteOffset + consumed, entries: 0, truncated: false };
  }
  return { usage, byteOffset: byteOffset + consumed, entries, truncated };
}
