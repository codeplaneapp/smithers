import { describe, expect, test } from "bun:test";
import {
    buildAskKindFields,
    buildAskPromptText,
    buildAskUniqueToken,
    formatAskHumanResolveHelp,
    parseChoices,
    resolveAskHumanContext,
} from "../src/ask-human.js";

/**
 * @param {any[]} runs
 */
function fakeAdapter(runs) {
    return { listRuns: async () => runs };
}

describe("resolveAskHumanContext", () => {
    test("explicit flags win over env and autodetect", async () => {
        const adapter = fakeAdapter([{ runId: "run-active", status: "running" }]);
        const ctx = await resolveAskHumanContext(adapter, {
            runId: "run-flag",
            nodeId: "node-flag",
            iteration: 2,
            env: { SMITHERS_RUN_ID: "run-env", SMITHERS_NODE_ID: "node-env" },
        });
        expect(ctx).toEqual({
            runId: "run-flag",
            nodeId: "node-flag",
            iteration: 2,
            source: "flag",
        });
    });

    test("falls back to SMITHERS_* env when no flags given", async () => {
        const adapter = fakeAdapter([]);
        const ctx = await resolveAskHumanContext(adapter, {
            env: {
                SMITHERS_RUN_ID: "run-env",
                SMITHERS_NODE_ID: "node-env",
                SMITHERS_ITERATION: "3",
            },
        });
        expect(ctx).toEqual({
            runId: "run-env",
            nodeId: "node-env",
            iteration: 3,
            source: "env",
        });
    });

    test("autodetects the single active run and defaults the node id", async () => {
        const adapter = fakeAdapter([
            { runId: "run-done", status: "succeeded" },
            { runId: "run-active", status: "waiting-approval" },
        ]);
        const ctx = await resolveAskHumanContext(adapter, { env: {} });
        expect(ctx).toEqual({
            runId: "run-active",
            nodeId: "agent-ask",
            iteration: 0,
            source: "autodetect",
        });
    });

    test("throws on no active run", async () => {
        const adapter = fakeAdapter([{ runId: "run-done", status: "succeeded" }]);
        await expect(
            resolveAskHumanContext(adapter, { env: {} }),
        ).rejects.toMatchObject({ code: "ASK_HUMAN_NO_ACTIVE_RUN" });
    });

    test("throws when multiple active runs are ambiguous", async () => {
        const adapter = fakeAdapter([
            { runId: "run-a", status: "running" },
            { runId: "run-b", status: "waiting-event" },
        ]);
        await expect(
            resolveAskHumanContext(adapter, { env: {} }),
        ).rejects.toMatchObject({ code: "ASK_HUMAN_AMBIGUOUS_RUN" });
    });
});

describe("ask-human request shaping", () => {
    test("parseChoices trims, dedupes, and nulls empties", () => {
        expect(parseChoices("approve, deny , approve, escalate")).toEqual([
            "approve",
            "deny",
            "escalate",
        ]);
        expect(parseChoices("   ")).toBeNull();
        expect(parseChoices(undefined)).toBeNull();
    });

    test("buildAskKindFields produces a free-form ask by default", () => {
        expect(buildAskKindFields(null)).toEqual({
            kind: "ask",
            optionsJson: null,
            schemaJson: null,
        });
    });

    test("buildAskKindFields produces a select with an enum schema", () => {
        const fields = buildAskKindFields(["approve", "deny"]);
        expect(fields.kind).toBe("select");
        expect(JSON.parse(String(fields.optionsJson))).toEqual(["approve", "deny"]);
        expect(JSON.parse(String(fields.schemaJson))).toEqual({
            type: "string",
            enum: ["approve", "deny"],
        });
    });

    test("buildAskPromptText appends context when present", () => {
        expect(buildAskPromptText("Proceed?", "prod database")).toBe(
            "Proceed?\n\nContext:\nprod database",
        );
        expect(buildAskPromptText("Proceed?", undefined)).toBe("Proceed?");
    });

    test("buildAskUniqueToken is deterministic given injected clock/rng", () => {
        expect(buildAskUniqueToken(() => 0, () => 0)).toBe("ask-0-0000");
    });

    test("formatAskHumanResolveHelp surfaces the resolve commands", () => {
        const help = formatAskHumanResolveHelp("human:run:node:0:ask-1", null);
        expect(help).toContain("smithers human answer human:run:node:0:ask-1 --value");
        expect(help).toContain("smithers human cancel human:run:node:0:ask-1");
        expect(help).toContain("smithers human inbox");
    });
});
