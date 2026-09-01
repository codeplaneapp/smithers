/**
 * The `smithers claude ...` mirror protocol, contract 2.
 *
 * Two shape changes from 0.x are asserted directly because the plugin pins the
 * contract number on them: `humanRequests` is gone (rc.0 has no question or
 * answer RPC) and `continuedAs` is gone (rc.0 has no `continued` status).
 */
import type { ControlSchema } from "@smthrs/control"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as ClaudeMirror from "../src/ClaudeMirror.ts"
import * as Project from "../src/Project.ts"

const staged: Array<string> = []

const project = (): string => {
  const root = mkdtempSync(join(tmpdir(), "smithers-mirror-"))
  staged.push(root)
  mkdirSync(join(root, ".flows"), { recursive: true })
  return root
}

afterEach(() => {
  while (staged.length > 0) rmSync(staged.pop()!, { recursive: true, force: true })
})

let sequence = 0
const event = (kind: string, payload: unknown): ControlSchema.ControlEvent => ({
  sequence: ++sequence,
  kind,
  runId: "run-1",
  occurredAt: sequence * 1000,
  payload: payload as ControlSchema.ControlEvent["payload"]
})

const run = (status: ControlSchema.RunStatus): ControlSchema.RunSummary => ({
  runId: "run-1",
  flowId: "review",
  status,
  createdAt: 0,
  updatedAt: 1
})

describe("subscriptions", () => {
  it("records and drops one session's interest in a run", () => {
    const root = project()

    expect(ClaudeMirror.subscribe(root, "run-1", "session-a", 1000)).toEqual([
      { runId: "run-1", sessionId: "session-a", updatedAtMs: 1000 }
    ])
    expect(ClaudeMirror.readSubscriptions(root, 1000)).toHaveLength(1)
    expect(ClaudeMirror.unsubscribe(root, "run-1", "session-a", 1000)).toEqual([])
    expect(ClaudeMirror.readSubscriptions(root, 1000)).toEqual([])
  })

  it("re-asserts rather than duplicating, because every tick subscribes", () => {
    const root = project()
    ClaudeMirror.subscribe(root, "run-1", "session-a", 1000)

    const entries = ClaudeMirror.subscribe(root, "run-1", "session-a", 2000)

    expect(entries).toEqual([{ runId: "run-1", sessionId: "session-a", updatedAtMs: 2000 }])
  })

  it("keeps two sessions following one run apart", () => {
    const root = project()
    ClaudeMirror.subscribe(root, "run-1", "session-a", 1000)
    ClaudeMirror.subscribe(root, "run-1", "session-b", 1000)

    expect(ClaudeMirror.readSubscriptions(root, 1000)).toHaveLength(2)
    expect(ClaudeMirror.unsubscribe(root, "run-1", "session-a", 1000)).toEqual([
      { runId: "run-1", sessionId: "session-b", updatedAtMs: 1000 }
    ])
  })

  it("drops an entry older than the day-long window", () => {
    const root = project()
    ClaudeMirror.subscribe(root, "run-1", "session-a", 0)

    expect(ClaudeMirror.subscriptionTtlMs).toBe(24 * 60 * 60 * 1000)
    expect(ClaudeMirror.readSubscriptions(root, ClaudeMirror.subscriptionTtlMs + 1)).toEqual([])
  })

  it("degrades a corrupt or missing registry to silence rather than throwing", () => {
    // The mirror runs on every tick of a plugin the operator did not write; a
    // throw here would break their session over a scratch file.
    const root = project()

    expect(ClaudeMirror.readSubscriptions(root)).toEqual([])
    writeFileSync(ClaudeMirror.subscriptionsPath(root), "{ not json", "utf8")
    expect(ClaudeMirror.readSubscriptions(root)).toEqual([])
    writeFileSync(ClaudeMirror.subscriptionsPath(root), JSON.stringify([{ runId: 1 }, "x", {}]), "utf8")
    expect(ClaudeMirror.readSubscriptions(root)).toEqual([])
  })

  it("keeps the registry beside the project's other run state", () => {
    expect(ClaudeMirror.subscriptionsPath("/work"))
      .toBe(join(Project.stateDirectory("/work"), "claude-mirror-subscriptions.json"))
  })

  it("stays silent when the registry cannot be written", () => {
    // A read-only project directory is an operator's problem, not a reason to
    // fail the frame the plugin is waiting on.
    const root = join(project(), "absent", "deeper")
    expect(() => ClaudeMirror.subscribe(root, "run-1", "session-a", 0)).not.toThrow()
  })
})

