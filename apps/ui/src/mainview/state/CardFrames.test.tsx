import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { Card } from "smithers-shared/Cards"
import type { AgentTurnFrame } from "smithers-shared/NativeAgent"
import { CardView } from "../ChatCards"
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge"
import { createAppController } from "./AppController"
import { createAppStore } from "./AppStore"

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "Local repositories can only be connected from the Smithers native app."
  })
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

/** An agent that replays a fixed server-emitted frame stream for each turn. */
const scriptedAgent = (frames: ReadonlyArray<AgentTurnFrame>): NativeAgent => {
  const listeners = new Set<(frame: AgentTurnFrame) => void>()
  return {
    available: true,
    startTurn: async (request) => {
      queueMicrotask(() => {
        for (const frame of frames) {
          for (const listener of listeners) listener({ ...frame, runId: request.runId })
        }
      })
      return { status: "started" }
    },
    cancelTurn: async () => {},
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

const planCard: Card = {
  id: "card-plan",
  kind: "plan",
  title: "Ship the MVP",
  status: "active",
  createdAt: 1,
  ordinal: 1,
  payload: {
    items: [
      { id: "item-1", title: "Wave 1 skeleton", status: "active" },
      { id: "item-2", title: "Wave 2 flows", status: "pending" }
    ]
  }
}

const approvalCard: Card = {
  id: "card-approval",
  kind: "approval",
  title: "Deploy to production",
  status: "active",
  createdAt: 2,
  ordinal: 2,
  payload: { capability: "deploy:production", detail: "wrangler deploy" }
}

const statusCard: Card = {
  id: "card-status",
  kind: "status",
  title: "Analyzing repository",
  status: "active",
  createdAt: 3,
  ordinal: 3,
  payload: { progress: 0.5, note: "Halfway there" }
}

const balanceCard: Card = {
  id: "billing-balance",
  kind: "balance",
  title: "Balance",
  status: "active",
  createdAt: 4,
  ordinal: 4,
  payload: {
    totalUsd: "500",
    state: "ok",
    allowedToStartWork: true,
    lifetimeChargedUsd: "0",
    chargeCount: 0,
    introUsd: "500"
  }
}

describe("server-emitted card frames", () => {
  test("land in the store as plan, approval, and status cards", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(
      store,
      unavailableRepositories,
      scriptedAgent([
        { runId: "turn", type: "card", card: planCard },
        { runId: "turn", type: "card", card: approvalCard },
        { runId: "turn", type: "card", card: statusCard },
        { runId: "turn", type: "card.update", id: "card-status", patch: { payload: { progress: 1 } } },
        { runId: "turn", type: "delta", kind: "text", text: "Cards are live." },
        { runId: "turn", type: "done" }
      ])
    )

    controller.send("show me the state of things")
    await settled()

    const cards = [...store.collections.cards.values()].sort(
      (left, right) => left.ordinal - right.ordinal
    )
    expect(cards.map((card) => card.kind)).toEqual(["plan", "approval", "status"])
    const status = cards.find((card) => card.id === "card-status")
    expect(status?.kind === "status" ? status.payload.progress : undefined).toBe(1)

    const upserts = [...store.collections.transitions.values()].filter(
      (record) => record.type === "card.upsert"
    )
    expect(upserts).toHaveLength(3)
    expect(upserts.every((record) => record.actor === "smithers")).toBe(true)
  })

  test("render as PlanCard, ApprovalCard, and StatusCard with zero UI change", () => {
    const cardViewHandlers = {
      maximized: false,
      onDecideApproval: () => {},
      onRecoAction: () => {},
      onGrantConfirm: () => {},
      onGrantCancel: () => {},
      onQueueApprove: () => {},
      onRepoToggle: () => {},
      onReposSelectAll: () => {},
      onReposSelectNone: () => {},
      onReposConfirm: () => {},
      onMaximize: () => {},
      onMinimize: () => {},
      onOpenInTab: () => {},
      onConnectGitHub: () => {},
      onConnectLocal: () => {},
      onRunWorkflow: () => {},
      onStopRun: () => {},
      onRetryRun: () => {},
      onChooseWorkflowRepo: () => {},
      worldDocuments: [],
      onChangeWorldDocument: () => {},
      onRunCommand: () => {}
    }
    const planMarkup = renderToStaticMarkup(<CardView card={planCard} {...cardViewHandlers} />)
    expect(planMarkup).toContain("data-kind=\"plan\"")
    expect(planMarkup).toContain("Wave 1 skeleton")

    const approvalMarkup = renderToStaticMarkup(
      <CardView card={approvalCard} {...cardViewHandlers} />
    )
    expect(approvalMarkup).toContain("data-kind=\"approval\"")
    expect(approvalMarkup).toContain("deploy:production")

    const statusMarkup = renderToStaticMarkup(
      <CardView card={statusCard} {...cardViewHandlers} />
    )
    expect(statusMarkup).toContain("data-kind=\"status\"")
    expect(statusMarkup).toContain("Halfway there")
  })

  test("an approval card frame carries the run identity the decision round-trips against", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const linkedApproval: Card = {
      ...approvalCard,
      payload: {
        capability: "deploy:production",
        runId: "run_01",
        nodeId: "approve",
        iteration: 0
      }
    }
    const controller = createAppController(
      store,
      unavailableRepositories,
      scriptedAgent([
        { runId: "turn", type: "card", card: linkedApproval },
        { runId: "turn", type: "delta", kind: "text", text: "Decision needed." },
        { runId: "turn", type: "done" }
      ])
    )
    controller.send("deploy it")
    await settled()
    const card = store.collections.cards.get("card-approval")
    expect(card?.kind).toBe("approval")
    if (card?.kind === "approval") {
      expect(card.payload.runId).toBe("run_01")
      expect(card.payload.nodeId).toBe("approve")
      expect(card.payload.iteration).toBe(0)
    }
  })

  test("the balance card renders dollars and the one-time first-run line", () => {
    const cardViewHandlers = {
      maximized: false,
      onDecideApproval: () => {},
      onRecoAction: () => {},
      onGrantConfirm: () => {},
      onGrantCancel: () => {},
      onQueueApprove: () => {},
      onRepoToggle: () => {},
      onReposSelectAll: () => {},
      onReposSelectNone: () => {},
      onReposConfirm: () => {},
      onMaximize: () => {},
      onMinimize: () => {},
      onOpenInTab: () => {},
      onConnectGitHub: () => {},
      onConnectLocal: () => {},
      onRunWorkflow: () => {},
      onStopRun: () => {},
      onRetryRun: () => {},
      onChooseWorkflowRepo: () => {},
      worldDocuments: [],
      onChangeWorldDocument: () => {},
      onRunCommand: () => {}
    }
    const markup = renderToStaticMarkup(<CardView card={balanceCard} {...cardViewHandlers} />)
    expect(markup).toContain("data-kind=\"balance\"")
    expect(markup).toContain("You have $500 of usage on us.")
    expect(markup).toContain("$500 left.")
    // Never a card form, never a credit abstraction.
    expect(markup).not.toContain("credit card")
    expect(markup).not.toContain("credits")
  })

  test("a quiet or stopped run card never wears a Running pill (wave 12 §3, review)", () => {
    /*
     * Review pass: §3's two new phases fell through to the `running` pill, so
     * a card whose body read "This run has gone quiet — … I stopped checking"
     * still glanced as **Running**. The pill is the most-read claim on a card;
     * "Running" is exactly what neither state can vouch for.
     */
    const cardViewHandlers = {
      maximized: false,
      onDecideApproval: () => {},
      onRecoAction: () => {},
      onGrantConfirm: () => {},
      onGrantCancel: () => {},
      onQueueApprove: () => {},
      onRepoToggle: () => {},
      onReposSelectAll: () => {},
      onReposSelectNone: () => {},
      onReposConfirm: () => {},
      onMaximize: () => {},
      onMinimize: () => {},
      onOpenInTab: () => {},
      onConnectGitHub: () => {},
      onConnectLocal: () => {},
      onRunWorkflow: () => {},
      onStopRun: () => {},
      onRetryRun: () => {},
      onChooseWorkflowRepo: () => {},
      worldDocuments: [],
      onChangeWorldDocument: () => {},
      onRunCommand: () => {}
    }
    const runCard = (phase: "running" | "quiet" | "stopped"): Card => ({
      id: "flow-run-run-1",
      kind: "flow-run",
      title: "Creating a workflow — will/flows",
      status: "active",
      createdAt: 5,
      ordinal: 5,
      payload: {
        runId: "run-1",
        repo: "will/flows",
        workflow: "create-workflow",
        phase,
        steps: ["The run started."],
        result: null,
        lastSeq: 1
      }
    })
    const quiet = renderToStaticMarkup(<CardView card={runCard("quiet")} {...cardViewHandlers} />)
    expect(quiet).toContain("has gone quiet")
    expect(quiet).not.toContain("Running")
    expect(quiet).toContain("Quiet")
    // The two acts are on the card, and both are registered commands.
    expect(quiet).toContain("data-flow=\"flow.run.retry\"")
    expect(quiet).toContain("data-flow=\"flow.run.stop\"")

    const stopped = renderToStaticMarkup(<CardView card={runCard("stopped")} {...cardViewHandlers} />)
    expect(stopped).toContain("I stopped watching this run.")
    expect(stopped).not.toContain("Running")
    expect(stopped).toContain("Stopped")

    // The live phase is untouched: a running run still reads Running.
    expect(renderToStaticMarkup(<CardView card={runCard("running")} {...cardViewHandlers} />)).toContain("Running")
  })
})
