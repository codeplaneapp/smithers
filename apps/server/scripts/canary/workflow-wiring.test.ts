/*
 * The wiring gate: every canary probe is invoked by a workflow, and every
 * workflow is linted.
 *
 * The probes in this directory shipped with unit tests and with nothing in
 * .github/workflows/ that ran any of them. A probe nobody invokes cannot grade
 * a deployment, and its unit tests stay green while it does so. These
 * assertions fail the moment a probe is added without a caller, a caller is
 * deleted, or a workflow file is added outside the actionlint argument list.
 *
 * The probe list is derived from the directory, never restated here. A
 * hardcoded list is the defect this file exists to prevent: it would keep
 * passing after someone adds probe six.
 */
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const canaryDir = fileURLToPath(new URL(".", import.meta.url))
const workflowsDir = fileURLToPath(new URL("../../../../.github/workflows/", import.meta.url))

const readWorkflow = (name: string): string => readFileSync(`${workflowsDir}${name}`, "utf8")

const workflowNames = readdirSync(workflowsDir).filter((name) => name.endsWith(".yml")).sort()

/*
 * An entry point reads process.argv; a library does not. That is the same
 * split the files themselves document — BuildStamp.ts, workers-manifest.ts,
 * invite-verdict.ts and rollback-verdict.ts hold verdicts, and the *-probe.ts
 * shells hold the process.
 */
const entryPoints = readdirSync(canaryDir)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .filter((name) => readFileSync(`${canaryDir}${name}`, "utf8").includes("process.argv"))
  .sort()

describe("canary probes are wired into a gate", () => {
  it("finds the probe entry points", () => {
    // A guard on the guard: an import rename that empties this list would
    // make every assertion below vacuous.
    expect(entryPoints.length).toBeGreaterThanOrEqual(5)
    expect(entryPoints).toContain("build-probe.ts")
    expect(entryPoints).toContain("workers-health.ts")
    expect(entryPoints).toContain("uptime-probe.ts")
    expect(entryPoints).toContain("invite-probe.ts")
    expect(entryPoints).toContain("rollback-probe.ts")
  })

  it("invokes every probe entry point from at least one workflow", () => {
    const workflows = workflowNames.map((name) => ({ name, text: readWorkflow(name) }))
    const unwired = entryPoints.filter(
      (probe) => !workflows.some((workflow) => workflow.text.includes(`scripts/canary/${probe}`))
    )
    expect(unwired).toEqual([])
  })

  it("runs CN-1 against the sha the deploy just published", () => {
    // Without an expected sha the probe skips its comparison checks and
    // still prints PASS, having verified only that the deployment can state
    // what it is. The sha has to reach the probe for the verdict to move.
    const deploy = readWorkflow("apps-deploy.yml")
    expect(deploy).toContain("scripts/canary/build-probe.ts")
    expect(deploy).toMatch(/--sha\s/)
    expect(deploy).toContain("github.sha")
    // Drift needs both halves: the flag, and a checkout deep enough for
    // `git rev-list <sha>..origin/main` to resolve origin/main.
    expect(deploy).toMatch(/--max-drift\s+\d/)
    expect(deploy).toMatch(/^\s*fetch-depth: 0$/m)
  })

  it("reports every post-deploy probe in one run", () => {
    /*
     * GitHub's default step condition is "every previous step succeeded",
     * so without `!cancelled()` a red CN-1 skips CN-18, CN-23 and CN-24 and
     * the operator learns one verdict per production deploy. The step list
     * is derived from the file, so a probe step added without the condition
     * fails here rather than being silently masked in the next incident.
     */
    const steps = readWorkflow("apps-deploy.yml")
      .split(/\n(?=\t{0,0} {6}- )/)
      .filter((block) => block.includes("scripts/canary/") && block.includes("bun scripts/canary/"))
    expect(steps.length).toBeGreaterThanOrEqual(4)
    const masked = steps
      .filter((block) => !block.includes("!cancelled()"))
      .map((block) => (/- name: (.*)/.exec(block) ?? [, block.slice(0, 40)])[1])
    expect(masked).toEqual([])
  })

  it("lints every workflow file in ci.yml's actionlint step", () => {
    const ci = readWorkflow("ci.yml")
    const args = ci.split("\n").find((line) => line.trim().startsWith("args:"))
    expect(args).toBeDefined()
    const unlinted = workflowNames.filter((name) => !(args as string).includes(`.github/workflows/${name}`))
    expect(unlinted).toEqual([])
  })

  it("keeps ci.yml free of step conditions (issue #176)", () => {
    // packages/flows/test/vitestCoverageIsolation.test.ts owns this pin.
    // It is restated here because the apps workspaces run `bun test` and
    // never load that suite, and this file edits ci.yml.
    expect(readWorkflow("ci.yml")).not.toMatch(/^\s*if:/m)
  })
})