describe("one mirror frame", () => {
  const events = [
    event("control.agent.cell-call-started", { flowName: "read", input: {} }),
    event("control.agent.cell-call-settled", { flowName: "read", outcome: "success", value: "contents" }),
    event("control.agent.cell-call-started", { flowName: "bash", input: {} })
  ]

  it("carries the contract number, the run status, and every node", () => {
    const frame = ClaudeMirror.frame("run-1", run("running"), events)

    expect(ClaudeMirror.contract).toBe(2)
    expect(frame.contract).toBe(2)
    expect(frame.status).toBe("running")
    expect(frame.nodes.map((node) => node.nodeId)).toEqual(["read#1", "bash#1"])
    expect(frame.nodes.map((node) => node.state)).toEqual(["finished", "running"])
    expect(frame.phases).toEqual([{ title: "review" }])
    expect(frame.seq).toBe(events.at(-1)!.sequence)
  })

  it("drops the 0.x fields the rc.0 contract has no counterpart for", () => {
    const frame = ClaudeMirror.frame("run-1", run("running"), events)

    expect("humanRequests" in frame).toBe(false)
    expect("continuedAs" in frame).toBe(false)
    expect(ClaudeMirror.terminalStatuses).not.toContain("continued")
  })

  it("reports only the nodes that moved after the cursor, with their output", () => {
    const frame = ClaudeMirror.frame("run-1", run("running"), events, { afterSeq: events[1]!.sequence })

    expect(frame.changed).toEqual(["bash#1"])
    // A node that is still running has produced nothing to carry.
    expect(frame.outputs).toEqual({})
  })

  it("keeps run-wide ordinals when a repeated flow call straddles the cursor", () => {
    const repeated = [
      event("control.agent.cell-call-started", { flowName: "bash", input: { command: "first" } }),
      event("control.agent.cell-call-settled", { flowName: "bash", outcome: "success", value: "first output" }),
      event("control.agent.cell-call-started", { flowName: "bash", input: { command: "second" } }),
      event("control.agent.cell-call-settled", { flowName: "bash", outcome: "success", value: "second output" })
    ]

    const frame = ClaudeMirror.frame("run-1", run("running"), repeated, { afterSeq: repeated[1]!.sequence })

    expect(frame.changed).toEqual(["bash#2"])
    expect(frame.outputs).toEqual({ "bash#2": "second output" })
    expect(frame.outputs["bash#1"]).toBeUndefined()
  })

  it("truncates a long output rather than sending the whole thing", () => {
    const long = [
      event("control.agent.cell-call-started", { flowName: "read", input: {} }),
      event("control.agent.cell-call-settled", { flowName: "read", outcome: "success", value: "x".repeat(50) })
    ]

    const frame = ClaudeMirror.frame("run-1", run("running"), long, { maxOutputChars: 10 })

    expect(frame.outputs["read#1"]).toHaveLength(10)
    expect(frame.outputs["read#1"]?.endsWith("…")).toBe(true)
    expect(ClaudeMirror.defaultMaxOutputChars).toBe(2000)
  })

  it("honors zero and one-character bounds without splitting an astral character", () => {
    const output = (value: string, maxOutputChars: number): string | undefined => {
      const bounded = [
        event("control.agent.cell-call-started", { flowName: "read", input: {} }),
        event("control.agent.cell-call-settled", { flowName: "read", outcome: "success", value })
      ]
      return ClaudeMirror.frame("run-1", run("running"), bounded, { maxOutputChars }).outputs["read#1"]
    }

    expect(output("abc", 0)).toBe("")
    expect(output("abc", 1)).toBe("…")
    expect(output("😀abc", 2)).toBe("😀…")
    expect(Array.from(output("😀abc", 2) ?? "")).toHaveLength(2)
    expect(output("😀abc", 2)?.endsWith("\ud83d")).toBe(false)
  })

  it("carries the pending approval only while the run is parked on one", () => {
    const parked = { question: "May I push?", approval: "{\"target\":{}}" }

    expect(ClaudeMirror.frame("run-1", run("waiting-approval"), events, { parked }).approvals).toEqual([parked])
    expect(ClaudeMirror.frame("run-1", run("running"), events, { parked }).approvals).toEqual([])
    expect(ClaudeMirror.frame("run-1", run("waiting-approval"), events).approvals).toEqual([])
  })

  it("reports a run the control plane does not know as unknown, not as an error", () => {
    const frame = ClaudeMirror.frame("run-1", undefined, [], { timedOut: true })

    expect(frame).toMatchObject({ status: "unknown", nodes: [], seq: 0, timedOut: true, phases: [{ title: "Flow" }] })
  })

  it("knows which statuses end a blocking tick", () => {
    expect(ClaudeMirror.isTerminal("completed")).toBe(true)
    expect(ClaudeMirror.isTerminal("failed")).toBe(true)
    expect(ClaudeMirror.isTerminal("cancelled")).toBe(true)
    expect(ClaudeMirror.isTerminal("waiting-approval")).toBe(false)
    expect(ClaudeMirror.isTerminal("continued")).toBe(false)
  })
})

describe("the monitor stream", () => {
  it("reports notable transitions and drops the rest", () => {
    expect(ClaudeMirror.transition(event("control.run.completed", {})))
      .toMatchObject({ runId: "run-1", kind: "control.run.completed", status: "completed" })
    expect(ClaudeMirror.transition(event("control.approval.requested", {})))
      .toMatchObject({ kind: "control.approval.requested" })
    expect(ClaudeMirror.transition(event("control.approval.requested", {}))?.status).toBeUndefined()
    // A line per model token would be unreadable and would wake the plugin
    // continuously.
    expect(ClaudeMirror.transition(event("control.agent.model-settled", {}))).toBeUndefined()
    expect(ClaudeMirror.notableKinds.has("control.agent.cell-call-started")).toBe(false)
  })

  it("names an event with no run id rather than dropping it", () => {
    const orphan: ControlSchema.ControlEvent = { sequence: 1, kind: "control.run.failed", occurredAt: 0, payload: {} }

    expect(ClaudeMirror.transition(orphan)).toMatchObject({ runId: "", status: "failed" })
  })
})
