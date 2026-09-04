const assert = require("node:assert/strict")
const root = require("../../dist/cjs/index.js")
const DurableWriter = require("../../dist/cjs/DurableWriter.js")

assert.strictEqual(root.DurableWriter.DurableWriter, DurableWriter.DurableWriter)
assert.strictEqual(root.DurableWriter.DatabaseError, DurableWriter.DatabaseError)
