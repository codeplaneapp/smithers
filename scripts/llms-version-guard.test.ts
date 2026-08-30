import assert from "node:assert/strict"
import test from "node:test"
import {
  assertRegenerable,
  checkVersionRelease,
  packageVersion,
  PUBLISHED_PACKAGE_NAME,
  versionStamp
} from "./llms-version-guard.ts"

test("stamps the bundles with the CLI's version, not the workspace root's", () => {
  const version = packageVersion()
  assert.match(version, /^\d+\.\d+\.\d+/)
  assert.equal(versionStamp(version), `Version: ${version}`)
  assert.equal(PUBLISHED_PACKAGE_NAME, "@smthrs/cli")
})

test("treats a release tag as authoritative without asking npm", () => {
  let asked = false
  const status = checkVersionRelease("9.9.9", {
    hasReleaseTag: () => true,
    checkPublication: () => {
      asked = true
      return "unreleased"
    }
  })
  assert.equal(status, "released")
  assert.equal(asked, false, "a tagged version must not need a registry lookup")
})

test("falls back to the registry when no tag exists", () => {
  const status = checkVersionRelease("9.9.9", {
    hasReleaseTag: () => false,
    checkPublication: () => "unreleased"
  })
  assert.equal(status, "unreleased")
})

test("allows a regeneration that changes nothing, whatever the release status", () => {
  for (const status of ["released", "unreleased", "unavailable"] as const) {
    assert.doesNotThrow(() => assertRegenerable("1.0.0-rc.0", [], status))
  }
})

test("allows a change while the version is unreleased", () => {
  assert.doesNotThrow(() => assertRegenerable("1.0.0-rc.0", ["docs/llms.txt"], "unreleased"))
})

test("refuses to rewrite the bundles of a released version", () => {
  assert.throws(
    () => assertRegenerable("1.0.0-rc.0", ["docs/llms.txt"], "released"),
    /already released[\s\S]*docs\/llms\.txt[\s\S]*Bump the version/
  )
})

test("refuses when the release status could not be determined", () => {
  assert.throws(
    () => assertRegenerable("1.0.0-rc.0", ["docs/llms-full.txt"], "unavailable"),
    /could not be determined/
  )
})
