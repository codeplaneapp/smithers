import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Card } from "../state/AppState"
import { PROTOTYPE_BANNER, RunTraceBody } from "./RunTraceCard"
import { WorkflowRunCardBody } from "./WorkflowCards"
import { CODING_PLAN } from "./fixtures/CodingPlan"

/*
 * The run trace (factory spec 06, mocks #s5 and #s6): one card shows every
 * run as a trace. A run of kind prototype wears the never-promoted banner,
 * offers `all | messages | failed` and no Steer row; every other run has the
 * shared filters and the steer row while live. The tree nests the journal,
 * the waterfall has one bar per span, the selected span fills the pane with
 * what the journal recorded, and a run with no journal yet is the root alone
 * with the run's status. Filter, selection and cursor are read off the card
 * payload (§5) and every chip, row and bar dispatches a registered hidden
 * flow (§6); the component holds no state of its own.
 */

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

const stamp = (sequence: number, kind: string, payload: Record<string, unknown>, at: number) => ({
  sequence,
  kind,
  occurredAt: at,
  payload: { ...payload, at }
})

const JOURNAL = [
  stamp(1, "control.agent.turn-opened", { seat: "openai:gpt-5.6-sol" }, 1000),
  stamp(2, "control.agent.cell-produced", { language: "ts", text: "const fps = await ctx.call(\"target.run\", { label: \"//apps/ui:e2e-smoke\" })" }, 1200),
  stamp(3, "control.agent.cell-call-started", { flowName: "target.run", input: { label: "//apps/ui:e2e-smoke" } }, 1300),
  stamp(4, "control.agent.cell-call-settled", { flowName: "target.run", outcome: "failure", message: "12 fps at 500 nodes" }, 4300),
  stamp(5, "control.agent.cell-printed", { cell: "c", text: "svg dies at 500 nodes" }, 4400),
  stamp(6, "control.agent.cell-settled", { outcome: "success" }, 4400),
  stamp(7, "control.agent.turn-opened", { seat: "openai:gpt-5.6-sol" }, 5000),
  stamp(8, "control.agent.cell-call-started", { flowName: "agent/send", input: { to: "w6", text: "not rewriting" } }, 5100)
]

const runCard = (
  overrides: Partial<Extract<Card, { kind: "run-trace" }>["payload"]>
): Extract<Card, { kind: "run-trace" }> => ({
  id: "flow-run-run-1",
  kind: "run-trace",
  title: "prototype · graph view of the wiki",
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: {
    repo: "smithersai/smithers",
    runId: "run-1",
    workflow: "prototype",
    phase: "running",
    steps: [],
    result: null,
    lastSeq: 1,
    traceView: "timeline",
    ...overrides
  }
})

const noop = (): void => {}

const render = (element: React.ReactElement): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(element)
  })
  return host
}

const renderRun = (overrides: Partial<Extract<Card, { kind: "run-trace" }>["payload"]>) => {
  const dispatched: Array<{ name: string; args?: string }> = []
  const host = render(
    <WorkflowRunCardBody
      card={runCard(overrides)}
      onStopRun={noop}
      onRetryRun={noop}
      onRunCommand={(name, args) => dispatched.push({ name, args })}
    />
  )
  return { host, dispatched }
}

const renderTrace = (overrides: Partial<Extract<Card, { kind: "run-trace" }>["payload"]>) => {
  const dispatched: Array<{ name: string; args?: string }> = []
  const host = render(<RunTraceBody card={runCard(overrides)} onRunCommand={(name, args) => dispatched.push({ name, args })} />)
  return { host, dispatched }
}

const chips = (host: HTMLElement): Array<string | null> =>
  [...host.querySelectorAll("[data-filter]")].map((chip) => chip.getAttribute("data-filter"))

const click = (element: Element | null): void => {
  flushSync(() => {
    ;(element as HTMLElement).click()
  })
}

