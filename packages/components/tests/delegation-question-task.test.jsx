/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { withTaskRuntime } from "@smithers-orchestrator/driver/task-runtime";
import { SmithersRenderer } from "@smithers-orchestrator/react-reconciler/dom/renderer";
import { createTestSmithers } from "./helpers.js";
import { DelegationQuestionTask } from "../src/components/delegation/DelegationQuestionTask.js";

async function render(el) {
    const renderer = new SmithersRenderer();
    return renderer.render(el);
}

function runtimeFor(db, runId, nodeId, iteration = 0) {
    return { db, runId, nodeId, iteration };
}

const baseForm = {
    logicalId: "goal",
    seq: 1,
    question: "q1?",
    header: "Q1",
    kind: "text",
    recommended: "orig",
    reason: "r",
};

/**
 * Seed an approval note, render the question task, and fold the note into a
 * dcQuestion row exactly as the durable human request would.
 */
async function foldNote(note, form = baseForm) {
    const { db, cleanup } = createTestSmithers({});
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    await adapter.insertOrUpdateApproval({
        runId: "run",
        nodeId: "dc:goal:question-1",
        iteration: 0,
        status: "approved",
        requestedAtMs: 1,
        decidedAtMs: 1,
        note,
        decidedBy: "u",
        requestJson: null,
        decisionJson: null,
        autoApproved: false,
    });
    const rendered = await render(
        <DelegationQuestionTask id="dc:goal:question-1" output="dcQuestion" form={form} prompt="p" />,
    );
    const compute = () => withTaskRuntime(runtimeFor(db, "run", "dc:goal:question-1"), () => rendered.tasks[0].computeFn());
    return { compute, cleanup };
}

describe("DelegationQuestionTask answer folding", () => {
    test("a bare string overwrites the recommended default", async () => {
        for (const note of ['"custom"', "custom"]) {
            const { compute, cleanup } = await foldNote(note);
            try {
                const row = await compute();
                expect(row.recommended).toBe("custom");
                expect(row.resolved).toBe(true);
            }
            finally {
                cleanup();
            }
        }
    });

    test("a confirm boolean folds into yes/no", async () => {
        const confirmForm = { ...baseForm, kind: "confirm" };
        const yes = await foldNote("true", confirmForm);
        try {
            expect((await yes.compute()).recommended).toBe("yes");
        }
        finally {
            yes.cleanup();
        }
        const no = await foldNote("false", confirmForm);
        try {
            expect((await no.compute()).recommended).toBe("no");
        }
        finally {
            no.cleanup();
        }
    });

    test("a full-object submission merges field-by-field with resolved forced true", async () => {
        const { compute, cleanup } = await foldNote(JSON.stringify({ recommended: "x", reason: "changed" }));
        try {
            const row = await compute();
            expect(row.recommended).toBe("x");
            expect(row.reason).toBe("changed");
            expect(row.resolved).toBe(true);
        }
        finally {
            cleanup();
        }
    });

    test("a non-JSON note is treated as the literal answer text", async () => {
        const { compute, cleanup } = await foldNote("free-form prose that is not json");
        try {
            expect((await compute()).recommended).toBe("free-form prose that is not json");
        }
        finally {
            cleanup();
        }
    });

    test("a submission that cannot fold into a dcQuestion row throws", async () => {
        const { compute, cleanup } = await foldNote(JSON.stringify({ kind: "bogus" }));
        try {
            await expect(compute()).rejects.toThrow(/does not fold into a dcQuestion row|HUMAN_TASK_VALIDATION_FAILED/);
        }
        finally {
            cleanup();
        }
    });
});
