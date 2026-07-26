import { stableHash } from "./stableHash.js";

/** @typedef {import("./EventSource.ts").SmithersEventSource} SmithersEventSource */

/**
 * Content hash of the whole reducer definition — machine (config +
 * setup() implementations) plus every declared event source (kind, target,
 * options, and `map`/`schema` function source) in declaration order. This is
 * the prefix cache's true identity: a mid-run machine edit changes the hash,
 * which both keeps the cache from serving a stale fold under a different
 * reducer and drives the mid-run-edit reinterpretation warning
 * (docs: "Mid-run edits").
 *
 * @param {import("xstate").AnyStateMachine} machine
 * @param {SmithersEventSource[]} sources
 * @returns {string}
 */
export function hashReducer(machine, sources) {
  const machineDigest = toHashable(
    { config: machine.config, implementations: machine.implementations },
    new WeakSet(),
    0,
  );
  const sourcesDigest = sources.map((source, index) =>
    toHashable({ index, kind: source.kind, seed: /** @type {any} */ (source).hashSeed }, new WeakSet(), 0),
  );
  return stableHash([machineDigest, sourcesDigest]);
}

/** Deep enough to reach a zod schema's `{ type, shape }` internals a few
 * levels of nested object/array schemas down, shallow enough to bound a
 * pathological or accidentally-cyclic structure that slips past `seen`. */
const MAX_HASH_DEPTH = 16;

/**
 * Deep-clone a value into something `stableHash` can digest. Event sources
 * (map/schema/options) are constructed fresh on every render — by design,
 * they're normally declared inline in the workflow body, not hoisted to
 * module scope like the machine itself — so hashing by object IDENTITY would
 * make the reducer hash (and therefore the cache key) change every single
 * render. Instead this walks structurally: functions become their source
 * text plus their own enumerable properties (xstate's assign()/setup()
 * action builders return a wrapper function whose own toString() is generic
 * boilerplate — the real per-instance mapper lives in a property like
 * `assignment`), and any other object (zod schemas, plain config objects)
 * is walked the same way. A freshly-reconstructed-but-identical schema
 * hashes the same; an actually-edited one does not.
 *
 * @param {unknown} value
 * @param {WeakSet<object>} seen
 * @param {number} depth
 * @returns {unknown}
 */
function toHashable(value, seen, depth) {
  if (typeof value === "function") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    return { fn: value.toString(), props: walkOwnKeys(value, seen, depth) };
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_HASH_DEPTH) return "<max-depth>";
  if (Array.isArray(value)) {
    seen.add(value);
    return value.map((entry) => toHashable(entry, seen, depth + 1));
  }
  seen.add(value);
  return walkOwnKeys(value, seen, depth);
}

/**
 * @param {object} value
 * @param {WeakSet<object>} seen
 * @param {number} depth
 * @returns {Record<string, unknown>}
 */
function walkOwnKeys(value, seen, depth) {
  if (depth >= MAX_HASH_DEPTH) return { "<max-depth>": true };
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of Object.keys(value)) {
    try {
      out[key] = toHashable(/** @type {Record<string, unknown>} */ (value)[key], seen, depth + 1);
    } catch {
      out[key] = "<unreadable>";
    }
  }
  return out;
}
