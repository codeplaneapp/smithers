/**
 * The operator loop, run as an operator runs it.
 *
 * Every command here is a real `smithers` process against one real project
 * directory: a scaffolded flow, `.flows/control.db` and `.flows/engine.db` on
 * disk, and the run rows, journal events, and approval tokens those files
 * actually hold. Nothing is stubbed, and no in-process composition stands in
 * for the executable — the rc-contract section 4.1 promises are promises about
 * what the binary does, and a handler-level assertion cannot keep them.
 *
 * The one in-process step is the node approval. Registering an in-run approval
 * is what an executing cell's `ask` does (`AgentSession` calls
 * `ControlRuntime.registerApproval` with the ask envelope), and reaching that
 * state through the agent needs a live model seat. Registering it directly
 * against the same SQLite file leaves the durable state identical, so the
 * `approve` verb still crosses a process boundary to decide a token another
 * process wrote.
 */
import * as ControlRuntime from "@smthrs/control/ControlRuntime"
import { Effect } from "effect"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import * as Detached from "../src/Detached.ts"
import * as NodeControl from "../src/NodeControl.ts"

const executable = fileURLToPath(new URL("../src/bin.ts", import.meta.url))

// Outside the repository: `Project.root` walks up for `.flows/`, and this
// checkout grows one as soon as any command runs in it. Resolved through
// `realpathSync` because the CLI reports the paths it actually opened, and on
// macOS the system temporary directory is a symlink.
const project = realpathSync(mkdtempSync(join(tmpdir(), "smithers-cli-e2e-")))

afterAll(() => rmSync(project, { recursive: true, force: true }))

