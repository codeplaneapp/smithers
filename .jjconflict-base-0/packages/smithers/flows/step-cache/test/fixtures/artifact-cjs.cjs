const assert = require("node:assert/strict")
const root = require("../../dist/cjs/index.js")
const CacheStore = require("../../dist/cjs/CacheStore.js")
const Migrations = require("../../dist/cjs/Migrations.js")

assert.strictEqual(root.CacheStore.CacheStore, CacheStore.CacheStore)
assert.strictEqual(root.CacheStore.CacheStoreError, CacheStore.CacheStoreError)

// A default import of a sibling module compiles to Node-style interop under
// `"type": "module"`, which reads the whole exports object instead of the
// Effect. Every migration the CommonJS entry holds must still be an Effect.
for (const [id, migration] of Object.entries(Migrations.set.migrations)) {
  assert.strictEqual(typeof migration.pipe, "function", `${id} is not an Effect in the CommonJS build`)
}
