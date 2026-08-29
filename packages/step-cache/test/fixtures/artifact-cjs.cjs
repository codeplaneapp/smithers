const assert = require("node:assert/strict")
const root = require("../../dist/cjs/index.js")
const CacheStore = require("../../dist/cjs/CacheStore.js")

assert.strictEqual(root.CacheStore.CacheStore, CacheStore.CacheStore)
assert.strictEqual(root.CacheStore.CacheStoreError, CacheStore.CacheStoreError)
