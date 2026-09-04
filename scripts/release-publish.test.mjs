import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")
const publishStep = workflow.split("      - name: Publish packages in dependency order\n")[1].split("      - name:")[0]
const shell = publishStep.split("        run: |\n")[1].replace(/^          /gm, "")

// Execute the workflow's actual shell at the registry boundary. The command
// shims return HTTP failures and record sleeps without publishing or waiting.
const publish = (responses, packages = ["@smthrs/kernel"]) => {
  const root = mkdtempSync(join(tmpdir(), "smthrs-publish-"))
  try {
    mkdirSync(join(root, "bin"))
    writeFileSync(join(root, "responses.json"), JSON.stringify(responses))
    writeFileSync(join(root, "calls.jsonl"), "")
    writeFileSync(
      join(root, "order.txt"),
      packages.map((name) => `${name} ${name.split("/")[1]}.tgz`).join("\n") + "\n"
    )
    writeFileSync(
      join(root, "bin", "pnpm"),
      `#!/usr/bin/env node
const fs = require("node:fs")
const args = process.argv.slice(2)
fs.appendFileSync("calls.jsonl", JSON.stringify(args) + "\\n")
const responses = JSON.parse(fs.readFileSync("responses.json", "utf8"))
const response = responses[args[0]].shift()
if (response === undefined) throw new Error("unexpected registry call: " + args.join(" "))
fs.writeFileSync("responses.json", JSON.stringify(responses))
process.stdout.write(response === 200 ? '"1.0.0-rc.0"' : "E" + response)
process.exit(response === 200 ? 0 : 1)
`
    )
    writeFileSync(
      join(root, "bin", "sleep"),
      `#!/usr/bin/env node
require("node:fs").appendFileSync("calls.jsonl", JSON.stringify(["sleep", ...process.argv.slice(2)]) + "\\n")
`
    )
    for (const name of ["pnpm", "sleep"]) chmodSync(join(root, "bin", name), 0o755)
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", shell], {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        PACK_DIR: root,
        PUBLISH_ORDER: join(root, "order.txt"),
        PUBLISH_VERSION: "1.0.0-rc.0",
        PUBLISH_DIST_TAG: "next"
      }
    })
    const calls = readFileSync(join(root, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    return { ...result, calls }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test("new names publish with provenance from a detached tag checkout and packages are paced", () => {
  assert.match(publishStep, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/)
  const result = publish({ view: [404, 404], publish: [200, 200] }, ["@smthrs/kernel", "@smthrs/flow"])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.calls.map(([command]) => command), ["view", "publish", "sleep", "view", "publish"])
  assert.deepEqual(result.calls[2], ["sleep", "2"])
  for (const args of result.calls.filter(([command]) => command === "publish")) {
    assert.deepEqual(args.slice(2), ["--provenance", "--access", "public", "--tag", "next", "--no-git-checks"])
  }
})

test("already published versions are skipped", () => {
  const result = publish({ view: [200], publish: [] })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.calls.map(([command]) => command), ["view"])
})

test("transient prechecks back off before deciding whether to publish", () => {
  const result = publish({ view: [429, 503, 500, 404], publish: [200] })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.calls.filter(([command]) => command === "sleep"), [["sleep", "10"], ["sleep", "30"], [
    "sleep",
    "60"
  ]])
  assert.equal(result.calls.at(-1)[0], "publish")
})

test("an exhausted or unauthorized precheck never attempts publication", () => {
  for (const failures of [[429, 503, 500, 503], [401]]) {
    const result = publish({ view: failures, publish: [] })
    assert.equal(result.status, 1)
    assert.equal(result.calls.some(([command]) => command === "publish"), false)
  }
})

test("publication retries use all three delays and stop after exhaustion", () => {
  for (const last of [200, 503]) {
    const result = publish({ view: [404], publish: [503, 503, 503, last] })
    assert.equal(result.status, last === 200 ? 0 : 1, result.stderr)
    assert.equal(result.calls.filter(([command]) => command === "publish").length, 4)
    assert.deepEqual(result.calls.filter(([command]) => command === "sleep"), [["sleep", "10"], ["sleep", "30"], [
      "sleep",
      "60"
    ]])
  }
})
