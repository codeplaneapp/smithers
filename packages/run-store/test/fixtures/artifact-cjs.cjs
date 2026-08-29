const assert = require("node:assert/strict")
const root = require("../../dist/cjs/index.js")
const RunStore = require("../../dist/cjs/RunStore.js")

assert.strictEqual(root.RunStore.RunStore, RunStore.RunStore)
assert.strictEqual(root.RunStore.RunStoreError, RunStore.RunStoreError)
