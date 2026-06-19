import pc from "picocolors";

/**
 * Smithers meta columns to strip from raw output rows before pretty-printing.
 *
 * Re-declared locally (NOT imported from tui.js, which must stay untouched) and
 * intentionally wider than output.js `stripOutputKeyColumns`: it carries both
 * camelCase (sqlite) and snake_case (postgres) forms so raw rows from either
 * dialect strip cleanly — matching tui.js `OUTPUT_META_KEYS`.
 *
 * @type {Set<string>}
 */
const OUTPUT_META_KEYS = new Set([
    "runId",
    "nodeId",
    "iteration",
    "attempt",
    "run_id",
    "node_id",
    "createdAtMs",
    "updatedAtMs",
    "created_at_ms",
    "updated_at_ms",
]);

/** Node states that mark a finished node as failed. */
const NODE_FAILURE_STATES = new Set(["failed", "error"]);
/** Node states that mark a finished node as cancelled. */
const NODE_CANCEL_STATES = new Set(["cancelled", "canceled"]);

/** Two-space indent per nesting level. */
const INDENT_UNIT = "  ";

/** U+2014 em dash used as the null/undefined placeholder. */
const EM_DASH = "—";

/**
 * @param {number} indent
 * @returns {string} leading whitespace for `indent` nesting levels
 */
function pad(indent) {
    return INDENT_UNIT.repeat(Math.max(0, indent));
}

/**
 * A picocolors-shaped styler: each role is `(s: string) => string`. Production
 * passes `pc`; tests pass an identity object so assertions see pure structure
 * with zero ANSI. Only the roles below are used.
 *
 * @typedef {{
 *   bold: (s: string) => string,
 *   dim: (s: string) => string,
 *   cyan: (s: string) => string,
 *   green: (s: string) => string,
 *   yellow: (s: string) => string,
 * }} ColorStyler
 */

/**
 * Is `value` a plain-ish object we should recurse into (vs. a leaf like Date)?
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        !(value instanceof Date)
    );
}

/**
 * Style a single scalar (no key, no indent). Never throws.
 *
 * @param {unknown} value
 * @param {ColorStyler} color
 * @returns {string}
 */
function styleScalar(value, color) {
    if (value === null || value === undefined) {
        return color.dim(EM_DASH);
    }
    const t = typeof value;
    if (t === "string") {
        return color.green(value);
    }
    if (t === "number") {
        // NaN / Infinity stringify fine.
        return color.yellow(String(value));
    }
    if (t === "bigint") {
        return color.yellow(`${value}n`);
    }
    if (t === "boolean") {
        return color.blue(value ? "true" : "false");
    }
    if (t === "function") {
        return color.dim("[fn]");
    }
    if (t === "symbol") {
        return color.dim("[symbol]");
    }
    if (value instanceof Date) {
        return color.green(value.toISOString());
    }
    // Defensive fallback for any other exotic primitive.
    return color.green(String(value));
}

/**
 * Render a multi-line string under its key: each physical line green, indented.
 * @param {string} value
 * @param {number} indent
 * @param {ColorStyler} color
 * @returns {string[]} one styled line per physical line
 */
function styleMultilineString(value, indent, color) {
    const prefix = pad(indent);
    return value.split("\n").map((line) => `${prefix}${color.green(line)}`);
}

/**
 * Render an object's own enumerable keys as YAML-ish lines.
 * @param {Record<string, unknown>} obj
 * @param {number} indent
 * @param {ColorStyler} color
 * @param {WeakSet<object>} seen
 * @returns {string[]}
 */
function renderObject(obj, indent, color, seen) {
    const prefix = pad(indent);
    const lines = [];
    for (const key of Object.keys(obj)) {
        const styledKey = color.bold(color.cyan(key));
        const value = obj[key];

        if (isPlainObject(value)) {
            if (Object.keys(value).length === 0) {
                // Empty object inline.
                lines.push(`${prefix}${styledKey}: ${color.dim("{}")}`);
                continue;
            }
            if (seen.has(value)) {
                lines.push(`${prefix}${styledKey}: ${color.dim("[circular]")}`);
                continue;
            }
            lines.push(`${prefix}${styledKey}:`);
            lines.push(...renderValue(value, indent + 1, color, seen));
            continue;
        }

        if (Array.isArray(value)) {
            if (value.length === 0) {
                // Empty array inline.
                lines.push(`${prefix}${styledKey}: ${color.dim("[]")}`);
                continue;
            }
            if (seen.has(value)) {
                lines.push(`${prefix}${styledKey}: ${color.dim("[circular]")}`);
                continue;
            }
            lines.push(`${prefix}${styledKey}:`);
            lines.push(...renderValue(value, indent + 1, color, seen));
            continue;
        }

        if (typeof value === "string" && value.includes("\n")) {
            lines.push(`${prefix}${styledKey}:`);
            lines.push(...styleMultilineString(value, indent + 1, color));
            continue;
        }

        // Inline primitive (incl. null/undefined -> em dash, Date -> ISO).
        lines.push(`${prefix}${styledKey}: ${styleScalar(value, color)}`);
    }
    return lines;
}

