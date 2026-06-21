import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { renderFrame } from "smithers-orchestrator";
import workflow from "./workflow";

// No mocks: load the REAL example workflow and render one frame the same way
// `smithers graph` does (renderFrame, no agent execution). This is the anti-rot
// proof for the doc that embeds this file's source: if <Aspects>,
// <TryCatchFinally>, <ContinueAsNew>, or <Loop> drift, the render breaks here.
describe("context-handoff example", () => {
  test("renders the Aspects + TryCatchFinally + ContinueAsNew handoff DAG", async () => {
    const snapshot: any = await Effect.runPromise(
      renderFrame(workflow, {
        runId: "context-handoff-test",
        iteration: 0,
        input: {},
        outputs: {},
      } as any),
    );

    // The active task lives in the try branch and carries the token budget that
    // <Aspects> propagates; a breach of that budget is what triggers the handoff.
    expect(snapshot.tasks).toHaveLength(1);
    const step = snapshot.tasks[0];
    expect(step?.nodeId).toBe("step");
    expect(step?.aspects?.tokenBudget).toMatchObject({
      max: 150_000,
      onExceeded: "fail",
    });

    // The rendered tree must contain both branches: the loop in the try, and the
    // continue-as-new handoff in the catch.
    const xml = JSON.stringify(snapshot.xml);
    expect(xml).toContain("smithers:try-catch-finally");
    expect(xml).toContain("smithers:tcf-try");
    expect(xml).toContain("smithers:ralph"); // <Loop> renders as a ralph node
    expect(xml).toContain("smithers:tcf-catch");
    expect(xml).toContain("smithers:continue-as-new");
  });
});
