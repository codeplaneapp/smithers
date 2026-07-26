const SECRET_KEY_RE = /token|secret|key|password|credential|authorization|passwd|apikey/i;

/**
 * Deep-copy a value, replacing any object property whose KEY looks like a
 * secret with "[redacted]". Arrays and nested objects recurse. Cyclic
 * references resolve to "[Circular]" so redaction never loops.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactSandboxProviderValue(value) {
  return redact(value, new WeakSet());
}

/**
 * @param {unknown} value
 * @param {WeakSet<object>} seen
 * @returns {unknown}
 */
function redact(value, seen) {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, seen));
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, entryValue] of Object.entries(value)) {
    out[key] = SECRET_KEY_RE.test(key) ? "[redacted]" : redact(entryValue, seen);
  }
  return out;
}