describe("the run card as a trace", () => {
  test("an observation refusal keeps the completed verdict and offers the existing keyboard-reachable retry", () => {
    const retried: Array<string> = []
    const host = render(<WorkflowRunCardBody
      card={runCard({ phase: "completed", result: "Finished the implementation.", observationError: "Engine evidence could not be read." })}
      onStopRun={noop} onRetryRun={(id) => retried.push(id)} onRunCommand={noop}
    />)
    expect(host.textContent).toContain("Finished the implementation.")
    expect(host.querySelector("[role='alert']")?.textContent).toContain("Engine evidence could not be read.")
    const retry = host.querySelector("[data-flow='flow.run.retry']") as HTMLButtonElement
    retry.focus()
    expect(document.activeElement).toBe(retry)
    click(retry)
    expect(retried).toEqual(["flow-run-run-1"])
  })
  test("native work uses the same keyboard-focusable selection and reveals results only at their recorded cursor", () => {
    const native = (sequence: number, terminal: boolean) => ({
      sequence, kind: "control.engine.event", occurredAt: 1000 + sequence,
      payload: {
        version: 1, executionId: "native", generation: 0, sequence, eventId: `native/${sequence}`,
        sourceId: "engine", sourceSequence: sequence, emittedAtMs: sequence + 100,
        eventType: "flows.engine.run-decision", meta: { lineageId: "native" },
        payload: {
          decision: terminal ? "transitioned" : "created", ...(terminal ? { status: "completed" } : {}),
          state: { version: 1, flowName: "coding/RunPlan", payload: {}, ...(terminal ? {
            result: { _tag: "Complete", exit: { _tag: "Success", value: { checks: ["typecheck"] } } }
          } : {}) }
        }
      }
    })
    const events = [native(1, false), native(2, true)]
    const compact = renderTrace({ events, traceView: "turns", phase: "completed" })
    const row = compact.host.querySelector("[data-engine-span]") as HTMLButtonElement
    expect(row.tagName).toBe("BUTTON")
    row.focus()
    expect(document.activeElement).toBe(row)
    expect(row.textContent).toContain("coding/RunPlan · completed")
    expect(compact.host.querySelector("[data-testid='run-trace-pane-run-1']")).toBeNull()
    click(row)
    expect(compact.dispatched).toEqual([{ name: "runs.trace.select", args: "run-1 engine:native:0" }])
    const before = renderTrace({ events, traceView: "turns", selection: "engine:native:0", cursorSeq: 1, liveTail: false })
    expect(before.host.querySelector("[data-testid='run-trace-pane-run-1']")?.textContent).not.toContain("typecheck")
    const after = renderTrace({ events, traceView: "turns", selection: "engine:native:0", cursorSeq: 2, liveTail: false })
    expect(after.host.querySelector("[data-testid='run-trace-pane-run-1']")?.textContent).toContain('"checks":["typecheck"]')
    expect(after.host.querySelector("[aria-label='Recorded call path']")?.textContent).toContain("coding/RunPlan")
    expect(after.host.querySelector("[data-flow='runs.open']")).toBeNull()
  })
  test("the default view is a cheap turn list and expands recorded detail only after a persisted selection", () => {
    const { host, dispatched } = renderTrace({ events: JOURNAL, traceView: undefined })
    expect(host.querySelector("[aria-label='Turn explanations']")?.textContent).toContain("Calls: target.run")
    expect(host.querySelector("[aria-label='Call tree']")).toBeNull()
    expect(host.querySelector("[data-testid='run-trace-pane-run-1']")).toBeNull()
    click(host.querySelector("[data-turn='1']"))
    expect(dispatched).toEqual([{ name: "runs.trace.select", args: "run-1 frame-1" }])
    expect(host.querySelector("[aria-label='Call tree']")).toBeNull()

    const selected = renderTrace({ events: JOURNAL, traceView: "turns", selection: "call-1", liveTail: false, cursorSeq: 8 })
    expect([...selected.host.querySelectorAll("[data-trace-span]")].map((row) => row.getAttribute("data-trace-span"))).toEqual(["frame-1", "cell-2", "call-1"])
    expect(selected.host.querySelector("[aria-label='Recorded call path']")?.textContent).toContain("run run-1 · prototype / frame 1")
    expect(selected.host.querySelector("[role='alert']")?.textContent).toBe("12 fps at 500 nodes")
    click(selected.host.querySelector("[data-flow='runs.trace.live']"))
    expect(selected.dispatched).toEqual([{ name: "runs.trace.live", args: "run-1" }])
    expect(selected.host.textContent).toContain("At #8")
  })

  test("a historical cursor hides later output and child navigation until the result was recorded", () => {
    const events = [
      stamp(1, "control.agent.turn-opened", {}, 1),
      stamp(2, "control.agent.cell-call-started", { flowName: "agent/spawn", input: { flow: "review" } }, 2),
      stamp(3, "control.agent.cell-call-settled", { flowName: "agent/spawn", outcome: "success", value: { child: "run-1/child/review" } }, 3)
    ]
    const before = renderTrace({ events, traceView: "turns", selection: "call-1", cursorSeq: 2, liveTail: false })
    expect(before.host.querySelector("[data-flow='runs.open']")).toBeNull()
    expect(before.host.querySelector("[data-testid='run-trace-pane-run-1']")?.textContent).not.toContain("run-1/child/review")
    const after = renderTrace({ events, traceView: "turns", selection: "call-1", cursorSeq: 3, liveTail: false })
    click(after.host.querySelector("[data-flow='runs.open']"))
    expect(after.dispatched).toEqual([{ name: "runs.open", args: "run-1/child/review smithersai/smithers" }])
  })
  test("a run of kind prototype wears the never-promoted banner, offers all | messages | failed, and has no Steer row", () => {
    const { host } = renderRun({ kind: "prototype", events: JOURNAL })
    expect(host.querySelector("[data-testid='run-trace-run-1']")).not.toBeNull()
    expect(host.querySelector("[data-testid='run-trace-banner-run-1']")?.textContent).toContain(PROTOTYPE_BANNER)
    expect(host.querySelector("[data-testid='run-trace-banner-run-1']")?.textContent).toContain("kind: prototype · never promoted")
    expect(chips(host)).toEqual(["all", "messages", "failed"])
    // Spec 06 §3: no Steer for a prototype; the run's other acts stay.
    expect(host.querySelector("[data-testid='flow-run-steer-run-1']")).toBeNull()
    expect(host.querySelector("[data-testid='flow-run-stop-run-1']")).not.toBeNull()
    expect(host.querySelector(".flow-run-card")?.getAttribute("data-run-kind")).toBe("prototype")
    // The secondary tabs stay; there is no Trace tab because the trace is the body.
    expect([...host.querySelectorAll("[role='tablist'] button")].map((tab) => tab.textContent)).toEqual(["Steps", "Transcript"])
  })

  test("every other run is the same trace with the shared filters and the steer row while live; an implement run needs no banner", () => {
    const { host } = renderRun({ workflow: "review", steps: ["1 turn · 2 calls"], events: JOURNAL })
    expect(host.querySelector("[data-testid='run-trace-run-1']")).not.toBeNull()
    expect(host.textContent).toContain("1 turn · 2 calls")
    expect(chips(host)).toEqual(["all", "running", "failed", "model", "flow", "forks"])
    expect(host.querySelector("[data-testid='flow-run-steer-run-1']")).not.toBeNull()
    expect(host.querySelector("[data-testid='run-trace-banner-run-1']")).toBeNull()

    const implement = renderRun({ workflow: "implement", kind: "implement", events: JOURNAL })
    expect(implement.host.querySelector("[data-testid='run-trace-run-1']")).not.toBeNull()
    expect(implement.host.querySelector("[data-testid='run-trace-banner-run-1']")).toBeNull()
    expect(implement.host.querySelector("[data-testid='flow-run-steer-run-1']")).not.toBeNull()
  })

  test("the tree nests the journal, the waterfall has one bar per span, and the payload's selection fills the pane", () => {
    const { host, dispatched } = renderTrace({ kind: "prototype", events: JOURNAL, liveTail: false })
    const nodes = [...host.querySelectorAll("[data-trace-span]")]
    expect(nodes.map((node) => `${node.getAttribute("data-depth")}:${node.getAttribute("data-kind")}:${node.getAttribute("data-status")}`)).toEqual([
      "0:run:running",
      "1:frame:completed",
      "2:cell:completed",
      "3:call:failed",
      "1:frame:running",
      "2:call:running"
    ])
    // One bar per span, none for the run itself; the open call's bar runs to the axis end.
    expect(host.querySelectorAll("[data-trace-bar]")).toHaveLength(5)
    const open = host.querySelector("[data-trace-bar='call-2'] .run-trace-water-bar") as HTMLElement | null
    expect(open?.getAttribute("data-open")).toBe("true")
    expect(open?.style.left).toBe("100%")
    const failed = host.querySelector("[data-trace-bar='call-1'] .run-trace-water-bar") as HTMLElement | null
    // 1300 → 4300 on a 1000 → 5100 axis.
    expect(failed?.style.left).toBe("7.32%")
    expect(failed?.style.width).toBe("73.17%")
    // Spec 06 §7: a bar is a button named by the span summary.
    expect(failed?.tagName).toBe("BUTTON")
    expect(failed?.getAttribute("aria-label")).toBe("target.run · failed · 3.0s")
    expect(host.querySelector("[data-testid='run-trace-clock-run-1']")?.textContent).toBe("5 spans · 2 running · 1 failed · t = 4.1s")

    // With live tail off and nothing selected, the run itself is selected: the pane names it and its kind.
    const pane = () => host.querySelector("[data-testid='run-trace-pane-run-1']")
    expect(pane()?.getAttribute("data-span")).toBe("run:run-1")
    expect(pane()?.textContent).toContain(`${"kind".padEnd(12)}prototype`)

    // A row click and a bar click both dispatch runs.trace.select; nothing changes until the payload does.
    click(host.querySelector("[data-trace-span='call-1']"))
    click(failed)
    expect(dispatched).toEqual([
      { name: "runs.trace.select", args: "run-1 call-1" },
      { name: "runs.trace.select", args: "run-1 call-1" }
    ])
    expect(pane()?.getAttribute("data-span")).toBe("run:run-1")

    const selectedCall = renderTrace({ kind: "prototype", events: JOURNAL, selection: "call-1" })
    const callPane = selectedCall.host.querySelector("[data-testid='run-trace-pane-run-1']")
    expect(callPane?.getAttribute("data-span")).toBe("call-1")
    expect(callPane?.textContent).toContain("call · target.run")
    expect(callPane?.textContent).toContain("//apps/ui:e2e-smoke")
    expect(callPane?.querySelector("[role='alert']")?.textContent).toBe("12 fps at 500 nodes")
    expect(callPane?.textContent).toContain("duration3.0s")
    expect(selectedCall.host.querySelector("[data-trace-span='call-1']")?.getAttribute("aria-selected")).toBe("true")
    expect(selectedCall.host.querySelector("[data-trace-bar='call-1'] .run-trace-water-bar")?.getAttribute("aria-pressed")).toBe("true")

    const selectedCell = renderTrace({ kind: "prototype", events: JOURNAL, selection: "cell-2" })
    const cellPane = selectedCell.host.querySelector("[data-testid='run-trace-pane-run-1']")
    expect(cellPane?.textContent).toContain("Cell")
    expect(cellPane?.textContent).toContain("await ctx.call(\"target.run\"")
    expect(cellPane?.textContent).toContain("Printed")
    expect(cellPane?.textContent).toContain("svg dies at 500 nodes")

    const selectedFrame = renderTrace({ kind: "prototype", events: JOURNAL, selection: "frame-1" })
    const framePane = selectedFrame.host.querySelector("[data-testid='run-trace-pane-run-1']")
    expect(framePane?.textContent).toContain("seatopenai:gpt-5.6-sol")
    expect(framePane?.textContent).toContain("control.agent.turn-opened · #1")
  })

  test("live tail selects the newest frame; a selection the fold no longer holds falls back the same way", () => {
    const tailing = renderTrace({ events: JOURNAL })
    expect(tailing.host.querySelector("[data-testid='run-trace-pane-run-1']")?.getAttribute("data-span")).toBe("frame-2")
    const stale = renderTrace({ events: JOURNAL, selection: "call-99" })
    expect(stale.host.querySelector("[data-testid='run-trace-pane-run-1']")?.getAttribute("data-span")).toBe("frame-2")
    const parked = renderTrace({ events: JOURNAL, selection: "call-99", liveTail: false })
    expect(parked.host.querySelector("[data-testid='run-trace-pane-run-1']")?.getAttribute("data-span")).toBe("run:run-1")
  })

  test("the payload's filter keeps the failing call's ancestors and drops the rest; a chip dispatches runs.trace.filter", () => {
    const { host, dispatched } = renderTrace({ events: JOURNAL, filter: "failed" })
    expect([...host.querySelectorAll("[data-trace-span]")].map((node) => node.getAttribute("data-trace-span"))).toEqual([
      "run:run-1",
      "frame-1",
      "cell-2",
      "call-1"
    ])
    expect(host.querySelector("[data-filter='failed']")?.getAttribute("aria-pressed")).toBe("true")
    click(host.querySelector("[data-filter='all']"))
    expect(dispatched).toEqual([{ name: "runs.trace.filter", args: "run-1 all" }])
    // The click is a request, not a change: the rows stay filtered until the payload says otherwise.
    expect(host.querySelectorAll("[data-trace-span]")).toHaveLength(4)
    expect(renderTrace({ events: JOURNAL }).host.querySelectorAll("[data-trace-span]")).toHaveLength(6)
    // A filter the kind does not offer (a prototype has no `model` chip) renders as `all`, never as an invented chip.
    const prototype = renderTrace({ kind: "prototype", events: JOURNAL, filter: "model" })
    expect(prototype.host.querySelector("[data-filter='all']")?.getAttribute("aria-pressed")).toBe("true")
    expect(prototype.host.querySelectorAll("[data-trace-span]")).toHaveLength(6)
  })

  test("the cursor renders the journal up to that seq, so a scrub shows the run as it stood", () => {
    const { host } = renderTrace({ events: JOURNAL, cursorSeq: 4, liveTail: false })
    expect([...host.querySelectorAll("[data-trace-span]")].map((node) => node.getAttribute("data-trace-span"))).toEqual([
      "run:run-1",
      "frame-1",
      "cell-2",
      "call-1"
    ])
    expect(host.querySelector("[data-trace-span='run:run-1']")?.getAttribute("data-status")).toBe("running")
    expect(host.querySelector("[data-testid='run-trace-clock-run-1']")?.textContent).toBe("3 spans · 2 running · 1 failed · t = 3.3s")
  })

  test("no journal yet is the root alone with the run's status, never an invented span", () => {
    const { host } = renderTrace({ kind: "prototype", phase: "launching" })
    const nodes = [...host.querySelectorAll("[data-trace-span]")]
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.getAttribute("data-status")).toBe("launching")
    expect(host.querySelectorAll("[data-trace-bar]")).toHaveLength(0)
    expect(host.querySelector("[data-testid='run-trace-empty-run-1']")?.textContent).toContain("No journal yet. The run is launching")
    expect(host.querySelector("[data-testid='run-trace-clock-run-1']")?.textContent).toBe("no journal yet")
  })
})


