import assert from "node:assert/strict"
import * as root from "../../dist/esm/index.js"
import * as Journal from "../../dist/esm/Journal.js"

assert.strictEqual(root.Journal.Journal, Journal.Journal)
assert.strictEqual(root.Journal.JournalError, Journal.JournalError)
