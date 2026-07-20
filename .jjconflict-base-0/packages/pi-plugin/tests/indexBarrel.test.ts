import { describe, expect, test } from "bun:test";
import * as barrel from "../src/index.js";

// Importing the package barrel executes every re-export line and pins the
// public surface.
describe("pi-plugin package barrel", () => {
  test("re-exports the public API", () => {
    const expected = [
      "approve",
      "cancel",
      "deny",
      "getFrames",
      "getStatus",
      "listRuns",
      "resume",
      "runWorkflow",
      "streamEvents",
      "buildSmithersPiSystemPrompt",
      "extension",
      "DevToolsClient",
      "DevToolsStore",
      "FrameScrubber",
      "Header",
      "NodeInspector",
      "RunInspector",
      "RunTree",
    ];
    for (const name of expected) {
      expect(barrel[name as keyof typeof barrel]).toBeDefined();
    }
  });
});