/**
 * Render an array, one element per line.
 * @param {unknown[]} arr
 * @param {number} indent
 * @param {ColorStyler} color
 * @param {WeakSet<object>} seen
 * @returns {string[]}
 */
function renderArray(arr, indent, color, seen) {
    const prefix = pad(indent);
    const lines = [];
    for (let i = 0; i < arr.length; i++) {
        const item = arr[i];

        if (isPlainObject(item) || Array.isArray(item)) {
            const isEmpty = isPlainObject(item)
                ? Object.keys(item).length === 0
                : item.length === 0;
            if (isEmpty) {
                // Empty object/array element collapses to an inline placeholder.
                const placeholder = Array.isArray(item) ? "[]" : "{}";
                lines.push(`${prefix}${color.dim(`- ${placeholder}`)}`);
                continue;
            }
            if (seen.has(item)) {
                lines.push(`${prefix}${color.dim(`[${i}]`)}`);
                lines.push(`${pad(indent + 1)}${color.dim("[circular]")}`);
                continue;
            }
            // Index header, then the nested value indented one level below.
            lines.push(`${prefix}${color.dim(`[${i}]`)}`);
            lines.push(...renderValue(item, indent + 1, color, seen));
            continue;
        }

        if (typeof item === "string" && item.includes("\n")) {
            // Multi-line string element: bullet then continuation lines.
            const parts = item.split("\n");
            lines.push(`${prefix}${color.dim("- ")}${color.green(parts[0])}`);
            for (let j = 1; j < parts.length; j++) {
                lines.push(`${pad(indent + 1)}${color.green(parts[j])}`);
            }
            continue;
        }

        lines.push(`${prefix}${color.dim("- ")}${styleScalar(item, color)}`);
    }
    return lines;
}

/**
 * Core recursive renderer. Tracks visited object/array references in `seen` to
 * guard cycles, adding/removing as it descends so sibling reuse is fine.
 *
 * @param {unknown} value
 * @param {number} indent
 * @param {ColorStyler} color
 * @param {WeakSet<object>} seen
 * @returns {string[]}
 */
function renderValue(value, indent, color, seen) {
    if (isPlainObject(value)) {
        if (Object.keys(value).length === 0) {
            return [`${pad(indent)}${color.dim("{}")}`];
        }
        if (seen.has(value)) {
            return [`${pad(indent)}${color.dim("[circular]")}`];
        }
        seen.add(value);
        const lines = renderObject(/** @type {Record<string, unknown>} */ (value), indent, color, seen);
        seen.delete(value);
        return lines;
    }

    if (Array.isArray(value)) {
        if (value.length === 0) {
            return [`${pad(indent)}${color.dim("[]")}`];
        }
        if (seen.has(value)) {
            return [`${pad(indent)}${color.dim("[circular]")}`];
        }
        seen.add(value);
        const lines = renderArray(value, indent, color, seen);
        seen.delete(value);
        return lines;
    }

    if (typeof value === "string" && value.includes("\n")) {
        return styleMultilineString(value, indent, color);
    }

    // Standalone scalar: just the styled value on one line.
    return [`${pad(indent)}${styleScalar(value, color)}`];
}

/**
 * PURE colorized pretty-printer: a YAML-ish tree, prettier than JSON.
 *
 * Returns a multi-line string with NO trailing newline. Never touches the DB,
 * and NEVER throws — any internal error falls back to `color.dim("[unprintable]")`.
 *
 * @param {unknown} value
 * @param {{
 *   indent?: number,
 *   color?: ColorStyler,
 *   seen?: WeakSet<object>,
 * }} [opts]
 * @returns {string}
 */
