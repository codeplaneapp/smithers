import type { ScenarioValue } from "./ast.ts";
export class CanonicalizeError extends Error { readonly code = "CANONICALIZE_UNSUPPORTED"; constructor(message: string, readonly details?: unknown) { super(message); this.name = "CanonicalizeError"; } }
const encode = (value: unknown, path = "$", seen = new Set<unknown>()): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new CanonicalizeError("Unsupported value at " + path); return JSON.stringify(value); }
  if (typeof value !== "object") throw new CanonicalizeError("Unsupported value at " + path);
  if (seen.has(value)) throw new CanonicalizeError("Circular value at " + path);
  seen.add(value);
  const result = Array.isArray(value) ? "[" + value.map((item, i) => encode(item, path + "[" + i + "]", seen)).join(",") + "]" : "{" + Object.keys(value as object).sort().map((key) => JSON.stringify(key) + ":" + encode((value as Record<string, unknown>)[key], path + "." + key, seen)).join(",") + "}";
  seen.delete(value); return result;
};
export const canonicalize = (value: ScenarioValue | object): string => encode(value);
