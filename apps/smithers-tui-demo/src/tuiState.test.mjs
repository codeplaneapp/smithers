import assert from "node:assert/strict";
import test from "node:test";
import { buttonLabelForRunState, statusIdForRole } from "./tuiState.mjs";

test("run button switches from run to cancel to done", () => {
  assert.equal(buttonLabelForRunState("idle"), "Run Workflow");
  assert.equal(buttonLabelForRunState("running"), "Cancel");
  assert.equal(buttonLabelForRunState("done"), "Done");
  assert.equal(buttonLabelForRunState("cancelled"), "Run Workflow");
});

test("maps workflow runtime roles back to TUI graph node ids", () => {
  assert.equal(statusIdForRole("capitalism-round-1"), "capitalism_round_1");
  assert.equal(statusIdForRole("communism-round-2"), "communism_round_2");
  assert.equal(statusIdForRole("judge-final"), "judge_final");
});
