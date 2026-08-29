import assert from "node:assert/strict"
import * as root from "../../dist/esm/index.js"
import * as DurableEngineState from "../../dist/esm/DurableEngineState.js"
import * as StepBoundary from "../../dist/esm/StepBoundary.js"

assert.strictEqual(
  root.DurableEngineState.DurableEngineState,
  DurableEngineState.DurableEngineState
)
assert.strictEqual(root.StepBoundary.StepBoundary, StepBoundary.StepBoundary)
