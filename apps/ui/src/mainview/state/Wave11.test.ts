/*
 * Wave 11 — "make me a workflow" becomes true, proven at the controller.
 *
 * Every test here drives the REAL controller against a relay double that
 * speaks the shapes the receipts recorded: the product Worker's
 * /api/workflow/{provision,rpc,events} seam in front of a gateway that answers
 * listWorkflows / launchRun / getRun / listApprovals / whatHappened and a
 * per-run event log with monotonic `seq`.
 *
 * The bar: a workflow is created, presented, and run — from the conversation —
 * as an EMBEDDED run card that never silently stalls, whose approval only the
 * human can decide.
 */
import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { Card } from "smithers-shared/Cards"
import type { AgentTurnFrame, StartAgentTurnRequest } from "smithers-shared/NativeAgent"
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge"
import { createAppController } from "./AppController"
import type { AppServices } from "./AppController"
import { createAppStore } from "./AppStore"

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const webStore = () => createAppStore({ kind: "localStorage", storage: memoryStorage() })

const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "Local repositories can only be connected from the Smithers native app."
  })
}

const silentAgent = (): NativeAgent => ({
  available: true,
  startTurn: async () => ({ status: "started" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
})

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const settle = async (ticks = 12): Promise<void> => {
  for (let index = 0; index < ticks; index += 1) await new Promise((resolve) => setTimeout(resolve, 1))
}

const REPO = "codeplanesmithers/smithers-demo"

/**
 * What a command said back. A registered command that returns a string is an
 * honest refusal (`failed`); one that returns `{value}` executed and speaks.
 */
const said = (outcome: { status: string; value?: string; error?: string }): string =>
  outcome.status === "failed" ? (outcome.error ?? "") : (outcome.value ?? "")

interface RunEvent {
  readonly seq: number
  readonly event: string
  readonly payload?: Record<string, unknown>
}

/**
 * The relay double: one scriptable workspace behind the product Worker's
 * /api/workflow/* seam. `advance()` is what a real run's progress looks like
 * from the outside — new events appear, the run's status moves on.
 */
const relay = (options: {
  readonly workflows?: ReadonlyArray<{ key: string; description?: string }>
  readonly provision?: () => unknown
  readonly eventsFail?: () => boolean
  /** Make provisioning slow enough to cross the toast debounce (the 300ms law). */
  readonly provisionDelayMs?: number
} = {}) => {
  const calls: Array<{ path: string; method: string; body: unknown }> = []
  const events: RunEvent[] = []
  const approvals: Array<Record<string, unknown>> = []
  const state = {
    runStatus: "running" as string,
    blocked: null as { kind: string; nodeId: string } | null,
    summary: "I built `summarize-open-issues` — it reads your open issues and writes one digest.",
    launched: [] as Array<{ workflow: string; input: unknown }>
  }
  const workflows = options.workflows ?? [
    { key: "create-workflow", description: "Build a new Smithers workflow from a plain-English ask." },
    { key: "review-pr" }
  ]

  const rpc = (method: string, params: Record<string, unknown>): Response => {
    switch (method) {
      case "listWorkflows":
        return json(200, { ok: true, payload: workflows })
      case "launchRun": {
        // The real gateway resolves its registry on a miss, then answers
        // NOT_FOUND honestly — the only truthful "no such workflow".
        const key = String(params.workflow)
        if (!workflows.some((entry) => entry.key === key)) {
          return json(200, { ok: false, error: { code: "NOT_FOUND", message: `Unknown workflow: ${key}` } })
        }
        state.launched.push({ workflow: key, input: params.input })
        return json(200, { ok: true, payload: { runId: "run-w11", workflow: params.workflow, system: false } })
      }
      case "getRun":
        return json(200, {
          ok: true,
          payload: {
            runId: "run-w11",
            status: state.runStatus,
            runState: { state: state.runStatus, blocked: state.blocked },
            errorJson: null
          }
        })
      case "listApprovals":
        return json(200, { ok: true, payload: approvals })
      case "submitApproval":
        return json(200, { ok: true, payload: { ...params, approved: true } })
      case "whatHappened":
        return json(200, {
          ok: true,
          payload: { runId: "run-w11", scope: "run", summary: state.summary, source: "facts" }
        })
      default:
        return json(200, { ok: false, error: { code: "NOT_FOUND", message: `no ${method}` } })
    }
  }

  const services: AppServices = {
    workflowPollMs: 1,
    toastDebounceMs: 0,
    toastAutoDismissMs: 10_000,
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const absolute = new URL(url, "https://app.test")
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      calls.push({ path: absolute.pathname + absolute.search, method: init?.method ?? "GET", body })
      if (absolute.pathname === "/api/workflow/provision") {
        if (options.provisionDelayMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, options.provisionDelayMs))
        }
        return json(200, options.provision?.() ?? { status: "ready", repo: REPO, gatewayId: "gw-1" })
      }
      if (absolute.pathname === "/api/workflow/rpc") {
        return rpc(String(body.method), (body.params ?? {}) as Record<string, unknown>)
      }
      if (absolute.pathname === "/api/workflow/events") {
        if (options.eventsFail?.() === true) return json(502, { status: "error", message: "gateway unreachable" })
        const afterSeq = Number(absolute.searchParams.get("afterSeq") ?? "0")
        return json(200, { ok: true, data: events.filter((event) => event.seq > afterSeq) })
      }
      if (absolute.pathname === "/api/approvals/decision") {
        return json(200, { status: "ok" })
      }
      return json(404, { status: "error", message: `no stub for ${absolute.pathname}` })
    }
  }

  return {
    services,
    calls,
    state,
    emit: (...rows: RunEvent[]) => events.push(...rows),
    park: (nodeId: string) => {
      state.runStatus = "waiting-approval"
      state.blocked = { kind: "approval", nodeId }
      approvals.push({
        runId: "run-w11",
        nodeId,
        iteration: 0,
        requestTitle: "Open a pull request with the new workflow",
        requestSummary: "This pushes a branch and opens a PR on your repository."
      })
    },
    /*
     * The run parks, but getRun says nothing about it: `runState` is DERIVED
     * and the gateway computes it best-effort (`.catch(() => undefined)`), so
     * a real parked run can read as plain "running" with no `blocked` at all.
     * Only the engine's own event announces the gate. `iteration` is omitted
     * too — the gateway defaults it, and a row that arrives without one is
     * still a gate the human must be able to decide.
     */
    parkUnannounced: (nodeId: string) => {
      approvals.push({
        runId: "run-w11",
        nodeId,
        requestTitle: "Open a pull request with the new workflow",
        requestSummary: "This pushes a branch and opens a PR on your repository."
      })
    },
    finish: () => {
      state.runStatus = "finished"
      state.blocked = null
      approvals.length = 0
    },
    fail: () => {
      state.runStatus = "failed"
      state.blocked = null
    }
  }
}

