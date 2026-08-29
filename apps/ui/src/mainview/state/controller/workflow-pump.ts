import { WORKFLOW_EVENTS_PATH, WORKFLOW_STREAM_PATH } from "smithers-shared/AgentApiRoutes"
import type { Card } from "../AppState"
import type { ControllerContext } from "./context"
import { whatHappenedWords } from "./workflows"

export interface WorkflowPumpController {
  readonly pumpWorkflowRun: (cardId: string) => Promise<void>
  readonly stopWatchingRun: (cardId: string) => string | void
  readonly retryRunWatch: (cardId: string) => string | void
  readonly resumeWorkflowRuns: () => void
  readonly stopWorkflowPumps: () => void
}

export const createWorkflowPumpController = (
  ctx: ControllerContext,
  nextTranscriptOrdinal: () => number
): WorkflowPumpController => {
  const { store, baseUrl, http, unref, workflowPollMs, services } = ctx
  /*
   * Wave 11 — workflows in the conversation ("make me a workflow").
   *
   * Every act routes through the per-user gateway seam on the product
   * Worker: provision/resume the workspace gateway for a WATCHED repo (the
   * watched set is the universe — anything outside it routes to the
   * chooser), then whitelisted RPCs. A run renders as an embedded run card
   * (THE EMBED LAW) whose event pump resumes from `lastSeq` — stream loss
   * is routine, never a silent stall; failures surface as the honest
   * reconnecting state.
   */
  const RUN_POLL_MS = workflowPollMs
  const RUN_STEPS_TAIL = 8
  /*
   * Wave 12 §3 — the generous bound. A run the workspace never finishes is a
   * real state (wave 11's credential-less create-workflow run is exactly it),
   * and polling it until the tab closes is neither honest nor kind to the
   * workspace. After this long with no event progress the card says so and the
   * pump stops; stop/retry are the human's next acts, both registered commands.
   */
  const RUN_QUIET_AFTER_MS = services.workflowQuietMs ?? 10 * 60 * 1000
  const workflowRpc = (repo: string, method: string, params: unknown) => ctx.workflowRpc(repo, method, params)

  /** The relay SSE change stream pokes live pumps so progress lands the second it happens. */
  const liveRunCards = (repo?: string): Array<Extract<Card, { kind: "flow-run" }>> =>
    [...store.collections.cards.values()]
      .filter(
        (card) =>
          card.kind === "flow-run" &&
          (card.payload.phase === "launching" ||
            card.payload.phase === "running" ||
            card.payload.phase === "waiting-approval" ||
            card.payload.phase === "reconnecting") &&
          (repo === undefined || card.payload.repo === repo)
      ) as Array<Extract<Card, { kind: "flow-run" }>>

  const closeRunStreamIfIdle = (repo: string): void => {
    if (liveRunCards(repo).length > 0) return
    ctx.runStreams.get(repo)?.close()
    ctx.runStreams.delete(repo)
  }

  const ensureRunStream = (repo: string): void => {
    if (typeof EventSource === "undefined" || ctx.runStreams.has(repo)) return
    try {
      const source = new EventSource(`${baseUrl}${WORKFLOW_STREAM_PATH}?repo=${encodeURIComponent(repo)}`)
      // A change frame means fresh state exists NOW — poke this repo's pumps
      // instead of waiting out the poll cadence. EventSource reconnects on
      // its own and replays via Last-Event-ID through the seam; the poll
      // loop below is the floor, so a dead stream never stalls a card.
      source.addEventListener("change", () => {
        for (const card of liveRunCards(repo)) ctx.pumpPokes.get(card.id)?.()
      })
      ctx.runStreams.set(repo, source)
    } catch {
      // The poll cadence alone carries the run card.
    }
  }

  const pokeableWait = (cardId: string, ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        ctx.pumpPokes.delete(cardId)
        resolve()
      }, ms)
      unref(timer)
      ctx.pumpPokes.set(cardId, () => {
        clearTimeout(timer)
        ctx.pumpPokes.delete(cardId)
        resolve()
      })
    })

  const patchRunCard = (
    cardId: string,
    patch: Partial<Extract<Card, { kind: "flow-run" }>["payload"]>,
    status?: Card["status"]
  ): void => {
    const card = store.collections.cards.get(cardId)
    if (card === undefined || card.kind !== "flow-run") return
    store.dispatch({
      type: "card.updated",
      actor: "system",
      id: cardId,
      patch: { payload: { ...card.payload, ...patch }, ...(status === undefined ? {} : { status }) }
    })
  }

  /** One run event, in words. Unknown events stay silent — never raw payloads. */
  /**
   * The engine's own error text for a node that could not run — the
   * `AgentTraceEvent` capture-error carries the only sentence that actually
   * explains it (e.g. a workspace VM with no AI-provider credential). One
   * line, never a payload dump.
   */
  const traceErrorOf = (payload: unknown): string | undefined => {
    if (typeof payload !== "object" || payload === null) return undefined
    const trace = (payload as { trace?: { payload?: { error?: unknown } } }).trace
    const error = trace?.payload?.error
    return typeof error === "string" && error.trim() !== "" ? error.trim().slice(0, 240) : undefined
  }

  const runEventWords = (event: unknown, payload: unknown): string | undefined => {
    const nodeId =
      typeof payload === "object" && payload !== null && "nodeId" in payload && typeof payload.nodeId === "string"
        ? payload.nodeId
        : undefined
    /*
     * The engine's event vocabulary is PascalCase (`NodeStarted`,
     * `RunFinished`, …) — the names the live gateway actually emits, read
     * off a real 0.33 run stream. Frame/snapshot bookkeeping stays silent:
     * it is machinery, not progress a human asked about.
     */
    switch (event) {
      case "RunStarted":
        return "The run started."
      case "NodeStarted":
        return nodeId === undefined ? undefined : `Working on ${nodeId}…`
      case "NodeFinished":
        return nodeId === undefined ? undefined : `${nodeId} finished.`
      case "NodeRetrying":
        return nodeId === undefined ? undefined : `Retrying ${nodeId}…`
      case "NodeWaitingApproval":
      case "ApprovalRequested":
        return "Waiting for your approval."
      case "NodeFailed":
        return nodeId === undefined ? "A step failed." : `${nodeId} failed.`
      case "RunFailed":
        return "The run failed."
      case "RunFinished":
        return "The run finished."
      case "AgentTraceEvent": {
        // Only the capture errors say anything a human needs; the rest of
        // the agent trace is machinery.
        const error = traceErrorOf(payload)
        return error === undefined ? undefined : error
      }
      default:
        return undefined
    }
  }

  /** The terminal run events — authoritative even when `status` lags behind. */
  const TERMINAL_RUN_EVENTS: Readonly<Record<string, "completed" | "failed" | "cancelled">> = {
    RunFinished: "completed",
    RunFailed: "failed",
    RunCancelled: "cancelled"
  }

  /** The approval cards a run is waiting on, bound to the existing round trip. */
  const upsertRunApprovals = (runId: string, repo: string, wire: unknown): number => {
    let found = 0
    for (const entry of Array.isArray(wire) ? wire : []) {
      if (typeof entry !== "object" || entry === null) continue
      const approval = entry as {
        runId?: unknown
        nodeId?: unknown
        iteration?: unknown
        requestTitle?: unknown
        requestSummary?: unknown
      }
      if (approval.runId !== runId || typeof approval.nodeId !== "string") continue
      // The gateway serializes `iteration ?? 0`; a row that still arrives
      // without one is a gate the human must be able to decide, not a row
      // to drop on the floor — dropping it strands the run with no card.
      const iteration = typeof approval.iteration === "number" ? approval.iteration : 0
      found += 1
      const id = `approval-${runId}-${approval.nodeId}-${iteration}`
      if (store.collections.cards.get(id) !== undefined) continue
      const title = typeof approval.requestTitle === "string"
        ? approval.requestTitle
        : `Approval needed — ${approval.nodeId}`
      const card: Card = {
        id,
        kind: "approval",
        title,
        status: "active",
        createdAt: Date.now(),
        ordinal: nextTranscriptOrdinal(),
        payload: {
          capability: title,
          ...(typeof approval.requestSummary === "string" ? { detail: approval.requestSummary } : {}),
          runId,
          nodeId: approval.nodeId,
          iteration,
          repo
        }
      }
      store.dispatch({ type: "card.upsert", actor: "system", card })
    }
    return found
  }

  /** A gate this run is still parked on, as the transcript itself holds it. */
  const runAwaitsApproval = (runId: string): boolean =>
    [...store.collections.cards.values()].some(
      (entry) => entry.kind === "approval" && entry.payload.runId === runId && entry.payload.decision === undefined
    )

  /*
   * The run pump: poll per-run events with afterSeq resume (reconnect-and-
   * replay — the relay's seq is per-run monotonic) plus the run state, until
   * the run settles. Consecutive failures flip the card to the honest
   * reconnecting state; the pump never stops silently. The SSE change
   * stream pokes it for immediacy; the cadence is the floor.
   */
  const pumpWorkflowRun = async (cardId: string): Promise<void> => {
    if (ctx.runPumps.has(cardId)) return
    const pump = { stopped: false }
    ctx.runPumps.set(cardId, pump)
    let failures = 0
    let repo = ""
    /** The engine's first stated reason a step could not run, if it gave one. */
    let failureDetail: string | undefined
    /** A gate the engine announced whose approval row is not in hand yet. */
    let approvalPending = false
    /** When this run last actually moved — the clock behind the quiet bound. */
    let lastProgressAt = Date.now()
    /** The last thing getRun said, so a repeated answer does not read as movement. */
    let lastRunStatus: string | undefined
    try {
      for (;;) {
        if (pump.stopped) return
        const card = store.collections.cards.get(cardId)
        if (card === undefined || card.kind !== "flow-run") return
        if (
          card.payload.phase === "completed" ||
          card.payload.phase === "failed" ||
          card.payload.phase === "cancelled" ||
          card.payload.phase === "no-capacity" ||
          card.payload.phase === "quiet" ||
          card.payload.phase === "stopped"
        ) {
          return
        }
        /*
         * §3: nothing has moved for a very long time. Say so and stop —
         * an endlessly reconnecting or endlessly "running" card that
         * nobody can act on is the silent stall in a different costume.
         */
        const quietFor = Date.now() - lastProgressAt
        if (quietFor >= RUN_QUIET_AFTER_MS) {
          patchRunCard(cardId, { phase: "quiet", quietForMs: quietFor })
          return
        }
        repo = card.payload.repo
        const { runId, lastSeq } = card.payload
        ensureRunStream(repo)

        let rows: unknown[] | undefined
        try {
          const response = await http(
            `${baseUrl}${WORKFLOW_EVENTS_PATH}?repo=${encodeURIComponent(repo)}&runId=${
              encodeURIComponent(runId)
            }&afterSeq=${lastSeq}`
          )
          if (!response.ok) throw new Error("events failed")
          const body: unknown = await response.json().catch(() => undefined)
          // The relay REST envelope is {ok:true, data:[…]}; tolerate a bare array.
          const data = typeof body === "object" && body !== null && "data" in body
            ? (body as { data?: unknown }).data
            : body
          if (!Array.isArray(data)) throw new Error("events shape")
          rows = data
        } catch {
          failures += 1
          if (failures >= 2 && !pump.stopped) patchRunCard(cardId, { phase: "reconnecting" })
          await pokeableWait(cardId, RUN_POLL_MS)
          continue
        }

        let newSeq = lastSeq
        const newSteps: string[] = []
        /*
         * A terminal EVENT settles the card even when `getRun.status`
         * lags behind it — the live gateway leaves a run reading
         * "running" after its last node has already failed, and a card
         * that polls that forever is exactly the silent stall §1 forbids.
         */
        let terminalEvent: "completed" | "failed" | "cancelled" | undefined
        let firstFailure: string | undefined
        /*
         * The engine announces its own gate (`NodeWaitingApproval` /
         * `ApprovalRequested`). getRun's `runState` is DERIVED and the
         * gateway computes it best-effort — when that computation fails
         * the run record carries no `blocked` at all, and a card that
         * only asks `blocked.kind` would leave a parked run with no
         * approval card and no way for the human to unblock it. The
         * event is authoritative here for the same reason the terminal
         * event is above.
         */
        let approvalEvent = false
        for (const row of rows) {
          if (typeof row !== "object" || row === null) continue
          const event = row as { seq?: unknown; event?: unknown; payload?: unknown }
          if (typeof event.seq === "number" && Number.isInteger(event.seq)) {
            newSeq = Math.max(newSeq, event.seq)
          }
          const words = runEventWords(event.event, event.payload)
          if (words !== undefined) newSteps.push(words)
          if (typeof event.event === "string" && event.event in TERMINAL_RUN_EVENTS) {
            terminalEvent = TERMINAL_RUN_EVENTS[event.event]
          }
          if (event.event === "NodeWaitingApproval" || event.event === "ApprovalRequested") {
            approvalEvent = true
          }
          // The engine's own sentence for why a step could not run.
          if (firstFailure === undefined && event.event === "AgentTraceEvent") {
            firstFailure = traceErrorOf(event.payload)
          }
        }
        if (firstFailure !== undefined) failureDetail ??= firstFailure

        // A stop landing mid-iteration must not be overwritten by the
        // answer that was already in flight when it arrived.
        if (pump.stopped) return
        const run = await workflowRpc(repo, "getRun", { runId })
        if (pump.stopped) return
        const runPayload = run.status === "ok" && typeof run.payload === "object" && run.payload !== null
          ? (run.payload as {
            status?: unknown
            runState?: { blocked?: { kind?: unknown } | null } | null
            errorJson?: unknown
          })
          : undefined
        const runStatus = typeof runPayload?.status === "string" ? runPayload.status : undefined
        const blockedKind = typeof runPayload?.runState?.blocked?.kind === "string"
          ? runPayload.runState.blocked.kind
          : undefined
        const statusTerminal = runStatus === "finished"
          ? "completed"
          : runStatus === "failed"
          ? "failed"
          : runStatus === "cancelled"
          ? "cancelled"
          : undefined
        const settled = statusTerminal ?? terminalEvent

        if (approvalEvent) approvalPending = true
        if (blockedKind === "approval" || runStatus === "waiting-approval" || approvalPending) {
          const approvals = await workflowRpc(repo, "listApprovals", { filter: { runId } })
          if (pump.stopped || ctx.runPumps.get(cardId) !== pump) return
          // Keep asking until the gate is actually in hand: the parked
          // event can land a beat before the approval row is readable.
          if (approvals.status === "ok" && upsertRunApprovals(runId, repo, approvals.payload) > 0) {
            approvalPending = false
          }
        }

        failures = 0
        if (settled !== undefined) {
          const steps = [...card.payload.steps, ...newSteps].slice(-RUN_STEPS_TAIL)
          if (settled === "completed") {
            const happened = await workflowRpc(repo, "whatHappened", { runId })
            if (pump.stopped || ctx.runPumps.get(cardId) !== pump) return
            const result = whatHappenedWords(happened) ?? "The run finished."
            patchRunCard(cardId, { phase: "completed", steps, lastSeq: newSeq, result }, "acted")
            store.dispatch({ type: "message.appended", actor: "system", text: result })
          } else {
            // Lead with the engine's own reason when it gave one; the
            // generic line is the fallback, never a cover for it.
            const detail = failureDetail ??
              (typeof runPayload?.errorJson === "string" ? runPayload.errorJson.slice(0, 300) : undefined)
            const message = settled === "failed"
              ? `The run failed on your workspace${
                detail === undefined ? " — the card has what the gateway reported." : `: ${detail}`
              }`
              : "The run was cancelled."
            patchRunCard(
              cardId,
              {
                phase: settled === "failed" ? "failed" : "cancelled",
                steps,
                lastSeq: newSeq,
                ...(detail === undefined ? {} : { error: detail })
              },
              "error"
            )
            store.dispatch({ type: "message.appended", actor: "system", text: message })
          }
          return
        }

        /*
         * Real movement resets the quiet clock: new events, a cursor that
         * advanced, or a run that CHANGED what it says about itself. A
         * getRun that keeps answering the same "running" is not progress —
         * that is precisely the state §3 exists for.
         */
        if (newSteps.length > 0 || newSeq > lastSeq || runStatus !== lastRunStatus) {
          lastProgressAt = Date.now()
        }
        lastRunStatus = runStatus

        const phase = card.payload.phase === "launching" && newSteps.length === 0 && runStatus === undefined
          ? card.payload.phase
          : runStatus === "waiting-approval" || blockedKind === "approval" || runAwaitsApproval(runId)
          ? "waiting-approval"
          : "running"
        patchRunCard(cardId, {
          phase,
          steps: [...card.payload.steps, ...newSteps].slice(-RUN_STEPS_TAIL),
          lastSeq: newSeq
        })
        await pokeableWait(cardId, RUN_POLL_MS)
      }
    } finally {
      /*
       * Only tear down THIS pump's registrations. "Stop watching" then
       * "Check again" can start a successor while this one is still
       * unwinding its last await, and an unconditional delete here would
       * strip the live pump out of the registry — leaving the SSE poke
       * pointing at nothing and letting a second pump start beside it.
       */
      if (ctx.runPumps.get(cardId) === pump) {
        ctx.pumpPokes.delete(cardId)
        ctx.runPumps.delete(cardId)
        if (repo !== "") closeRunStreamIfIdle(repo)
      }
    }
  }
  /*
   * Wave 12 §3 — the two acts a quiet run offers, both registered commands so
   * the card's buttons dispatch through the one path everything else does.
   * "Stop" is stop WATCHING: this seam has no cancelRun, and saying the run was
   * cancelled would be the same kind of lie §1 is about.
   */
  const runCardFor = (cardId: string): Extract<Card, { kind: "flow-run" }> | undefined => {
    const card = store.collections.cards.get(cardId)
    return card?.kind === "flow-run" ? card : undefined
  }

  const stopWatchingRun = (cardId: string): string | void => {
    const card = runCardFor(cardId)
    if (card === undefined) return "That isn't a run card."
    const pump = ctx.runPumps.get(cardId)
    if (pump !== undefined) pump.stopped = true
    ctx.runPumps.delete(cardId)
    ctx.pumpPokes.get(cardId)?.()
    patchRunCard(cardId, {
      phase: "stopped",
      steps: [...card.payload.steps, "Stopped watching this run."].slice(-RUN_STEPS_TAIL)
    })
    closeRunStreamIfIdle(card.payload.repo)
    return undefined
  }

  const retryRunWatch = (cardId: string): string | void => {
    const card = runCardFor(cardId)
    if (card === undefined) return "That isn't a run card."
    patchRunCard(cardId, {
      phase: "running",
      steps: [...card.payload.steps, "Checking the run again…"].slice(-RUN_STEPS_TAIL)
    })
    void pumpWorkflowRun(cardId)
    return undefined
  }

  /** Boot reconciliation: a live run card's pump resumes from its lastSeq. */
  const resumeWorkflowRuns = (): void => {
    for (const card of liveRunCards()) void pumpWorkflowRun(card.id)
  }
  ctx.resumeWorkflowRuns = resumeWorkflowRuns

  const stopWorkflowPumps = (): void => {
    for (const pump of ctx.runPumps.values()) pump.stopped = true
    ctx.runPumps.clear()
    ctx.pumpPokes.clear()
    for (const source of ctx.runStreams.values()) source.close()
    ctx.runStreams.clear()
  }
  ctx.stopWorkflowPumps = stopWorkflowPumps
  return {
    pumpWorkflowRun,
    stopWatchingRun,
    retryRunWatch,
    resumeWorkflowRuns,
    stopWorkflowPumps
  }
}
