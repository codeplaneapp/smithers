/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { extractGraph } from "../src/extract.js";

/**
 * @param {string} tag
 * @param {Record<string, any>} [rawProps]
 * @param {HostNode[]} [children]
 * @returns {HostElement}
 */
function hostEl(tag, rawProps = {}, children = []) {
    const stringProps = {};
    for (const [k, v] of Object.entries(rawProps)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
            stringProps[k] = String(v);
        }
    }
    return { kind: "element", tag, props: stringProps, rawProps, children };
}

describe("resolveOutput drizzle handling (src/extract.js)", () => {
    test("real drizzle table sets outputTable and outputTableName via getTableName", () => {
        const table = sqliteTable("table_out", {
            runId: text("run_id").primaryKey(),
        });
        const root = hostEl("smithers:task", { id: "table-task", output: table });
        const result = extractGraph(root);
        expect(result.tasks[0].outputTable).toBe(table);
        expect(result.tasks[0].outputTableName).toBe("table_out");
    });

    test("plain non-Zod object is not treated as a table", () => {
        // A bare object whose own properties (e.g. a `name` string) previously
        // tricked the loose maybeTableName heuristic into emitting a bogus table
        // descriptor with a stray/empty name. It must fall through to the
        // non-table path: outputTable null and outputTableName "".
        const root = hostEl("smithers:task", {
            id: "object-task",
            output: { name: "looks-like-a-table", nope: true },
        });
        const result = extractGraph(root);
        expect(result.tasks[0].outputTable).toBeNull();
        expect(result.tasks[0].outputTableName).toBe("");
    });
});