const signIn = async (store: Awaited<ReturnType<typeof webStore>>, watched: string[] | null = [REPO]) => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "codeplanesmithers",
    allowlisted: true,
    admin: false,
    scopesPlain: null
  })
  if (watched !== null) {
    store.dispatch({
      type: "watched.replaced",
      actor: "system",
      selected: watched,
      selectedAt: "2026-08-09T10:00:00.000Z",
      via: "onboarding"
    })
  }
  await settle(2)
}

const runCard = (store: Awaited<ReturnType<typeof webStore>>): Extract<Card, { kind: "flow-run" }> | undefined => {
  const card = store.collections.cards.get("flow-run-run-w11")
  return card?.kind === "flow-run" ? card : undefined
}

/** A scripted tool-loop agent (the ToolLoop.test.ts pattern). */
const scriptedToolAgent = (
  steps: ReadonlyArray<(request: StartAgentTurnRequest) => ReadonlyArray<Omit<AgentTurnFrame, "runId">>>
): { agent: NativeAgent; requests: Array<StartAgentTurnRequest> } => {
  const listeners = new Set<(frame: AgentTurnFrame) => void>()
  const requests: Array<StartAgentTurnRequest> = []
  let step = 0
  return {
    requests,
    agent: {
      available: true,
      startTurn: async (request) => {
        requests.push(request)
        const frames = (steps[Math.min(step, steps.length - 1)] ?? (() => []))(request)
        step += 1
        queueMicrotask(() => {
          for (const frame of frames) {
            for (const listener of listeners) listener({ ...frame, runId: request.runId } as AgentTurnFrame)
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
}

describe("wave 11 — the full journey: make me a workflow", () => {
  test("description → provision → run card → approval → completed card leading with the result", async () => {
    const store = await webStore()
    // A slow provision so the toast genuinely crosses the debounce (the 300ms
    // law): work that settles faster than that must never flash anything.
    const double = relay({ provisionDelayMs: 8 })
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      ...double.services,
      toastDebounceMs: 1
    })
    await signIn(store)

    double.emit({ seq: 1, event: "RunStarted" }, { seq: 2, event: "NodeStarted", payload: { nodeId: "clarify" } })
    const outcome = await controller.commands.run(
      "flow.create",
      "a workflow that summarizes my open issues"
    )
    expect(outcome.status).toBe("executed")
    expect(said(outcome)).toContain("run-w11")

    // The gateway was provisioned BEFORE anything was launched, and the
    // launch is the stock create-workflow with the description as its input.
    const order = double.calls.map((call) => call.path)
    expect(order[0]).toBe("/api/workflow/provision")
    expect(double.state.launched).toEqual([
      { workflow: "create-workflow", input: { prompt: "a workflow that summarizes my open issues" } }
    ])
    // The provision toast reported and then SETTLED into its result — the
    // wave-9 law: a toast past the debounce never keeps its running sentence.
    const toast = [...store.collections.toasts.values()].find((entry) => entry.key.startsWith("flow.provision"))
    expect(toast?.status).toBe("ok")
    expect(toast?.title).toBe("Workspace ready")

    // THE EMBED LAW: a card in the transcript, and the surface never moved.
    const card = runCard(store)
    expect(card).toBeDefined()
    expect(card?.payload.repo).toBe(REPO)
    expect(card?.payload.workflow).toBe("create-workflow")
    expect(store.collections.sessions.get("main")?.surface).toBe("chat")

    // Progress arrives in WORDS, never as a raw payload.
    await settle(20)
    expect(runCard(store)?.payload.steps.join(" ")).toContain("Working on clarify")
    expect(runCard(store)?.payload.steps.join(" ")).not.toContain("{")
    expect(runCard(store)?.payload.phase).toBe("running")

    // The run parks on an outbound act — the approval tier, not an auto-yes.
    double.emit({ seq: 3, event: "ApprovalRequested", payload: { nodeId: "open-pr" } })
    double.park("open-pr")
    await settle(25)
    expect(runCard(store)?.payload.phase).toBe("waiting-approval")
    const approval = store.collections.cards.get("approval-run-w11-open-pr-0")
    expect(approval?.kind).toBe("approval")
    expect(approval?.kind === "approval" && approval.payload.repo).toBe(REPO)
    expect(approval?.title).toContain("pull request")

    // The human decides; the decision names the repo so it round-trips
    // through THIS user's gateway.
    await controller.commands.run("approval.approve", "approval-run-w11-open-pr-0")
    await settle(6)
    const decision = double.calls.find((call) => call.path === "/api/approvals/decision")
    expect(decision?.body).toMatchObject({ runId: "run-w11", nodeId: "open-pr", iteration: 0, repo: REPO })

    // Auto-resume (proven at the relay in wave 4): the run finishes.
    double.emit({ seq: 4, event: "ApprovalRequested" }, { seq: 5, event: "RunFinished" })
    double.finish()
    await settle(30)

    const done = runCard(store)
    expect(done?.payload.phase).toBe("completed")
    expect(done?.status).toBe("acted")
    // The result LEADS — stated in words, in the chat and on the card.
    expect(done?.payload.result).toContain("summarize-open-issues")
    expect([...store.collections.messages.values()].some((message) => message.text.includes("summarize-open-issues")))
      .toBe(
        true
      )
    // The cursor advanced with the stream: a reload resumes, it does not replay.
    expect(done?.payload.lastSeq).toBe(5)
  })

  test("the agent invoking flow.create from the conversation renders the card, never a surface", async () => {
    const store = await webStore()
    const double = relay()
    const { agent, requests } = scriptedToolAgent([
      () => [
        {
          type: "tool_call" as const,
          call_id: "call_1",
          name: "commands",
          arguments: JSON.stringify({
            action: "execute",
            name: "flow.create",
            args: "a workflow that summarizes my open issues"
          })
        },
        { type: "done" as const, reason: "tool_call" as const }
      ],
      () => [
        { type: "delta" as const, kind: "text" as const, text: "Started it — the card tracks it live." },
        { type: "done" as const, reason: "stop" as const }
      ]
    ])
    const controller = createAppController(store, unavailableRepositories, agent, double.services)
    await signIn(store)

    controller.send("can you make me a smithers workflow that summarizes my open issues?")
    await settle(30)

    expect(double.state.launched[0]?.workflow).toBe("create-workflow")
    expect(runCard(store)).toBeDefined()
    expect(store.collections.sessions.get("main")?.surface).toBe("chat")
    // The tool result the model saw states the run, so it cannot claim
    // something the seam did not do.
    const secondTurn = requests[1]
    expect(JSON.stringify(secondTurn?.messages)).toContain("run-w11")
    // The transcript act line is compact — no raw tool payload.
    expect([...store.collections.messages.values()].map((message) => message.text).join("\n")).not.toContain(
      "{\"state\""
    )
  })
})

describe("wave 11 — the watched set is the universe", () => {
  test("a repo outside the watched set routes to the chooser, and nothing is provisioned", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      ...double.services,
      fetchImpl: async (input, init) => {
        const absolute = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
          "https://app.test"
        )
        if (absolute.pathname === "/api/identity/repos") {
          return json(200, { candidates: [{ fullName: REPO, private: false, pushedAt: null, openIssues: 0 }] })
        }
        if (absolute.pathname === "/api/identity/watched") {
          return json(200, { selected: [REPO], selectedAt: null, via: null })
        }
        return double.services.fetchImpl?.(input, init) ?? json(404, {})
      }
    })
    await signIn(store)

    const outcome = await controller.commands.run("flow.run", "review-pr someone/else")
    expect(said(outcome)).toContain("someone/else")
    expect(store.collections.cards.get("repo-chooser")).toBeDefined()
    expect(double.calls.some((call) => call.path === "/api/workflow/provision")).toBe(false)
  })

  test("no selection at all opens the chooser instead of guessing a repo", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      ...double.services,
      fetchImpl: async (input, init) => {
        const absolute = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
          "https://app.test"
        )
        if (absolute.pathname === "/api/identity/repos") return json(200, { candidates: [] })
        if (absolute.pathname === "/api/identity/watched") return json(200, { selected: null })
        return double.services.fetchImpl?.(input, init) ?? json(404, {})
      }
    })
    await signIn(store, null)

    await controller.commands.run("flow.create", "summarize my issues")
    expect(double.calls.some((call) => call.path === "/api/workflow/provision")).toBe(false)
    expect(store.collections.cards.get("repo-chooser")).toBeDefined()
  })

  test("signed out, nothing reaches the seam — the answer names the one step", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)

    for (const command of ["flow.create", "flow.list", "flow.run"]) {
      const outcome = await controller.commands.run(command, "x")
      expect(said(outcome)).toContain("Sign in")
    }
    expect(double.calls).toHaveLength(0)
  })
})

