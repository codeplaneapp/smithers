import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";
export const approvalSchema = z.object({
    approved: z.boolean(),
    note: z.string().nullable(),
    decidedBy: z.string().nullable(),
    decidedAt: z.string().nullable(),
});
/**
 * @template Schemas
 * @param {Schemas} schemas
 */
export function createExampleSmithers(schemas) {
    return createSmithers(schemas, { dbPath: "smithers.db" });
}
/**
 * @template T
 * @param {T[] | undefined} values
 */
export function latest(values) {
    return values?.[values.length - 1];
}
/**
 * @template T
 * @param {T[] | undefined | null} values
 */
export function asArray(values) {
    return values ?? [];
}
/**
 * @template T
 * @param {T[] | undefined} values
 * @param {(value: T) => number} select
 */
export function sumBy(values, select) {
    return asArray(values).reduce((sum, value) => sum + select(value), 0);
}
/**
 * @param {number[]} values
 */
export function average(values) {
    if (values.length === 0)
        return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}
/**
 * @template T
 * @param {T[] | undefined} values
 * @param {(value: T) => string} keyOf
 */
export function countBy(values, keyOf) {
    const counts = {};
    for (const value of asArray(values)) {
        const key = keyOf(value);
        counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
}
/**
 * @template T
 * @param {T[]} values
 */
export function unique(values) {
    return [...new Set(values)];
}
/**
 * @param {number} current
 * @param {number} baseline
 */
export function percentDelta(current, baseline) {
    if (baseline === 0) {
        return current === 0 ? 0 : 100;
    }
    return ((current - baseline) / baseline) * 100;
}
/**
 * @param {number} value
 */
export function round(value, digits = 1) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}
/**
 * @template Row
 * @param {string} id
 * @param {(args: { prompt: string }) => Row | Promise<Row>} build
 * @param {Record<string, any>} [tools]
 * @returns {AgentLike}
 */
export function makeAgent(id, build, tools) {
    return {
        id,
        tools,
        async generate(args) {
            return { output: await build({ prompt: args.prompt }) };
        },
    };
}
