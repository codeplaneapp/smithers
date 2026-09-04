import assert from "node:assert/strict"
import * as root from "../../dist/esm/index.js"
import * as RunStore from "../../dist/esm/RunStore.js"

assert.strictEqual(root.RunStore.RunStore, RunStore.RunStore)
assert.strictEqual(root.RunStore.RunStoreError, RunStore.RunStoreError)
