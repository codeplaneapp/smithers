import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Card } from "../state/AppState"
import { PROTOTYPE_BANNER, RunTraceBody } from "./RunTraceCard"
import { WorkflowRunCardBody } from "./WorkflowCards"

/*
 * The run card's trace facet (design session §6b, mocks 7 and 8): a run of
 * kind prototype opens on the trace and wears the never-promoted banner, every
 * other run opens on its steps and reaches the trace through the Trace tab
 * (the runs.trace flow); the tree nests the journal, the waterfall has one bar
 * per span, selecting a span fills the pane with what the journal recorded,
 * and a run with no journal yet is the root alone with the run's status.
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
  overrides: Partial<Extract<Card, { kind: "flow-run" }>["payload"]>
): Extract<Card, { kind: "flow-run" }> => ({
  id: "flow-run-run-1",
  kind: "flow-run",
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
    ...overrides
  }
})

const render = (element: React.ReactElement): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(element)
  })
  return host
}

const renderRun = (overrides: Partial<Extract<Card, { kind: "flow-run" }>["payload"]>) => {
  const dispatched: Array<{ name: string; args?: string }> = []
  const host = render(
    <WorkflowRunCardBody
      card={runCard(overrides)}
      onStopRun={() => {}}
      onRetryRun={() => {}}
      onRunCommand={(name, args) => dispatched.push({ name, args })}
    />
  )
  return { host, dispatched }
}

const click = (element: Element | null): void => {
  flushSync(() => {
    ;(element as HTMLElement).click()
  })
}

describe("the run card and its trace facet", () => {
  test("a run of kind prototype opens on the trace, Trace tab first, wearing the never-promoted banner", () => {
    const { host } = renderRun({ kind: "prototype", events: JOURNAL })
    expect(host.querySelector("[data-testid='run-trace-run-1']")).not.toBeNull()
    expect(host.querySelector("[data-testid='run-trace-banner-run-1']")?.textContent).toContain(PROTOTYPE_BANNER)
    expect(host.querySelector("[data-testid='run-trace-banner-run-1']")?.textContent).toContain("kind: prototype · never promoted")
    const tabs = [...host.querySelectorAll("[role='tablist'] button")].map((tab) => tab.textContent)
    expect(tabs).toEqual(["Trace", "Steps", "Transcript"])
    expect(host.querySelector(".flow-run-card")?.getAttribute("data-run-kind")).toBe("prototype")
  })

  test("every other run opens on its steps; the Trace tab dispatches runs.trace and an implement run needs no banner", () => {
    const { host, dispatched } = renderRun({ workflow: "review", steps: ["1 turn · 2 calls"] })
    expect(host.querySelector("[data-testid='run-trace-run-1']")).toBeNull()
    expect(host.textContent).toContain("1 turn · 2 calls")
    expect([...host.querySelectorAll("[role='tablist'] button")].map((tab) => tab.textContent)).toEqual(["Steps", "Transcript", "Trace"])
    click(host.querySelector("[data-testid='flow-run-facet-trace-run-1']"))
    expect(dispatched).toEqual([{ name: "runs.trace", args: "run-1" }])

    const implement = renderRun({ workflow: "implement", kind: "implement", events: JOURNAL })
    expect(implement.host.querySelector("[data-testid='run-trace-run-1']")).not.toBeNull()
    expect(implement.host.querySelector("[data-testid='run-trace-banner-run-1']")).toBeNull()
  })

  test("the tree nests the journal, the waterfall has one bar per span, and the selected span fills the pane", () => {
    const host = render(<RunTraceBody card={runCard({ kind: "prototype", facet: "trace", events: JOURNAL })} />)
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
    expect(host.querySelector("[data-testid='run-trace-clock-run-1']")?.textContent).toBe("5 spans · 2 running · 1 failed · t = 4.1s")

    // The run is selected until a span is: the pane names it and its kind.
    const pane = () => host.querySelector("[data-testid='run-trace-pane-run-1']")
    expect(pane()?.getAttribute("data-span")).toBe("run:run-1")
    expect(pane()?.textContent).toContain(`${"kind".padEnd(12)}prototype`)

    click(host.querySelector("[data-trace-span='call-1']"))
    expect(pane()?.getAttribute("data-span")).toBe("call-1")
    expect(pane()?.textContent).toContain("call · target.run")
    expect(pane()?.textContent).toContain("//apps/ui:e2e-smoke")
    expect(pane()?.querySelector("[role='alert']")?.textContent).toBe("12 fps at 500 nodes")
    expect(pane()?.textContent).toContain("duration3.0s")

    click(host.querySelector("[data-trace-span='cell-2']"))
    expect(pane()?.textContent).toContain("Cell")
    expect(pane()?.textContent).toContain("await ctx.call(\"target.run\"")
    expect(pane()?.textContent).toContain("Printed")
    expect(pane()?.textContent).toContain("svg dies at 500 nodes")

    click(host.querySelector("[data-trace-span='frame-1']"))
    expect(pane()?.textContent).toContain("seatopenai:gpt-5.6-sol")
    expect(pane()?.textContent).toContain("control.agent.turn-opened · #1")
  })

  test("the failed filter keeps the failing call's ancestors and drops the rest", () => {
    const host = render(<RunTraceBody card={runCard({ facet: "trace", events: JOURNAL })} />)
    click(host.querySelector("[data-filter='failed']"))
    expect([...host.querySelectorAll("[data-trace-span]")].map((node) => node.getAttribute("data-trace-span"))).toEqual([
      "run:run-1",
      "frame-1",
      "cell-2",
      "call-1"
    ])
    expect(host.querySelector("[data-filter='failed']")?.getAttribute("aria-pressed")).toBe("true")
    click(host.querySelector("[data-filter='all']"))
    expect(host.querySelectorAll("[data-trace-span]")).toHaveLength(6)
  })

  test("no journal yet is the root alone with the run's status, never an invented span", () => {
    const host = render(<RunTraceBody card={runCard({ kind: "prototype", facet: "trace", phase: "launching" })} />)
    const nodes = [...host.querySelectorAll("[data-trace-span]")]
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.getAttribute("data-status")).toBe("launching")
    expect(host.querySelectorAll("[data-trace-bar]")).toHaveLength(0)
    expect(host.querySelector("[data-testid='run-trace-empty-run-1']")?.textContent).toContain("No journal yet. The run is launching")
    expect(host.querySelector("[data-testid='run-trace-clock-run-1']")?.textContent).toBe("no journal yet")
  })
})
