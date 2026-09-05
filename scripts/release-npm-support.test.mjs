import assert from "node:assert/strict"
import test from "node:test"
import { assertSmokeNpmSupport } from "./release-npm-support.mjs"

test("release smoke enforces the certified npm floor at its boundaries", () => {
  for (const version of ["11.16.0", "11.16.1", "12.0.0"]) {
    assert.doesNotThrow(() => assertSmokeNpmSupport(version), version)
  }
  for (const version of ["10.9.3", "11.15.9", "11.16.0-rc.1", "invalid"]) {
    assert.throws(() => assertSmokeNpmSupport(version), /requires npm >=11\.16\.0/, version)
  }
})
