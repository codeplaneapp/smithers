import { expect, test } from "bun:test";
import * as smithers from "smithers-orchestrator";

// Guards the programmatic run-control + output-reading API on the public barrel.
// These power embedders that drive durable runs across processes (start a run,
// pause at an <Approval> gate, approve/deny, resume, and read node outputs)
// without reaching into internal @smithers-orchestrator/* subpackages.
test("public barrel exposes the programmatic run-control + output API", () => {
  const surface = smithers as unknown as Record<string, unknown>;
  for (const name of [
    "runWorkflow",
    "approveNode",
    "denyNode",
    "getRun",
    "listRuns",
    "signalRun",
    "loadOutputs",
    "loadOutputsEffect",
  ]) {
    expect(typeof surface[name]).toBe("function");
  }
});
