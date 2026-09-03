import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
  evaluateExpression,
  interpolate,
  localEquivalents,
  parseWorkflow,
  stripComment
} from "./release-rehearsal.mjs"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const release = parseWorkflow(
  readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8")
)

/** The contexts the runner would build for a tag push. */
const pushContexts = (tag) => ({
  github: { event_name: "push", ref_name: tag },
  inputs: {},
  runner: { temp: "/tmp/runner" },
  env: {}
})

/** The contexts the runner would build for a dispatched run. */
const dispatchContexts = (tag, dryRun) => ({
  github: { event_name: "workflow_dispatch", ref_name: "main" },
  inputs: { releaseTag: tag, dryRun },
  runner: { temp: "/tmp/runner" },
  env: {}
})

const jobEnv = (contexts) =>
  Object.fromEntries(
    Object.entries(release.jobs.publish.env).map(([key, value]) => [key, interpolate(value, contexts)])
  )

const step = (name) => release.jobs.publish.steps.find((candidate) => candidate.name === name)

const condition = (source, contexts) =>
  evaluateExpression(String(source).replaceAll(/\$\{\{|\}\}/g, ""), contexts)

test("parseWorkflow reads mappings, sequences, block scalars, and comments", () => {
  const parsed = parseWorkflow([
    "name: Example",
    "# a comment",
    "on:",
    "  push:",
    "    tags:",
    '      - "v*"',
    "jobs:",
    "  publish:",
    "    env:",
    "      TAG: ${{ github.ref_name }}",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - name: Two lines",
    "        if: env.DRY_RUN != 'true'",
    "        run: |",
    "          echo one  # not a yaml comment",
    "",
    "          echo two",
    ""
  ].join("\n"))

  assert.equal(parsed.name, "Example")
  assert.deepEqual(parsed.on.push.tags, ["v*"])
  assert.equal(parsed.jobs.publish.env.TAG, "${{ github.ref_name }}")
  assert.deepEqual(parsed.jobs.publish.steps[0], { uses: "actions/checkout@v4" })
  assert.equal(parsed.jobs.publish.steps[1].if, "env.DRY_RUN != 'true'")
  assert.equal(parsed.jobs.publish.steps[1].run, "echo one  # not a yaml comment\n\necho two\n")
})

test("parseWorkflow reads scalar flow sequences and rejects unsupported flow collections", () => {
  const parsed = parseWorkflow("on:\n  push:\n    branches: [main, 'release/*']\n")
  assert.deepEqual(parsed.on.push.branches, ["main", "release/*"])
  assert.throws(
    () => parseWorkflow("on:\n  push:\n    branches: [[main]]\n"),
    /nested flow collections are unsupported/
  )
})

test("parseWorkflow fails closed on duplicate keys and unconsumed syntax", () => {
  assert.throws(() => parseWorkflow("name: one\nname: two\n"), /duplicate mapping key: name/)
  assert.throws(() => parseWorkflow("name: one\nunsupported syntax\njobs: {}\n"), /unsupported workflow syntax at line 2/)
})

test("stripComment leaves a hash inside quotes alone", () => {
  assert.equal(stripComment("value # trailing"), "value")
  assert.equal(stripComment("\"a # b\" # trailing"), "\"a # b\"")
  assert.equal(stripComment("no-comment"), "no-comment")
})

test("evaluateExpression implements the GitHub operator subset", () => {
  const contexts = { env: { DRY_RUN: "true" }, inputs: { dryRun: false, tag: "" } }
  assert.equal(evaluateExpression("env.DRY_RUN == 'true'", contexts), true)
  assert.equal(evaluateExpression("env.DRY_RUN != 'true'", contexts), false)
  assert.equal(evaluateExpression("!(env.DRY_RUN == 'true')", contexts), false)
  assert.equal(evaluateExpression("inputs.tag != '' && inputs.tag || 'fallback'", contexts), "fallback")
  assert.equal(evaluateExpression("inputs.missing", contexts), undefined)
  assert.throws(() => evaluateExpression("env.DRY_RUN =~ 'x'", contexts), /unsupported expression/)
})

test("a tag push resolves the pushed tag and never enters the dry-run path", () => {
  const contexts = pushContexts("v0.1.0-next.0")
  const env = jobEnv(contexts)

  assert.equal(env.RELEASE_TAG, "v0.1.0-next.0")
  assert.equal(env.DRY_RUN, "false")
  contexts.env = env
  assert.equal(condition(step("Publish packages in dependency order").if, contexts), true)
  assert.equal(condition(step("Report the skipped publication").if, contexts), false)
})