describe("predicted coding Changes in the same run card", () => {
  test("the typed plan appears before any journal, with durable progressive detail and no invented outcomes", () => {
    const initial = renderTrace({ workflow: "coding", input: { plan: CODING_PLAN }, traceView: undefined })
    const outline = initial.host.querySelector("[aria-label='Predicted Changes']")
    expect(outline?.textContent).toContain("Store repository memory")
    expect(outline?.textContent).toContain("Connect the Wiki interface")
    expect(initial.host.querySelector("[aria-label='Predicted atomic changes']")).toBeNull()
    click(initial.host.querySelector("[data-flow='runs.coding.select']"))
    expect(initial.dispatched).toEqual([{ name: "runs.coding.select", args: "run-1 memory" }])
    const selected = renderTrace({ workflow: "coding", input: { plan: CODING_PLAN }, codingChangeId: "memory", cursorSeq: 0, traceView: undefined })
    const details = selected.host.querySelector("[aria-label='Store repository memory']")!
    expect(details.textContent).toContain("✨ feat(memory): persist causal documents")
    expect(details.textContent).toContain("src/memory.test.ts")
    expect(details.textContent).toContain("fast · required")
    expect(details.textContent).toContain("slow · required")
    expect(details.textContent).toContain("wiki-revision-42")
    expect(details.textContent).not.toContain("passed")
    expect(details.textContent).not.toContain("vibed")
    expect(selected.host.querySelector("[aria-label='Turn explanations']")?.children).toHaveLength(0)
  })
  test("missing or invalid input cannot fabricate a coding plan", () => {
    expect(renderTrace({ workflow: "coding" }).host.querySelector("[aria-label='Coding plan']")).toBeNull()
    expect(renderTrace({ input: { plan: { ...CODING_PLAN, changes: [CODING_PLAN.changes[0], CODING_PLAN.changes[0]] } } }).host.querySelector("[aria-label='Coding plan']")).toBeNull()
  })
})
