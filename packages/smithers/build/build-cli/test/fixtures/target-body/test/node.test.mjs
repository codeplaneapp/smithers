import assert from "node:assert/strict"
import test from "node:test"

test("node executes", () => {
  assert.equal(6 * 7, 42)
})
