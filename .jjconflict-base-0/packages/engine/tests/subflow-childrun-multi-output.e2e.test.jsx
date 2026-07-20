/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { SmithersDb, Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { Subflow } from "@smithers-orchestrator/components/components/index";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { Effect } from "effect";
const END_TO_END_TIMEOUT_MS = 30_000;
// A child that writes THREE output tables. Its declared workflow output is the
// FINAL task's table (`decision`), so that row — not a table-keyed snapshot of
// every table the child wrote — is what a childRun parent receives. Mirrors
// examples/subflow-multi-output.jsx (#1006).
function buildSmithers() {
    return createTestSmithers({
        draft: z.object({ text: z.string() }),
        stats: z.object({ wordCount: z.number() }),
        decision: z.object({ decision: z.string(), wordCount: z.number() }),
        subflowDecision: z.object({ decision: z.string(), wordCount: z.number() }),
        announcement: z.object({ headline: z.string() }),
    });
}
describe("Subflow childRun output with a multi-output child", () => {
    test("the parent receives the child's final task row, not a table-keyed snapshot", async () => {
        const { smithers, outputs, tables, db, cleanup } = buildSmithers();
        try {
            const childWorkflow = smithers((ctx) => (<Workflow name="multi-output-child">
          <Task id="draft" output={outputs.draft}>
            {{ text: `Draft about ${ctx.input.topic ?? "nothing"}` }}
          </Task>
          <Task id="stats" output={outputs.stats} deps={{ draft: outputs.draft }}>
            {(deps) => ({ wordCount: deps.draft.text.trim().split(/\s+/).length })}
          </Task>
          <Task id="decision" output={outputs.decision} deps={{ draft: outputs.draft, stats: outputs.stats }}>
            {(deps) => ({
                    decision: deps.stats.wordCount >= 3 ? "publish" : "expand",
                    wordCount: deps.stats.wordCount,
                })}
          </Task>
        </Workflow>), { output: outputs.decision });
            /** @type {any} */
            let received;
            const parentWorkflow = smithers(() => (<Workflow name="multi-output-parent">
          <Subflow id="review" mode="childRun" output={outputs.subflowDecision} workflow={childWorkflow} input={{ topic: "subflow outputs" }}/>
          <Task id="announce" output={outputs.announcement} deps={{ review: outputs.subflowDecision }}>
            {(deps) => {
                    received = deps.review;
                    return { headline: `${deps.review.decision} at ${deps.review.wordCount} words` };
                }}
          </Task>
        </Workflow>));
            const result = await Effect.runPromise(runWorkflow(parentWorkflow, { input: {} }));
            expect(result.status).toBe("finished");
            const adapter = new SmithersDb(db);
            const childRun = await adapter.getLatestChildRun(result.runId);
            expect(childRun?.status).toBe("finished");
            // The child really wrote multiple output tables, all scoped to the
            // child run — none of them are copied into the parent run.
            const draftRows = await db.select().from(tables.draft);
            const statsRows = await db.select().from(tables.stats);
            const decisionRows = await db.select().from(tables.decision);
            expect(draftRows).toEqual([
                expect.objectContaining({ runId: childRun?.runId, nodeId: "draft" }),
            ]);
            expect(statsRows).toEqual([
                expect.objectContaining({ runId: childRun?.runId, nodeId: "stats", wordCount: 4 }),
            ]);
            expect(decisionRows).toEqual([
                expect.objectContaining({
                    runId: childRun?.runId,
                    nodeId: "decision",
                    decision: "publish",
                    wordCount: 4,
                }),
            ]);
            // The parent persisted exactly the child's FINAL task row under its
            // own run/node. A table-keyed snapshot like { draft: [...], stats:
            // [...], decision: [...] } would have failed subflowDecision's schema
            // validation and the run above could not have finished.
            const subflowRows = await db.select().from(tables.subflowDecision);
            expect(subflowRows).toEqual([
                expect.objectContaining({
                    runId: result.runId,
                    nodeId: "review",
                    decision: "publish",
                    wordCount: 4,
                }),
            ]);
            // The downstream parent task consumed the final task's row shape —
            // no keys named after the child's tables.
            expect(received).toMatchObject({ decision: "publish", wordCount: 4 });
            expect(Object.keys(received)).not.toContain("draft");
            expect(Object.keys(received)).not.toContain("stats");
            // In a table-keyed snapshot "decision" would map to an array of
            // rows; here it is the final task's scalar column value.
            expect(received.decision).toBe("publish");
            const announcementRows = await db.select().from(tables.announcement);
            expect(announcementRows).toEqual([
                expect.objectContaining({
                    runId: result.runId,
                    nodeId: "announce",
                    headline: "publish at 4 words",
                }),
            ]);
        }
        finally {
            cleanup();
        }
    }, END_TO_END_TIMEOUT_MS);
});
