/*
 * The mirror-sync gate: the workflow that keeps the Smithers Cloud mirror on
 * main pushes to the mirror the Worker actually reads, never forces, never
 * puts the credential in a URL, and skips honestly when the secret is unset.
 *
 * The mirror name is read from the catalog (publicRepoCatalog.ts), never
 * restated here: a catalog rename that leaves the workflow pushing to the old
 * namespace is exactly the drift this file exists to catch.
 */
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { AVAILABLE_REPOS } from "../../src/publicRepoCatalog"

const workflowPath = fileURLToPath(new URL("../../../../.github/workflows/mirror-sync.yml", import.meta.url))
const source = readFileSync(workflowPath, "utf8")

interface Step {
  readonly name?: string
  readonly uses?: string
  readonly run?: string
  readonly if?: unknown
  readonly env?: Record<string, string>
  readonly with?: Record<string, unknown>
}

interface Workflow {
  readonly on: { readonly push?: { readonly branches?: ReadonlyArray<string> }; readonly pull_request?: unknown }
  readonly permissions: Record<string, string>
  readonly concurrency: { readonly group: string; readonly "cancel-in-progress": boolean }
  readonly jobs: Record<string, { readonly if?: unknown; readonly steps: ReadonlyArray<Step> }>
}

const workflow = Bun.YAML.parse(source) as Workflow
const jobs = Object.values(workflow.jobs)
const steps = jobs.flatMap((job) => job.steps)
const push = steps.find((step) => typeof step.run === "string" && step.run.includes("git ") && step.run.includes("push"))

describe("mirror-sync.yml keeps the Cloud mirror on main", () => {
  it("runs on a push to main and on nothing else", () => {
    expect(workflow.on.push?.branches).toEqual(["main"])
    expect(workflow.on.pull_request).toBeUndefined()
    expect(Object.keys(workflow.on)).toEqual(["push"])
  })

  it("holds a read-only token and serializes runs without cancelling one", () => {
    expect(workflow.permissions).toEqual({ contents: "read" })
    expect(workflow.concurrency).toEqual({ group: "mirror-sync", "cancel-in-progress": false })
  })

  it("checks out the full history the push transfers", () => {
    const checkout = steps.find((step) => /^actions\/checkout@/.test(step.uses ?? ""))
    expect(checkout?.with).toEqual({ "fetch-depth": 0 })
  })

  it("pushes HEAD to main of the mirror the Worker serves signed out", () => {
    const smithers = AVAILABLE_REPOS.find((repo) => repo.name === "smithersai/smithers")
    expect(smithers).toBeDefined()
    expect(push).toBeDefined()
    expect(push?.env?.MIRROR_URL).toBe(`https://api.jjhub.tech/${smithers?.cloudRepo}.git`)
    expect(push?.run).toMatch(/push "\$MIRROR_URL" HEAD:refs\/heads\/main/)
  })

  it("never forces and never carries the token in the remote URL", () => {
    expect(push?.run).not.toMatch(/--force|\s-f\s|\+refs\/|force-with-lease/)
    expect(push?.run).not.toMatch(/@api\.jjhub\.tech/)
    expect(push?.env?.SMITHERS_CLOUD_MIRROR_TOKEN).toBe("${{ secrets.SMITHERS_CLOUD_MIRROR_TOKEN }}")
  })

  it("skips with a notice naming the secret when it is unset, and fails a rejected push", () => {
    const run = push?.run ?? ""
    const guard = run.indexOf('[ -z "$SMITHERS_CLOUD_MIRROR_TOKEN" ]')
    const notice = run.indexOf("::notice")
    const exit = run.indexOf("exit 0")
    const command = run.indexOf("git ")
    expect(guard).toBeGreaterThanOrEqual(0)
    expect(notice).toBeGreaterThan(guard)
    expect(run.slice(notice, exit)).toContain("SMITHERS_CLOUD_MIRROR_TOKEN")
    expect(exit).toBeGreaterThan(notice)
    expect(command).toBeGreaterThan(exit)
    // A rejected push must redden the run: no `|| true`, no `continue-on-error`.
    expect(run).not.toContain("|| true")
    expect(source).not.toContain("continue-on-error")
    for (const job of jobs) expect(job.if).toBeUndefined()
    for (const step of steps) expect(step.if).toBeUndefined()
  })
})
