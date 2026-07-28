/**
 * Defensive readers for gateway node-output rows. `getNodeOutput` hands back
 * either the row itself or a `{ row }` / `{ data: { row } }` envelope, keys can
 * arrive snake_case, and array/object values sometimes survive the wire as JSON
 * strings. Normalize in exactly one place instead of re-implementing per UI.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Unwrap `{ row }` / `{ data }` envelopes (including nested `data` layers) and
 * return the row. A bare record passes through unchanged; anything that is not
 * a record at all returns undefined.
 */
export function rowOf<T = Record<string, unknown>>(value: unknown): T | undefined {
  let current = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!isRecord(current)) return undefined;
    if (isRecord(current.row)) return current.row as T;
    if (isRecord(current.data)) {
      current = current.data;
      continue;
    }
    return current as T;
  }
  return isRecord(current) ? (current as T) : undefined;
}

/** Alias for {@link rowOf}; several workflow UIs know it by this name. */
export const unwrapRow: <T = Record<string, unknown>>(value: unknown) => T | undefined = rowOf;

/**
 * Parse a value that may be a JSON-encoded array/object string. Only strings
 * that start with `[` or `{` are attempted; anything else passes through.
 */
export function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/** `created_at_ms` → `createdAtMs`; already-camel keys pass through. */
export function camelKey(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

/**
 * Unwrap the envelope, JSON-parse stringified array/object values, and alias
 * snake_case keys to camelCase (without clobbering an existing camel key) so
 * extractors read either spelling.
 */
export function normalizeRow(value: unknown): Record<string, unknown> {
  const raw = rowOf(value);
  if (!raw) return {};
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(raw)) out[key] = parseMaybeJson(entry);
  for (const [key, entry] of Object.entries(out)) {
    const camel = camelKey(key);
    if (camel !== key && out[camel] === undefined) out[camel] = entry;
  }
  return out;
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Coerce the boolean spellings rows carry: booleans, `0`/`1`, `"true"`/`"false"`. */
export function asBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "true") return true;
  if (value === 0 || value === "false") return false;
  return undefined;
}

export function strings(value: unknown): string[] {
  return asArray(value).map(asString).filter(Boolean);
}
