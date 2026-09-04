import assert from "node:assert/strict"
import * as root from "../../dist/esm/index.js"
import * as CacheStore from "../../dist/esm/CacheStore.js"
import * as Migrations from "../../dist/esm/Migrations.js"

assert.strictEqual(root.CacheStore.CacheStore, CacheStore.CacheStore)
assert.strictEqual(root.CacheStore.CacheStoreError, CacheStore.CacheStoreError)

for (const [id, migration] of Object.entries(Migrations.set.migrations)) {
  assert.strictEqual(typeof migration.pipe, "function", `${id} is not an Effect in the ESM build`)
}