export function prettyValue(value, opts = {}) {
    const indent = opts.indent ?? 0;
    const color = opts.color ?? pc;
    const seen = opts.seen ?? new WeakSet();
    try {
        return renderValue(value, indent, color, seen).join("\n");
    } catch {
        return `${pad(indent)}${color.dim("[unprintable]")}`;
    }
}

/**
 * Bare node id for display: strip any `workflow:`-style qualifier prefix.
 * Mirrors tui.js `displayNode` without importing it.
 * @param {unknown} nodeId
 * @returns {string}
 */
function lastSegment(nodeId) {
    const id = String(nodeId ?? "·");
    const i = id.lastIndexOf(":");
    return i >= 0 ? id.slice(i + 1) : id;
}

/**
 * Clone a raw output row, dropping smithers meta columns and null/undefined
 * values (parity with formatOutputRow's `v == null` skip).
 * @param {Record<string, unknown> | null | undefined} row
 * @returns {Record<string, unknown>}
 */
function stripMeta(row) {
    if (!row || typeof row !== "object") return {};
    const data = {};
    for (const [k, v] of Object.entries(row)) {
        if (OUTPUT_META_KEYS.has(k) || v == null) continue;
        data[k] = v;
    }
    return data;
}

/**
 * Append a dim "(failed)"/"(cancelled)" suffix to a header label based on the
 * node's terminal state.
 * @param {string} styledLabel already-bold header
 * @param {unknown} state
 * @param {ColorStyler} color
 * @returns {string}
 */
function withStateSuffix(styledLabel, state, color) {
    if (NODE_FAILURE_STATES.has(String(state))) {
        return `${styledLabel} ${color.dim("(failed)")}`;
    }
    if (NODE_CANCEL_STATES.has(String(state))) {
        return `${styledLabel} ${color.dim("(cancelled)")}`;
    }
    return styledLabel;
}

/**
 * Load and pretty-print every finished node's output for a run, mirroring the
 * TUI's output-loading path (listNodes -> getRawNodeOutputForIteration), then
 * rendering each as a bold header + indented {@link prettyValue} body.
 *
 * Never throws: `listNodes` failures degrade to an empty list and per-node
 * output loads degrade to `null` (and getRawNodeOutputForIteration already
 * swallows DB errors), so end-of-run rendering can't break TUI teardown.
 *
 * Node rows match `packages/db/src/adapter/NodeRow.ts` (runId, nodeId,
 * iteration, state, outputTable, label, …); typed structurally here so this
 * module doesn't reach across the db package boundary.
 *
 * @param {{
 *   listNodes: (runId: string) => Promise<Array<{
 *     runId: string,
 *     nodeId: string,
 *     iteration?: number,
 *     state?: string,
 *     outputTable?: string,
 *     label?: string | null,
 *   }>>,
 *   getRawNodeOutputForIteration: (
 *     table: string, runId: string, nodeId: string, iteration: number,
 *   ) => Promise<Record<string, unknown> | null>,
 * }} adapter
 * @param {string} runId
 * @param {{
 *   print?: (line: string) => void,
 *   color?: ColorStyler,
 * }} [opts]
 * @returns {Promise<{ nodeCount: number }>}
 */
export async function renderRunOutputs(adapter, runId, opts = {}) {
    const print = opts.print ?? ((line) => process.stdout.write(`${line}\n`));
    const color = opts.color ?? pc;

    let nodes;
    try {
        nodes = await adapter.listNodes(runId);
    } catch {
        nodes = [];
    }
    if (!Array.isArray(nodes)) nodes = [];

    let nodeCount = 0;
    for (const node of nodes) {
        const table = node?.outputTable;
        if (typeof table !== "string" || table.length === 0) continue;

        const iteration = node.iteration ?? 0;
        let row = null;
        try {
            row = await adapter.getRawNodeOutputForIteration(table, runId, node.nodeId, iteration);
        } catch {
            row = null;
        }
        const data = stripMeta(row);

        // Blank separator between cards (not before the first).
        if (nodeCount > 0) print("");

        const label = node.label ?? lastSegment(node.nodeId);
        print(withStateSuffix(color.bold(color.magenta(String(label))), node.state, color));

        if (!row || Object.keys(data).length === 0) {
            print(`${INDENT_UNIT}${color.dim(EM_DASH)}`);
        } else {
            print(prettyValue(data, { indent: 1, color }));
        }

        nodeCount++;
    }

    if (nodeCount === 0) {
        print(color.dim("(no task outputs)"));
    }

    return { nodeCount };
}