describe("wave 11 — the run card never silently stalls", () => {
  test("stream loss flips the card to the honest reconnecting state, then it catches up", async () => {
    const store = await webStore()
    let broken = false
    const double = relay({ eventsFail: () => broken })
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)

    double.emit({ seq: 1, event: "RunStarted" })
    await controller.commands.run("flow.run", "review-pr")
    await settle(20)
    expect(runCard(store)?.payload.phase).toBe("running")

    // The 600s relay cap makes this ROUTINE, not exceptional.
    broken = true
    await settle(30)
    expect(runCard(store)?.payload.phase).toBe("reconnecting")

    broken = false
    double.emit({ seq: 2, event: "NodeFinished", payload: { nodeId: "review" } })
    await settle(30)
    expect(runCard(store)?.payload.phase).toBe("running")
    expect(runCard(store)?.payload.steps.join(" ")).toContain("review finished")
  })

  test("the pump resumes from lastSeq — a replay never re-narrates what the card already said", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)

    double.emit({ seq: 1, event: "RunStarted" }, { seq: 2, event: "NodeStarted", payload: { nodeId: "plan" } })
    await controller.commands.run("flow.run", "review-pr")
    await settle(25)

    const afterSeqs = double.calls
      .filter((call) => call.path.startsWith("/api/workflow/events"))
      .map((call) => new URL(call.path, "https://app.test").searchParams.get("afterSeq"))
    // The first read starts at 0; every later one resumes past what landed.
    expect(afterSeqs[0]).toBe("0")
    expect(afterSeqs.at(-1)).toBe("2")
    // "The run started" appears exactly once despite many polls.
    const steps = runCard(store)?.payload.steps ?? []
    expect(steps.filter((step) => step === "The run started.")).toHaveLength(1)
  })

  test("a failed run states it and stops — no card left spinning", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)

    await controller.commands.run("flow.run", "review-pr")
    double.fail()
    await settle(25)
    expect(runCard(store)?.payload.phase).toBe("failed")
    expect(runCard(store)?.status).toBe("error")
    expect([...store.collections.messages.values()].some((message) => message.text.includes("failed"))).toBe(true)
  })

  test("a RunFailed event settles the card even while getRun still says 'running'", async () => {
    /*
     * The live-caught defect: the real gateway leaves `status:"running"`
     * after the last node has already failed (summary {failed:1}), so a
     * card that waits on `status` alone polls that run forever. The
     * terminal EVENT is authoritative.
     */
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)

    await controller.commands.run("flow.run", "review-pr")
    // The engine's own sentence for why the step could not run, verbatim
    // from a real 0.33 stream.
    double.emit(
      { seq: 1, event: "NodeStarted", payload: { nodeId: "clarify" } },
      {
        seq: 2,
        event: "AgentTraceEvent",
        payload: {
          nodeId: "clarify",
          trace: {
            payload: {
              error:
                "Smithers generated an OpenRouter default agent, but OPENROUTER_API_KEY is not set. Set OPENROUTER_API_KEY, or run `smithers agent add` to configure another agent, then rerun this workflow."
            }
          }
        }
      },
      { seq: 3, event: "NodeFailed", payload: { nodeId: "clarify" } },
      { seq: 4, event: "RunFailed" }
    )
    // getRun deliberately keeps saying "running" — exactly as it does live.
    await settle(30)

    const card = runCard(store)
    expect(card?.payload.phase).toBe("failed")
    expect(card?.payload.error).toContain("OPENROUTER_API_KEY is not set")
    expect(card?.payload.steps.join(" ")).toContain("clarify failed.")
    // The chat leads with the engine's reason, not a shrug.
    expect(
      [...store.collections.messages.values()].some((message) => message.text.includes("OPENROUTER_API_KEY"))
    ).toBe(true)
  })

  test("a gate the engine announces gets its approval card even when getRun never mentions it", async () => {
    /*
     * The same lesson as the terminal event, one gate over: `runState` is
     * derived best-effort, so a parked run can read as plain "running" with
     * no `blocked`. Gating the approval fetch on `blocked.kind` alone leaves
     * the human with a card that says Running and no way to unblock it —
     * the run then waits on a decision it never asked for.
     */
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)

    await controller.commands.run("flow.run", "review-pr")
    double.parkUnannounced("open-pr")
    double.emit({ seq: 1, event: "NodeWaitingApproval", payload: { nodeId: "open-pr" } })
    await settle(30)

    // getRun still says "running" with no blocked reason at all.
    expect(double.state.runStatus).toBe("running")
    expect(double.state.blocked).toBe(null)
    // The card asked for the gate anyway, and reads honestly.
    const approval = store.collections.cards.get("approval-run-w11-open-pr-0")
    expect(approval?.kind).toBe("approval")
    expect(approval?.kind === "approval" && approval.payload.repo).toBe(REPO)
    expect(runCard(store)?.payload.phase).toBe("waiting-approval")
    expect(runCard(store)?.payload.steps.join(" ")).toContain("Waiting for your approval")

    // And it round-trips through this user's gateway like any other.
    await controller.commands.run("approval.approve", "approval-run-w11-open-pr-0")
    await settle(6)
    expect(double.calls.find((call) => call.path === "/api/approvals/decision")?.body).toMatchObject({
      runId: "run-w11",
      nodeId: "open-pr",
      iteration: 0,
      repo: REPO
    })
  })

  test("frame and snapshot bookkeeping never reaches the transcript as progress", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)

    await controller.commands.run("flow.run", "review-pr")
    double.emit(
      { seq: 1, event: "FrameCommitted", payload: { frameNo: 1, xmlHash: "fca9f7" } },
      { seq: 2, event: "SnapshotCaptured", payload: { frameNo: 1, contentHash: "299dd3" } },
      { seq: 3, event: "NodePending", payload: { nodeId: "clarify" } }
    )
    await settle(20)

    const steps = runCard(store)?.payload.steps.join(" ") ?? ""
    expect(steps).not.toContain("fca9f7")
    expect(steps).not.toContain("Frame")
    expect(steps).not.toContain("Snapshot")
    // The cursor still advanced past them — silence is not a stall.
    expect(runCard(store)?.payload.lastSeq).toBe(3)
  })

  test("no_capacity is a passing truth — stated honestly, nothing launched, nothing retry-looped", async () => {
    const store = await webStore()
    const double = relay({
      provisionDelayMs: 8,
      provision: () => ({
        status: "no-capacity",
        message: "Smithers Cloud has no free workspace capacity right now — nothing was queued; try again in a bit."
      })
    })
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      ...double.services,
      toastDebounceMs: 1
    })
    await signIn(store)

    const outcome = await controller.commands.run("flow.create", "summarize my issues")
    expect(said(outcome)).toContain("no free workspace capacity")
    expect(double.state.launched).toHaveLength(0)
    expect(double.calls.filter((call) => call.path === "/api/workflow/provision")).toHaveLength(1)
    // The failure toast keeps the attempt and states why.
    expect([...store.collections.toasts.values()].some((toast) => toast.status === "failed")).toBe(true)
  })
})

