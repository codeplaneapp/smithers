import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { registryPublisher } from "./publish-release.mjs"

// Exercise the production registry boundary without publishing or waiting.
const fixture = (responses) => {
  const calls = []
  const adapter = registryPublisher({
    run: (command, args) => {
      assert.equal(command, "pnpm")
      calls.push(args)
      const response = responses[args[0]].shift()
      assert.notEqual(response, undefined, `Unexpected registry call: ${args.join(" ")}`)
      if (response !== 200) throw Object.assign(new Error(`E${response}`), { stdout: `E${response}` })
      return '"sha512-verified"'
    },
    pause: (seconds) => calls.push(["sleep", String(seconds)])
  })
  return { adapter, calls }
}

test("new names publish with provenance from a detached tag checkout", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")
  assert.match(workflow, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/)
  const { adapter, calls } = fixture({ view: [404], publish: [200] })
  assert.equal(adapter.readRegistry("@smthrs/kernel@1.0.0-rc.0"), undefined)
  adapter.publish("kernel.tgz", { version: "1.0.0-rc.0" })
  assert.deepEqual(calls[1], ["publish", "kernel.tgz", "--provenance", "--access", "public", "--tag", "next", "--no-git-checks"])
})

test("already published versions return their exact integrity for candidate verification", () => {
  const { adapter, calls } = fixture({ view: [200], publish: [] })
  assert.equal(adapter.readRegistry("@smthrs/kernel@1.0.0-rc.0"), "sha512-verified")
  assert.deepEqual(calls.map(([command]) => command), ["view"])
})

test("transient prechecks back off before deciding whether to publish", () => {
  const { adapter, calls } = fixture({ view: [429, 503, 500, 404], publish: [] })
  assert.equal(adapter.readRegistry("@smthrs/kernel@1.0.0-rc.0"), undefined)
  assert.deepEqual(calls.filter(([command]) => command === "sleep"), [["sleep", "10"], ["sleep", "30"], ["sleep", "60"]])
})

test("an exhausted or unauthorized precheck fails closed", () => {
  for (const failures of [[429, 503, 500, 503], [401]]) {
    const { adapter, calls } = fixture({ view: failures, publish: [] })
    assert.throws(() => adapter.readRegistry("@smthrs/kernel@1.0.0-rc.0"))
    assert.equal(calls.some(([command]) => command === "publish"), false)
  }
})

test("publication retries use all three delays and stop after exhaustion", () => {
  for (const last of [200, 503]) {
    const { adapter, calls } = fixture({ view: [], publish: [503, 503, 503, last] })
    const publish = () => adapter.publish("kernel.tgz", { version: "1.0.0-rc.0" })
    if (last === 200) publish()
    else assert.throws(publish)
    assert.equal(calls.filter(([command]) => command === "publish").length, 4)
    assert.deepEqual(calls.filter(([command]) => command === "sleep"), [["sleep", "10"], ["sleep", "30"], ["sleep", "60"]])
  }
})
