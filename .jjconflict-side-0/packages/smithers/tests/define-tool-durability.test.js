import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { runWithToolContext } from "@smithers-orchestrator/tool-context";
import { defineTool } from "../src/tools/defineTool.js";

describe("defineTool durability snapshot (Tier 1 in-process wrap)", () => {
    test("snapshots after a sideEffect tool, with the tool name, inside a tool context", async () => {
        const snaps = [];
        const tool = defineTool({
            name: "write", schema: z.object({ path: z.string() }), sideEffect: true, idempotent: false,
            execute: async ({ path }, _ctx) => `wrote ${path}`,
        });
        const ctx = { runId: "r", nodeId: "n", durabilitySnapshot: async (label) => { snaps.push(label); } };
        const result = await runWithToolContext(ctx, () => tool.execute({ path: "a.ts" }));
        expect(result).toBe("wrote a.ts");
        expect(snaps).toEqual(["write"]);
    });

    test("does not snapshot for a non-sideEffect tool", async () => {
        const snaps = [];
        const tool = defineTool({ name: "read", schema: z.object({ path: z.string() }), sideEffect: false, execute: async () => "x" });
        await runWithToolContext({ durabilitySnapshot: async (l) => snaps.push(l) }, () => tool.execute({ path: "a" }));
        expect(snaps).toEqual([]);
    });

    test("a throwing snapshot never fails the tool", async () => {
        const tool = defineTool({ name: "write", schema: z.object({}), sideEffect: true, idempotent: false, execute: async (_a, _c) => "ok" });
        const result = await runWithToolContext({ durabilitySnapshot: async () => { throw new Error("boom"); } }, () => tool.execute({}));
        expect(result).toBe("ok");
    });

    test("with no ambient context, the default no-op snapshot runs (no throw)", async () => {
        const tool = defineTool({ name: "write", schema: z.object({}), sideEffect: true, idempotent: false, execute: async (_a, _c) => "ok" });
        expect(await tool.execute({})).toBe("ok");
    });
});
