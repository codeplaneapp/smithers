import assert from "node:assert/strict"
import * as root from "../../dist/esm/index.js"
import * as DurableWriter from "../../dist/esm/DurableWriter.js"

assert.strictEqual(root.DurableWriter.DurableWriter, DurableWriter.DurableWriter)
assert.strictEqual(root.DurableWriter.DatabaseError, DurableWriter.DatabaseError)
