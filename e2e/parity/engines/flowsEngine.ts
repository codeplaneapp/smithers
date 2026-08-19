import type { ParityEngine } from "./ParityEngine.ts";

/**
 * The flows engine lane.
 *
 * Stage 0.5 of the flows migration builds this harness and records the legacy
 * engine's results as the fixture oracle; stage 1.3 ("dual-engine routing")
 * is the lane that makes `createWorkflowSession` accept an engine selector and
 * routes a run onto `FlowEngine` plus `DurableEngineState`. Until that lands
 * there is nothing to execute against, so this engine reports itself
 * unavailable and the suite runs the legacy engine alone.
 *
 * The seam is deliberately here and not in the test: stage 1.3 replaces
 * `unavailableReason` and `execute` in this one file, and every fixture,
 * oracle, and assertion in the suite carries over untouched.
 */
export const flowsEngine: ParityEngine = {
  id: "flows",
  description: "@smthrs/flows FlowEngine via the stage 1.3 engine selector",
  unavailableReason: () =>
    "the flows engine selector lands in stage 1.3 of .smithers/specs/flows-migration.md; " +
    "until then e2e/parity runs the legacy engine and records its results as the oracle",
  execute: () => {
    throw new Error(
      "parity: the flows engine is not wired up yet (stage 1.3). " +
        "Implement e2e/parity/engines/flowsEngine.ts before selecting it.",
    );
  },
};
