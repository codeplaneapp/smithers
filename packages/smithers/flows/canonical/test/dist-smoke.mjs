import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { test } from "node:test"

const require = createRequire(import.meta.url)

test("the built root exports canonicalize to CJS and ESM consumers", async () => {
  const cjs = require("../dist/cjs/index.js")
  const esm = await import("../dist/esm/index.js")
  assert.equal(cjs.canonicalize({ b: 2, a: 1 }), '{"a":1,"b":2}')
  assert.equal(esm.canonicalize({ b: 2, a: 1 }), '{"a":1,"b":2}')
})
