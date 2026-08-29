import assert from "node:assert/strict"
import * as root from "../../dist/esm/index.js"
import * as CacheStore from "../../dist/esm/CacheStore.js"

assert.strictEqual(root.CacheStore.CacheStore, CacheStore.CacheStore)
assert.strictEqual(root.CacheStore.CacheStoreError, CacheStore.CacheStoreError)
