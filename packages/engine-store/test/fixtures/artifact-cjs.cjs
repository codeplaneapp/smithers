const assert = require("node:assert/strict")
const root = require("../../dist/cjs/index.js")
const DurableEngineState = require("../../dist/cjs/DurableEngineState.js")
const StepBoundary = require("../../dist/cjs/StepBoundary.js")

assert.strictEqual(
  root.DurableEngineState.DurableEngineState,
  DurableEngineState.DurableEngineState
)
assert.strictEqual(root.StepBoundary.StepBoundary, StepBoundary.StepBoundary)
