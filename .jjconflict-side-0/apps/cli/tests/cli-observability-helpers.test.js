import { describe, expect, test } from "bun:test";
import { DEFAULT_LIFECYCLE_EVENT_TYPES, renderAttemptPool, tallyAttemptPool } from "../src/observability-helpers.js";
import { eventCategoryForType } from "../src/event-categories.js";
import { buildDurabilityRunOptions } from "../src/up-engine-options.js";

describe("CLI observability helpers", () => {
    test("default event types keep lifecycle events and exclude raw agent chunks", () => {
        expect(DEFAULT_LIFECYCLE_EVENT_TYPES).toContain("NodeStarted");
        expect(DEFAULT_LIFECYCLE_EVENT_TYPES).toContain("RunStatusChanged");
        expect(DEFAULT_LIFECYCLE_EVENT_TYPES).toContain("ApprovalGranted");
        expect(DEFAULT_LIFECYCLE_EVENT_TYPES).toContain("ApprovalDenied");
        expect(DEFAULT_LIFECYCLE_EVENT_TYPES).not.toContain("AgentEvent");
    });

    test("default lifecycle event types all belong to the real event union", () => {
        for (const type of DEFAULT_LIFECYCLE_EVENT_TYPES) {
            expect(eventCategoryForType(type), type).not.toBeNull();
        }
    });

    test("pool tally groups engine/model and tolerates absent or malformed metadata", () => {
        const tally = tallyAttemptPool([
            { metaJson: JSON.stringify({ agentEngine: "codex", agentModel: "gpt-5.6-luna" }) },
            { metaJson: JSON.stringify({ agentEngine: "claude", agentModel: "claude-sonnet-5" }) },
            { metaJson: JSON.stringify({ agentEngine: "codex", agentModel: "gpt-5.6-luna" }) },
            { metaJson: null },
            { metaJson: "{bad" },
        ]);
        expect(tally).toEqual([
            { pool: "codex/gpt-5.6-luna", attempts: 2 },
            { pool: "claude/claude-sonnet-5", attempts: 1 },
        ]);
        expect(renderAttemptPool(tally)).toBe("codex/gpt-5.6-luna x2, claude/claude-sonnet-5 x1");
    });

    test("accept-workflow-change is threaded into engine durability options", () => {
        expect(buildDurabilityRunOptions({
            resume: true,
            force: false,
            acceptWorkflowChange: true,
        })).toEqual({ resume: true, force: false, acceptWorkflowChange: true });
    });
});