test("a dispatched dry run validates the given tag and skips publication", () => {
  const contexts = dispatchContexts("v0.1.0-next.0-rc", true)
  const env = jobEnv(contexts)

  assert.equal(env.RELEASE_TAG, "v0.1.0-next.0-rc")
  assert.equal(env.DRY_RUN, "true")
  contexts.env = env
  assert.equal(condition(step("Publish packages in dependency order").if, contexts), false)
  assert.equal(condition(step("Report the skipped publication").if, contexts), true)
})

test("a dispatched run with dryRun off publishes, and an empty tag input falls back to the ref", () => {
  const contexts = dispatchContexts("", false)
  const env = jobEnv(contexts)

  assert.equal(env.RELEASE_TAG, "main")
  assert.equal(env.DRY_RUN, "false")
  contexts.env = env
  assert.equal(condition(step("Publish packages in dependency order").if, contexts), true)
})

test("runner temporary paths stay at step scope, where GitHub permits the runner context", () => {
  assert.equal(release.jobs.publish.env.PACK_DIR, undefined)
  assert.equal(release.jobs.publish.env.PUBLISH_ORDER, undefined)
  assert.equal(step("Pack and smoke-test release artifacts").env.PACK_DIR, "${{ runner.temp }}/release-packs")
  assert.equal(step("Compute the publish plan").env.PUBLISH_ORDER, "${{ runner.temp }}/publish-order.txt")
  assert.equal(step("Publish packages in dependency order").env.PACK_DIR, "${{ runner.temp }}/release-packs")
  assert.equal(step("Report the skipped publication").env.PUBLISH_ORDER, "${{ runner.temp }}/publish-order.txt")
})

test("every gate runs on both paths; only publication is conditional", () => {
  const conditional = release.jobs.publish.steps
    .filter((candidate) => candidate.if !== undefined)
    .map((candidate) => candidate.name)

  assert.deepEqual(conditional, [
    "Publish packages in dependency order",
    "Report the skipped publication"
  ])
})

test("the driver reads the toolchain steps copied out of ci.yml", () => {
  // The copied blocks are the first shapes in this file that pair a `|` block
  // scalar with a later `shell:` key, and the first `with:` maps the driver
  // has to read on a step it does not execute. A reader that mis-parsed one
  // would report the release as green while skipping a step.
  const containerd = step("Enable the containerd image store")
  assert.equal(containerd.shell, "bash")
  assert.match(containerd.run, /^if command -v docker /)
  const systemPackages = step("Install system packages")
  assert.equal(systemPackages.shell, "bash")
  assert.match(systemPackages.run, /--no-install-recommends 'bubblewrap'/)
  assert.equal(step("Install ripgrep").with.tool, "ripgrep@14.1.1")
  assert.equal(step("Install Go").with["go-version"], "1.26.0")
  assert.equal(step("Install Foundry").with.version, "v1.8.1")
})

test("the toolchain the gates need is installed before the first gate", () => {
  const names = release.jobs.publish.steps.map((candidate) => candidate.name ?? candidate.uses)
  const firstGate = names.indexOf("Workspace targets")
  assert.notEqual(firstGate, -1, "release.yml no longer runs the workspace target graph")
  for (const name of ["Install Go", "Install Foundry", "Install ripgrep", "Install system packages"]) {
    const index = names.indexOf(name)
    assert.notEqual(index, -1, `release.yml does not install ${name.replace("Install ", "")}`)
    assert.ok(index < firstGate, `${name} must run before the first gate`)
  }
  // actions/setup-go prepends its own bin directories to PATH and displaces
  // the shim corepack put there, which killed every nested `pnpm` the build
  // tool spawned. The package manager's setup therefore has to come after it,
  // which is the order GithubCiGen renders and this file copies.
  assert.ok(names.indexOf("Install Go") < names.indexOf("pnpm/action-setup@v6"))
})

test("the rehearsal driver documents a local equivalent for every action the release uses", () => {
  const undocumented = release.jobs.publish.steps
    .filter((candidate) => candidate.uses !== undefined)
    .map((candidate) => candidate.uses.split("@")[0])
    .filter((action) => !(action in localEquivalents))

  assert.deepEqual(undocumented, [])
})

test("the dispatch inputs keep the rehearsal safe by default", () => {
  const inputs = release.on.workflow_dispatch.inputs
  assert.equal(inputs.dryRun.type, "boolean")
  assert.equal(inputs.dryRun.default, true)
  assert.equal(inputs.releaseTag.default, "")
})
