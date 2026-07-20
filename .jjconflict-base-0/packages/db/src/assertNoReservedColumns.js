import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { camelToSnake } from "./utils/camelToSnake.js";

const OUTPUT_RESERVED = new Set(["run_id", "node_id", "iteration"]);
const INPUT_RESERVED = new Set(["run_id"]);

/**
 * Throw a clear error if a user schema field collides with a smithers internal
 * key column. Output tables reserve `run_id`/`node_id`/`iteration`; input tables
 * reserve only `run_id`. Without this guard a colliding field either crashes DDL
 * with a raw `duplicate column name` (the SQL path) or silently overwrites the
 * internal key column and corrupts the composite primary key (the drizzle path),
 * with no diagnostic naming the offending field.
 *
 * @param {{ shape?: Record<string, unknown> }} schema
 * @param {string} [tableName]
 * @param {{ isInput?: boolean }} [opts]
 * @returns {void}
 */
export function assertNoReservedColumns(schema, tableName, opts) {
    const shape = schema?.shape;
    if (!shape || typeof shape !== "object")
        return;
    const reserved = opts?.isInput ? INPUT_RESERVED : OUTPUT_RESERVED;
    // camelToSnake handles both camelCase and already-snake keys
    // (camelToSnake("node_id") === "node_id"), so one snake-set check catches
    // `nodeId` AND a literal `node_id`.
    const offenders = Object.keys(shape).filter((key) => reserved.has(camelToSnake(key)));
    if (offenders.length === 0)
        return;
    const where = tableName ? ` for "${tableName}"` : "";
    const reservedList = opts?.isInput
        ? "run_id (camelCase runId)"
        : "run_id, node_id and iteration (camelCase runId/nodeId/iteration)";
    throw new SmithersError("INVALID_INPUT", `${opts?.isInput ? "Input" : "Output"} schema${where} uses reserved field name(s): ${offenders.join(", ")}. ` +
        `smithers persists every ${opts?.isInput ? "input" : "node output"} with internal column(s) ${reservedList}. ` +
        `Rename the conflicting field(s) - e.g. nodeId -> targetNodeId, runId -> sourceRunId, iteration -> attempt.`, { table: tableName, offenders });
}