describe("wave 11 — workflows are presented", () => {
  test("flow.list renders the workspace's workflows as an embedded card", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)

    const outcome = await controller.commands.run("flow.list")
    expect(outcome.status).toBe("executed")
    expect(said(outcome)).toContain("create-workflow")
    const card = store.collections.cards.get(`workflow-list-${REPO}`)
    expect(card?.kind).toBe("workflow-list")
    expect(card?.kind === "workflow-list" && card.payload.workflows.map((entry) => entry.key)).toEqual([
      "create-workflow",
      "review-pr"
    ])
    // A workflow with no description says nothing rather than inventing one.
    expect(card?.kind === "workflow-list" && card.payload.workflows[1]?.description).toBeNull()
    expect(store.collections.sessions.get("main")?.surface).toBe("chat")
  })

  test("flow.run refuses a name the workspace does not have, and names what it does have", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)

    const outcome = await controller.commands.run("flow.run", "nope")
    expect(said(outcome)).toContain("There's no workflow called nope")
    expect(said(outcome)).toContain("create-workflow")
    expect(double.state.launched).toHaveLength(0)
  })

  test("a workspace without create-workflow surfaces the GATEWAY's own refusal, never a guess", async () => {
    // The live gateway populates its global pack lazily, so a cold
    // listWorkflows is not evidence of absence — only launchRun's NOT_FOUND is.
    const store = await webStore()
    const double = relay({ workflows: [{ key: "review-pr" }] })
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)

    const outcome = await controller.commands.run("flow.create", "summarize my issues")
    expect(said(outcome)).toContain("Unknown workflow: create-workflow")
    expect(double.state.launched).toHaveLength(0)
    // It tried the launch — it did not refuse on a stale list.
    expect(double.calls.some((call) => (call.body as { method?: string } | undefined)?.method === "launchRun")).toBe(
      true
    )
  })

  test("a cold listWorkflows never blocks a workflow the workspace really has", async () => {
    // Regression for the live-caught defect: the pre-flight list gate
    // refused `create-workflow` on a workspace that ran it seconds later.
    const store = await webStore()
    const double = relay({ workflows: [{ key: "create-workflow" }] })
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      ...double.services,
      fetchImpl: async (input, init) => {
        const absolute = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
          "https://app.test"
        )
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
        // A COLD registry: listWorkflows shows only the repo's own workflows.
        if (absolute.pathname === "/api/workflow/rpc" && body?.method === "listWorkflows") {
          return json(200, { ok: true, payload: [{ key: "chat" }, { key: "oneshot" }, { key: "workspace" }] })
        }
        return double.services.fetchImpl?.(input, init) ?? json(404, {})
      }
    })
    await signIn(store)

    const outcome = await controller.commands.run("flow.create", "summarize my issues")
    expect(said(outcome)).toContain("run-w11")
    expect(double.state.launched[0]?.workflow).toBe("create-workflow")
  })

  test("a launch answers with a MINIMAL machine acknowledgment — the claim surface is not the model's", async () => {
    /*
     * Wave 11 tried to talk the model out of lying, in the tool result and
     * in the system prompt, and the deployed model said "has been created"
     * anyway. Wave 12 §1 stops arguing: the result states the fact, and the
     * rendered claim is the client's (Wave12.test.ts pins the rendering).
     */
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)

    const created = said(await controller.commands.run("flow.create", "summarize my open issues"))
    expect(created).toBe(`run-started workflow=create-workflow run=run-w11 repo=${REPO}`)

    const ran = said(await controller.commands.run("flow.run", "review-pr"))
    expect(ran).toBe(`run-started workflow=review-pr run=run-w11 repo=${REPO}`)
  })

  test("the three commands are agent-reachable (trigger both) — this is the whole of the new surface", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)

    const listed = await controller.commands.executeForAgent({
      name: "commands",
      arguments: JSON.stringify({ action: "list" })
    })
    for (const name of ["flow.create", "flow.list", "flow.run"]) {
      expect(listed).toContain(name)
    }
    /*
     * NO INVENTION: the three conversational commands stay the whole of the
     * agent-facing surface. Wave 12 adds three HIDDEN card bindings (the
     * which-repo answer and a quiet run's stop/retry) — affordances the
     * brief names, invisible to the slash menu and the tool catalog alike.
     */
    expect(controller.commands.all().filter((command) => command.name.startsWith("flow."))).toHaveLength(6)
    expect(
      controller.commands
        .all()
        .filter((command) => command.name.startsWith("flow.") && command.hidden !== true)
        .map((command) => command.name)
    ).toEqual(["flow.create", "flow.list", "flow.run"])
  })
})