interface Invocation {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

const smithers = (...args: ReadonlyArray<string>): Invocation => {
  const result = spawnSync(process.execPath, ["--no-warnings", executable, ...args], {
    cwd: project,
    encoding: "utf8",
    timeout: 240_000
  })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

const json = (...args: ReadonlyArray<string>): any => {
  const result = smithers(...args, "--json")
  expect({ args, status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 })
  return JSON.parse(result.stdout)
}

/** The seven statuses rc-contract section 4.1 pins `ps --status` to. */
const statuses = ["accepted", "running", "parked", "waiting-approval", "cancelled", "completed", "failed"]

/**
 * Every case starts real `smithers` processes, and each start parses the whole
 * module graph through Node's type stripping. That is seconds on an idle
 * machine and much longer on a loaded one, so this suite carries its own
 * finite budget rather than the package's 30 s default.
 */
const processBudget = { timeout: 300_000 }

describe("one project, from init to gc", processBudget, () => {
  let runId = ""

  it("scaffolds a project and discovers the flow in it", () => {
    const scaffolded = json("init", "hello")

    expect(scaffolded).toMatchObject({ name: "hello", created: true })
    expect(existsSync(join(project, "flows", "hello", "flow.mdx"))).toBe(true)
    expect(json("ls")).toEqual({ _tag: "flows", items: [{ flowId: "hello", description: expect.any(String) }] })
  })

  it("parks an unapproved plan with the parked exit status", () => {
    const card = json("plan", "hello") as { readonly approval: unknown }
    const approval = JSON.stringify(card.approval)

    const parked = smithers("run", approval, "--json")

    // Exit 3 is the parked status in the rc-contract section 4 table, and it
    // is the one code a caller cannot learn from the payload alone: the run
    // did not fail, it is waiting for a decision.
    expect(parked.status).toBe(3)
    expect(JSON.parse(parked.stdout)).toMatchObject({ _tag: "Parked", status: "waiting-approval" })

    // Approving the same payload launches it, so the park was a gate and not a
    // dead end.
    expect(json("approve", approval, "--scope", "run")).toMatchObject({ _tag: "Accepted" })
    json("down")
  })

  it("launches the discovered flow detached and returns only the receipt's run id", () => {
    const launched = json("up", "hello", "-d")

    // The receipt's own field. rc.0 has no `--run-id`, so this is the only
    // place a caller learns which run it started.
    expect(launched.runId).toMatch(/^run-/)
    expect(launched).toMatchObject({
      detached: true,
      logFile: join(project, ".flows", "logs", `${launched.runId}.log`)
    })
    runId = launched.runId

    // The launch returned because the child proved it persisted the run, not
    // because a timer expired: the admission line names this run.
    const log = readFileSync(launched.logFile, "utf8")
    const nonce = log.split("=run:")[1]?.split(" ")[0] ?? ""
    expect(Detached.admittedRunId(log, nonce)).toBe(runId)
  })

  it("lists the run, filtered by a status from the pinned vocabulary", () => {
    const listed = json("ps")
    const run = listed.items.find((entry: { readonly runId: string }) => entry.runId === runId)

    expect(run).toBeDefined()
    expect(statuses).toContain(run.status)
    expect(run.flowId).toBe("hello")
    expect(json("ps", "--status", run.status).items.map((entry: { readonly runId: string }) => entry.runId))
      .toContain(runId)
    // An eighth status is not a status.
    expect(smithers("ps", "--status", "sleeping").status).toBe(2)
  })

  it("streams the run's own control events", () => {
    const events = json("logs", runId)

    expect(events.map((event: { readonly kind: string }) => event.kind)).toContain("control.run.accepted")
    expect(new Set(events.map((event: { readonly runId: string }) => event.runId))).toEqual(new Set([runId]))
  })

  it("delivers two different signals rather than replaying the first one's receipt", () => {
    const first = json("signal", runId, JSON.stringify({ name: "go", payload: { attempt: 1 } }))
    const replay = json("signal", runId, JSON.stringify({ name: "go", payload: { attempt: 1 } }))
    const second = json("signal", runId, JSON.stringify({ name: "go", payload: { attempt: 2 } }))

    expect(first.receiptId).toMatch(new RegExp(`^cli:signal:${runId}:`))
    // Identical payload, identical mutation: the receipt is replayed.
    expect(replay.receiptId).toBe(first.receiptId)
    // A different payload is a different mutation, and keying on the run alone
    // silently dropped it (rc-contract section 5.1).
    expect(second.receiptId).not.toBe(first.receiptId)
  })

  it("decides an in-run approval another process registered", async () => {
    const engine = NodeControl.engineDurable(project)
    const target = {
      _tag: "Node" as const,
      runId,
      requestId: `${runId}:ask-1`,
      digest: "e2e-ask-digest",
      envelope: { capabilities: [], flows: ["ask"], budget: {} }
    }

    const registered = await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime.ControlRuntime
        return yield* runtime.registerApproval(target)
      }).pipe(Effect.provide(engine.runtime), Effect.scoped, Effect.orDie)
    )
    expect(registered.resolved).toBe(false)

    const decided = json(
      "approve",
      JSON.stringify({ target, scope: "run", idempotencyKey: `approve:${target.requestId}` })
    )
    expect(decided).toMatchObject({ _tag: "Accepted" })

    const readBack = await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime.ControlRuntime
        return yield* runtime.registerApproval(target)
      }).pipe(Effect.provide(engine.runtime), Effect.scoped, Effect.orDie)
    )
    // The decision is durable and cross-process: a resumed attempt reads it
    // instead of parking again.
    expect(readBack.resolved).toBe(true)
  })

  it("keeps namespaced memory in the control database across processes", () => {
    expect(json("memory", "set", "reviewer", "sol")).toMatchObject({ key: "reviewer", written: true })
    expect(json("memory", "get", "reviewer")).toBe("sol")
    expect(json("memory", "list").map((entry: { readonly key: string }) => entry.key)).toContain("reviewer")

    expect(json("memory", "rm", "reviewer")).toMatchObject({ key: "reviewer", removed: true })
    expect(json("memory", "list").map((entry: { readonly key: string }) => entry.key)).not.toContain("reviewer")
  })

  it("queues a steer for the run to drain at its turn close", () => {
    json("steer", runId, "--message", "prefer the smaller change")

    const run = json("ps").items.find((entry: { readonly runId: string }) => entry.runId === runId)
    // Durable and attributed: the message is on the notification queue, not in
    // the sending process, so a later `ps` from any process reports it.
    expect(run.steering.pending).toBeGreaterThan(0)
  })

  it("says a run recorded no node output rather than inventing one", () => {
    const result = smithers("output", runId, "result")

    // A node id the run does not have is the argument being wrong, so this is
    // the usage status, and the message names the run rather than printing an
    // empty document to stdout.
    expect(result.status).toBe(2)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain(runId)
  })

  it("reports the project it resolved, both databases, and the Node floor", () => {
    const report = smithers("doctor")

    expect(report.status).toBe(0)
    expect(report.stdout).toContain(project)
    expect(report.stdout).toContain(join(project, ".flows", "control.db"))
    expect(report.stdout).toContain(join(project, ".flows", "engine.db"))
    expect(report.stdout).toContain("node:")
  })

  it("cancels the run durably", () => {
    expect(json("cancel", runId)).toMatchObject({ _tag: "Terminal", runId, status: "cancelled" })
    expect(json("ps").items.find((entry: { readonly runId: string }) => entry.runId === runId).status)
      .toBe("cancelled")
  })

  it("takes every remaining run down", () => {
    const launched = json("up", "hello", "-d")
    expect(json("ps").items.some((entry: { readonly status: string }) => entry.status !== "cancelled")).toBe(true)

    json("down")

    // `down` is `Control.list` then `cancel`, so a second one is a no-op
    // rather than an error on runs that are already terminal.
    const after = json("ps").items as ReadonlyArray<{ readonly runId: string; readonly status: string }>
    expect(after.find((entry) => entry.runId === launched.runId)!.status).toBe("cancelled")
    expect(after.every((entry) => entry.status === "cancelled")).toBe(true)
    json("down")
  })

  it("reports what gc would delete, then deletes it", () => {
    const planned = json("gc", "--older-than", "0s", "--dry-run")

    expect(planned.dryRun).toBe(true)
    expect(planned.reports.map((report: { readonly database: string }) => report.database)).toEqual([
      join(project, ".flows", "control.db"),
      join(project, ".flows", "engine.db")
    ])
    const control = planned.reports[0]
    expect(control.runs).toContain(runId)
    // A dry run deletes nothing, which is the whole point of the flag.
    expect(json("ps").items.map((entry: { readonly runId: string }) => entry.runId)).toContain(runId)

    json("gc", "--older-than", "0s")
    expect(json("ps").items).toEqual([])
  })
})
