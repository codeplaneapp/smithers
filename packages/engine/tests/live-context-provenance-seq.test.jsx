/** @jsxImportSource smithers-orchestrator */
/**
 * Regression pin for the live completion path: the row a finished task feeds
 * into the scheduler's render context must keep its durable completion seq
 * (`__smithersProvenanceSeq`), because `ctx.outputRows` on the very next
 * frame (before any DB reload) orders the fold by it and hard-errors when it
 * is missing. "fix(db): hide output provenance from payloads" made
 * `stripAutoColumns` strip the seq, which was correct for user-facing
 * payloads but also ran on `readTaskOutput`'s internal return value,
 * breaking every workflow that reads `ctx.outputRows` mid-run. The seq must
 * ride the internal context row while staying hidden from the user-facing
 * `ctx.output()` view.
 */
import React from "react";
import { describe, expect, test } from "bun:test";
import { Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { SmithersContext } from "@smithers-orchestrator/react-reconciler/context";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { z } from "zod";
import { Effect } from "effect";

describe("live render context keeps output provenance seq", () => {
  test("ctx.outputRows works on the frame right after a completion, and ctx.output() still hides the seq", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({ step: z.object({ value: z.number() }) });
    try {
      /** @type {Array<{ seq: number; payload: Record<string, unknown> }>} */
      const seenRows = [];
      /** @type {Record<string, unknown> | undefined} */
      let seenUserView;
      const workflow = smithers(() => {
        function Body() {
          const ctx = React.useContext(SmithersContext);
          const rows = ctx.outputRows("step", { nodeId: "producer" });
          for (const row of rows) {
            seenRows.push({ seq: row.seq, payload: /** @type {Record<string, unknown>} */ (row.payload) });
          }
          if (rows.length > 0) {
            seenUserView = /** @type {Record<string, unknown>} */ (ctx.outputMaybe("step", { nodeId: "producer" }));
          }
          return (
            <Workflow name="live-provenance-seq">
              <Task id="producer" output={outputs.step}>
                {() => ({ value: 41 })}
              </Task>
              {rows.length > 0 && (
                <Task id="consumer" output={outputs.step}>
                  {() => ({ value: 42 })}
                </Task>
              )}
            </Workflow>
          );
        }
        return <Body />;
      });

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("finished");
      expect(seenRows.length).toBeGreaterThan(0);
      expect(seenRows.every((row) => Number.isFinite(row.seq))).toBe(true);
      expect(seenRows.some((row) => row.payload.value === 41)).toBe(true);
      expect(seenRows.every((row) => !("__smithersProvenanceSeq" in row.payload))).toBe(true);
      expect(seenUserView).toBeDefined();
      expect("__smithersProvenanceSeq" in /** @type {Record<string, unknown>} */ (seenUserView)).toBe(false);
    } finally {
      await cleanup();
    }
  });
});
