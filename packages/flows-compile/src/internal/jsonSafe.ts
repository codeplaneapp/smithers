import * as Digest from "@flows/core/Digest";

/**
 * The stand-in a value that canonical JSON cannot carry is replaced with.
 *
 * Smithers task descriptors hold closures, class instances, zod schemas, and
 * drizzle tables. `@smthrs/plan` hashes a node's declaration as canonical JSON,
 * which refuses all of those, so every value that enters key material passes
 * through {@link jsonSafe} first.
 */
export type Opaque = { readonly $opaque: string; readonly digest: string };

/** Digests a function by its exact source text. */
export const functionDigest = (fn: (...args: never[]) => unknown): string =>
  Digest.digest(Function.prototype.toString.call(fn));

const opaque = (label: string, digest: string): Opaque => ({ $opaque: label, digest });

/**
 * Rewrites a value into one canonical JSON can serialize.
 *
 * Plain objects, arrays, strings, finite numbers, booleans, and null pass
 * through. Everything else becomes an {@link Opaque} marker carrying a digest,
 * so the value still contributes to identity without the serializer having to
 * represent it. Cycles resolve to a `cycle` marker rather than throwing.
 */
export const jsonSafe = (value: unknown, seen: ReadonlySet<object> = new Set()): unknown => {
  if (value === null) return null;
  const type = typeof value;
  if (type === "string" || type === "boolean") return value;
  if (type === "number") return Number.isFinite(value as number) ? value : opaque("number", String(value));
  if (type === "undefined") return opaque("undefined", "");
  if (type === "bigint") return opaque("bigint", String(value));
  if (type === "symbol") return opaque("symbol", String((value as symbol).description ?? ""));
  if (type === "function") return opaque("function", functionDigest(value as (...args: never[]) => unknown));
  const object = value as object;
  if (seen.has(object)) return opaque("cycle", "");
  const nested = new Set(seen).add(object);
  if (Array.isArray(object)) return object.map((entry) => jsonSafe(entry, nested));
  if (object instanceof Date) return opaque("date", object.toISOString());
  if (object instanceof RegExp) return opaque("regexp", String(object));
  if (object instanceof Map) {
    return opaque("map", Digest.canonical(jsonSafe([...object.entries()], nested)));
  }
  if (object instanceof Set) {
    return opaque("set", Digest.canonical(jsonSafe([...object.values()], nested)));
  }
  const prototype = Object.getPrototypeOf(object);
  if (prototype !== null && prototype !== Object.prototype) {
    // A class instance: zod schema, drizzle table, agent. Its own enumerable
    // fields are the only part that is honestly serializable, so the class name
    // rides along and the fields are walked.
    const name = (prototype.constructor as { name?: string } | undefined)?.name ?? "object";
    return { $class: name, fields: plainFields(object, nested) };
  }
  return plainFields(object, nested);
};

const plainFields = (object: object, seen: ReadonlySet<object>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(object).sort()) {
    const entry = (object as Record<string, unknown>)[key];
    if (entry === undefined) continue;
    out[key] = jsonSafe(entry, seen);
  }
  return out;
};
