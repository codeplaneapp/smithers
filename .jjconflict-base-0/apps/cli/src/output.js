// @smithers-type-exports-begin
/** @typedef {import("./RunOutputCommandInput.ts").RunOutputCommandInput} RunOutputCommandInput */
/** @typedef {import("./RunOutputCommandResult.ts").RunOutputCommandResult} RunOutputCommandResult */
// @smithers-type-exports-end

import { getNodeOutputRoute } from "@smithers-orchestrator/server/gatewayRoutes/getNodeOutput";
import { NodeOutputRouteError } from "@smithers-orchestrator/server/gatewayRoutes/NodeOutputRouteError";
import { camelToSnake } from "@smithers-orchestrator/db/utils/camelToSnake";
import { EXIT_OK } from "./util/exitCodes.js";
import { formatCliErrorForStderr, getCliErrorMapping } from "./util/errorMessage.js";

const RUN_ID_PATTERN = /^[a-z0-9_-]{1,64}$/;
const NODE_ID_PATTERN = /^[a-zA-Z0-9:_-]{1,128}$/;

/**
 * @param {any} response
 * @returns {string}
 */
export function renderPrettyOutput(response) {
    if (!response || response.row === null || response.row === undefined) {
        if (response?.status === "pending") return "(pending)";
        if (response?.status === "failed") return "(failed)";
        return "(no output)";
    }
    const schemaFields = Array.isArray(response.schema?.fields) ? response.schema.fields : [];
    const row = /** @type {Record<string, unknown>} */ (response.row);
    const printed = new Set();
    /** @type {string[]} */
    const lines = [];
    for (const field of schemaFields) {
        if (!field || typeof field.name !== "string") continue;
        if (!(field.name in row)) continue;
        const value = row[field.name];
        lines.push(`${field.name}: ${formatValue(value)}`);
        printed.add(field.name);
    }
    for (const [key, value] of Object.entries(row)) {
        if (printed.has(key)) continue;
        lines.push(`${key}: ${formatValue(value)}`);
    }
    return lines.join("\n");
}

/** @param {unknown} value */
function formatValue(value) {
    if (value === null) return "null";
    if (value === undefined) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

/**
 * @param {import("@smithers-orchestrator/db/adapter").SmithersDb} adapter
 * @param {string} runId
 * @param {string} nodeId
 * @returns {Promise<number | null>}
 */
async function resolveLatestIteration(adapter, runId, nodeId) {
    try {
        const iterations = await adapter.listNodeIterations(runId, nodeId);
        if (!Array.isArray(iterations) || iterations.length === 0) return null;
        return iterations.reduce((max, row) => {
            const it = typeof row?.iteration === "number" ? row.iteration : 0;
            return it > max ? it : max;
        }, 0);
    } catch {
        return null;
    }
}

/**
 * @param {Record<string, unknown> | null} row
 * @returns {Record<string, unknown> | null}
 */
function stripOutputKeyColumns(row) {
    if (!row || typeof row !== "object") {
        return null;
    }
    const result = { ...row };
    delete result.run_id;
    delete result.runId;
    delete result.node_id;
    delete result.nodeId;
    delete result.iteration;
    return result;
}

/**
 * @param {RunOutputCommandInput} input
 * @param {number} iteration
 * @returns {Promise<RunOutputCommandResult>}
 */
async function runRawJsonOutput(input, iteration) {
    if (!RUN_ID_PATTERN.test(input.runId)) {
        throw new NodeOutputRouteError("InvalidRunId", "runId must match /^[a-z0-9_-]{1,64}$/.");
    }
    if (!NODE_ID_PATTERN.test(input.nodeId)) {
        throw new NodeOutputRouteError("InvalidNodeId", "nodeId must match /^[a-zA-Z0-9:_-]{1,128}$/.");
    }
    const run = await input.adapter.getRun(input.runId);
    if (!run) {
        throw new NodeOutputRouteError("RunNotFound", `Run not found: ${input.runId}`);
    }
    const node = await input.adapter.getNode(input.runId, input.nodeId, iteration);
    if (!node) {
        throw new NodeOutputRouteError("NodeNotFound", `Node not found: ${input.nodeId}`);
    }
    const outputTable = typeof node.outputTable === "string" ? node.outputTable.trim() : "";
    if (!outputTable) {
        throw new NodeOutputRouteError("NodeHasNoOutput", `Node ${input.nodeId} has no output table.`);
    }
    const row = await fetchRawOutputRow(input.adapter, outputTable, input.runId, input.nodeId, iteration);
    input.stdout.write(`${JSON.stringify(stripOutputKeyColumns(row))}\n`);
    return { exitCode: EXIT_OK };
}

/**
 * Fetch the raw output row, resolving the physical table name.
 *
 * `_smithers_nodes.output_table` stores the workflow schema key verbatim
 * (e.g. `reviewCodex`) while the physical table is its snake_case form
 * (`review_codex`). Older runs may already store the snake_case name, so try
 * the stored name first and fall back to the snake_case translation.
 *
 * @param {import("@smithers-orchestrator/db/adapter").SmithersDb} adapter
 * @param {string} outputTable
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function fetchRawOutputRow(adapter, outputTable, runId, nodeId, iteration) {
    const row = await adapter.getRawNodeOutputForIteration(outputTable, runId, nodeId, iteration);
    if (row !== null && row !== undefined) {
        return row;
    }
    const snakeTable = camelToSnake(outputTable);
    if (snakeTable === outputTable) {
        return row ?? null;
    }
    // Only consult the snake_case form when the stored name has no physical
    // table: a real camelCase table whose row is merely missing must return
    // null rather than another table's row.
    if (await adapter.hasPhysicalTable(outputTable)) {
        return row ?? null;
    }
    return adapter.getRawNodeOutputForIteration(snakeTable, runId, nodeId, iteration);
}

/**
 * @param {RunOutputCommandInput} input
 * @returns {Promise<RunOutputCommandResult>}
 */
export async function runOutputOnce(input) {
    let iteration = input.iteration;
    if (typeof iteration !== "number") {
        const latest = await resolveLatestIteration(input.adapter, input.runId, input.nodeId);
        iteration = latest ?? 0;
    }
    try {
        if (input.json && !input.pretty) {
            return await runRawJsonOutput(input, iteration);
        }
        const response = await getNodeOutputRoute({
            runId: input.runId,
            nodeId: input.nodeId,
            iteration,
            async resolveRun(runId) {
                if (runId !== input.runId) return null;
                const run = await input.adapter.getRun(runId);
                if (!run) return null;
                return { adapter: input.adapter, workflow: input.workflow ?? {} };
            },
        });
        if (input.pretty) {
            input.stdout.write(`${renderPrettyOutput(response)}\n`);
        } else {
            // Ticket 0014 §"output --json — raw row (default)": emit the row,
            // not the response envelope. When the server signals non-produced
            // state (pending/failed) we still emit the row field verbatim so
            // scripts see `null` for those cases.
            input.stdout.write(`${JSON.stringify(response?.row ?? null)}\n`);
        }
        return { exitCode: EXIT_OK };
    } catch (err) {
        const code = err instanceof NodeOutputRouteError ? err.code : undefined;
        const message = err instanceof Error ? err.message : String(err);
        input.stderr.write(`${formatCliErrorForStderr(code, message)}\n`);
        const mapping = getCliErrorMapping(code, message);
        return { exitCode: mapping.exitCode };
    }
}
