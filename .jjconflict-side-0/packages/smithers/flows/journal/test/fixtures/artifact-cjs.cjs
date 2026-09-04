const assert = require("node:assert/strict")
const root = require("../../dist/cjs/index.js")
const Journal = require("../../dist/cjs/Journal.js")

assert.strictEqual(root.Journal.Journal, Journal.Journal)
assert.strictEqual(root.Journal.JournalError, Journal.JournalError)
