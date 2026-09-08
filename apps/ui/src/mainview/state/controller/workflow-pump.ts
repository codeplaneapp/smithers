import type { Card } from "../AppState"
import type { ControllerContext } from "./context"
import type { ApprovalRow, RunStatus, RunSummaryRow } from "./gateway"

export interface WorkflowPumpController {
  readonly pumpWorkflowRun: (cardId: string) => Promise<void>
  readonly stopWatchingRun: (cardId: string, reason?: string) => string | void
  readonly retryRunWatch: (cardId: string) => string | void
  readonly resumeWorkflowRuns: () => void
  readonly stopWorkflowPumps: () => void
}

/** How a run card reads each rc.0 run status. */
const PHASE_OF_STATUS: Readonly<Record<RunStatus, Extract<Card, { kind: "run-trace" }>["payload"]["phase"]>> = {
  accepted: "running",
  running: "running",
  parked: "running",
  "waiting-approval": "waiting-approval",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled"
}

const TERMINAL_PHASES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"])

export const createWorkflowPumpController = (
  ctx: ControllerContext,
  nextTranscriptOrdinal: () => number
): WorkflowPumpController => {
  const { store, gateway, unref, workflowPollMs, services } = ctx
  /*
   * Workflows in the conversation ("make me a workflow").
   *
   * Every act routes through the per-user gateway seam on the product Worker:
   * provision-or-resume the workspace gateway for a loaded repo (the loaded
   * set is the universe), then the
   * gateway's own procedures. A run renders as an embedded run card (THE EMBED
   * LAW) whose pump re-reads the `run-summary`, `transcript`, and `approvals`
   * projections. A projection carries the whole current answer rather than a
   * delta, so a poll that misses a beat loses nothing and a reconnect needs no
   * replay: the state IS the answer.
   */
  const RUN_POLL_MS = workflowPollMs
  const RUN_STEPS_TAIL = 8
  /*
   * The generous bound. A run the workspace never finishes is a real state,
   * and polling it until the tab closes is neither honest nor kind to the
   * workspace. After this long with no progress the card says so and the pump
   * stops; stop/retry are the human's next acts, both registered commands.
   */
  const RUN_QUIET_AFTER_MS = services.workflowQuietMs ?? 10 * 60 * 1000

  const liveRunCards = (): Array<Extract<Card, { kind: "run-trace" }>> =>
    [...store.collections.cards.values()].filter(
      (card) =>
        card.kind === "run-trace" &&
        (card.payload.phase === "launching" ||
          card.payload.phase === "running" ||
          card.payload.phase === "waiting-approval" ||
          card.payload.phase === "reconnecting")
    ) as Array<Extract<Card, { kind: "run-trace" }>>

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
    patch: Partial<Extract<Card, { kind: "run-trace" }>["payload"]>,
    status?: Card["status"]
  ): void => {
    const card = store.collections.cards.get(cardId)
    if (card === undefined || card.kind !== "run-trace") return
    store.dispatch({
      type: "card.updated",
      actor: "system",
      id: cardId,
      patch: { payload: { ...card.payload, ...patch }, ...(status === undefined ? {} : { status }) }
    })
  }

  /**
   * What the run has done since the card last looked, in words.
   *
   * The summary counts every fact a human asked about — turns, calls, edits —
   * so the line is computed from the counters rather than from a vocabulary of
   * event names this app would have to keep in step with the engine's.
   */
  const progressWords = (row: RunSummaryRow, previous: RunSummaryRow | undefined): string | undefined => {
    if (previous !== undefined && row.turns === previous.turns && row.calls === previous.calls) return undefined
    if (row.calls === 0 && row.turns === 0) return undefined
    return `${row.turns} ${row.turns === 1 ? "turn" : "turns"} · ${row.calls} ${
      row.calls === 1 ? "call" : "calls"
    }${row.callsFailed > 0 ? ` (${row.callsFailed} refused)` : ""}`
  }

  /** The approval cards a run is waiting on, bound to the existing round trip. */
  const upsertRunApprovals = (runId: string, repo: string, rows: ReadonlyArray<ApprovalRow>): number => {
    let found = 0
    for (const approval of rows) {
      if (approval.runId !== runId || approval.status !== "pending") continue
      found += 1
      const id = `approval-${runId}-${approval.requestId}`
      if (store.approvalRequest(id) !== undefined && store.collections.cards.get(id) !== undefined) continue
      const card: Card = {
        id,
        kind: "approval",
        title: approval.title,
        status: "active",
        createdAt: Date.now(),
        ordinal: nextTranscriptOrdinal(),
        payload: {
          capability: approval.title,
          runId,
          requestId: approval.requestId,
          // The submit-ready envelope the gateway published: the decision goes
          // back with it unchanged, so no client reconstructs authority.
          approval: approval.payload as Record<string, unknown>,
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
   * The run pump: re-read the run's summary until it settles. Consecutive
   * failures flip the card to the honest reconnecting state; the pump never
   * stops silently.
   */
  const pumpWorkflowRun = async (cardId: string): Promise<void> => {
    if (ctx.runPumps.has(cardId)) return
    const pump = { stopped: false }
    ctx.runPumps.set(cardId, pump)
    let failures = 0
    /** A gate the run announced whose approval row is not in hand yet. */
    let approvalPending = false
    /** When this run last actually moved — the clock behind the quiet bound. */
    let lastProgressAt = Date.now()
    /** The last summary read, so a repeated answer does not read as movement. */
    let previous: RunSummaryRow | undefined
    try {
      for (;;) {
        if (pump.stopped) return
        const card = store.collections.cards.get(cardId)
        if (card === undefined || card.kind !== "run-trace") return
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
         * Nothing has moved for a very long time. Say so and stop — an
         * endlessly reconnecting or endlessly "running" card that nobody can
         * act on is the silent stall in a different costume.
         */
        const quietFor = Date.now() - lastProgressAt
        if (quietFor >= RUN_QUIET_AFTER_MS) {
          patchRunCard(cardId, { phase: "quiet", quietForMs: quietFor })
          return
        }
        const { repo, runId } = card.payload

        const summary = await gateway.run(repo, runId)
        if (pump.stopped || ctx.runPumps.get(cardId) !== pump) return
        if (summary.status !== "ok" || summary.value === undefined) {
          failures += 1
          if (failures >= 2 && !pump.stopped) patchRunCard(cardId, { phase: "reconnecting" })
          await pokeableWait(cardId, RUN_POLL_MS)
          continue
        }
        failures = 0
        const row = summary.value
        const words = progressWords(row, previous)
        const newSteps = words === undefined ? [] : [words]

        if (row.status === "waiting-approval" || row.waitingReason === "approval") approvalPending = true
        if (approvalPending) {
          const approvals = await gateway.approvals(repo, runId)
          if (pump.stopped || ctx.runPumps.get(cardId) !== pump) return
          // Keep asking until the gate is actually in hand: a parked run can
          // be readable a beat before its approval row is.
          if (approvals.status === "ok" && upsertRunApprovals(runId, repo, approvals.value) > 0) {
            approvalPending = false
          }
        }

        /*
         * Lane runs — the card's transcript follows the live run while the
         * human asked it to (`runs.logs --follow`): each cycle re-reads the
         * projection and replaces the rows, one round trip bound to the pump
         * the card already pays for. Unfollowing stops the merge, and a
         * terminal run keeps its last transcript standing.
         */
        let transcriptRows: Extract<Card, { kind: "run-trace" }>["payload"]["transcriptRows"]
        if (card.payload.follow === true) {
          const transcript = await gateway.transcript(repo, runId)
          if (pump.stopped || ctx.runPumps.get(cardId) !== pump) return
          if (transcript.status === "ok") {
            transcriptRows = transcript.value.map((line) => ({
              sequence: line.sequence,
              turn: line.turn,
              at: line.at,
              kind: line.kind,
              text: line.text
            }))
          }
        }

        /*
         * The trace (spec 06) is the card's body, so every cycle re-reads the
         * run-events projection: the call tree and waterfall follow the live
         * run without a further act. A terminal run keeps its last journal
         * standing; a read that fails leaves the journal in hand untouched.
         */
        let events: Extract<Card, { kind: "run-trace" }>["payload"]["events"]
        {
          const journal = await gateway.runEvents(repo, runId)
          if (pump.stopped || ctx.runPumps.get(cardId) !== pump) return
          if (journal.status === "ok") {
            events = journal.value.map((event) => ({ ...(event as unknown as Record<string, unknown>) }))
          }
        }

        /*
         * Why the run is not moving, in the control plane's word. `accepted`
         * reads "executor" — the CLI's own render-time convention for a run
         * nothing is driving yet — and a parked run names its wait. A moving
         * run names nothing.
         */
        const waiting = row.status === "accepted"
          ? "executor"
          : row.status === "parked"
          ? row.waitingReason ?? "parked"
          : undefined
        const steeringPending = (row.steeringPending ?? 0) > 0

        const phase = PHASE_OF_STATUS[row.status]
        if (TERMINAL_PHASES.has(phase)) {
          const steps = [...card.payload.steps, ...newSteps].slice(-RUN_STEPS_TAIL)
          if (phase === "completed") {
            // The run summary's own verdict, which is what `whatHappened`
            // used to answer out of the engine database.
            const result = row.verdict
            patchRunCard(cardId, { phase, steps, lastSeq: row.updatedAt, result, waiting: undefined, steeringPending, ...(transcriptRows === undefined ? {} : { transcriptRows }), ...(events === undefined ? {} : { events }) }, "acted")
            store.dispatch({ type: "message.appended", actor: "system", text: result })
          } else {
            // Lead with the run's own diagnosis; the generic line is the
            // fallback, never a cover for it.
            const detail = row.status === "failed" ? row.verdict : undefined
            const message = phase === "failed"
              ? `The run failed on your workspace: ${detail ?? "the card has what the gateway reported."}`
              : "The run was cancelled."
            patchRunCard(
              cardId,
              { phase, steps, lastSeq: row.updatedAt, waiting: undefined, steeringPending, ...(transcriptRows === undefined ? {} : { transcriptRows }), ...(events === undefined ? {} : { events }), ...(detail === undefined ? {} : { error: detail }) },
              "error"
            )
            store.dispatch({ type: "message.appended", actor: "system", text: message })
          }
          return
        }

        /*
         * Real movement resets the quiet clock: new activity, or a run that
         * CHANGED what it says about itself. A summary that keeps answering
         * the same "running" is not progress — that is precisely the state the
         * quiet bound exists for.
         */
        if (newSteps.length > 0 || previous === undefined || row.status !== previous.status) {
          lastProgressAt = Date.now()
        }
        previous = row

        patchRunCard(cardId, {
          phase: card.payload.phase === "launching" && newSteps.length === 0 && row.status === "accepted"
            ? card.payload.phase
            : runAwaitsApproval(runId)
            ? "waiting-approval"
            : phase,
          steps: [...card.payload.steps, ...newSteps].slice(-RUN_STEPS_TAIL),
          lastSeq: row.updatedAt,
          waiting,
          steeringPending,
          ...(transcriptRows === undefined ? {} : { transcriptRows }),
          ...(events === undefined ? {} : { events })
        })
        await pokeableWait(cardId, RUN_POLL_MS)
      }
    } finally {
      /*
       * Only tear down THIS pump's registrations. "Stop watching" then "Check
       * again" can start a successor while this one is still unwinding its
       * last await, and an unconditional delete here would strip the live pump
       * out of the registry.
       */
      if (ctx.runPumps.get(cardId) === pump) {
        ctx.pumpPokes.delete(cardId)
        ctx.runPumps.delete(cardId)
      }
    }
  }

  /*
   * The two acts a quiet run offers, both registered commands so the card's
   * buttons dispatch through the one path everything else does.
   */
  const runCardFor = (cardId: string): Extract<Card, { kind: "run-trace" }> | undefined => {
    const card = store.collections.cards.get(cardId)
    return card?.kind === "run-trace" ? card : undefined
  }

  /**
   * Stop watching, and stop the run.
   *
   * The old seam relayed no cancel, so it could only stop watching and had to
   * say so. This one does: the gateway's `Cancel` is durable and cross-process,
   * so the card can honestly say the run was stopped.
   */
  const stopWatchingRun = (cardId: string, reason?: string): string | void => {
    const card = runCardFor(cardId)
    if (card === undefined) return "That isn't a run card."
    const pump = ctx.runPumps.get(cardId)
    if (pump !== undefined) pump.stopped = true
    ctx.runPumps.delete(cardId)
    ctx.pumpPokes.get(cardId)?.()
    void gateway.cancel(card.payload.repo, card.payload.runId, reason).then((cancelled) => {
      patchRunCard(cardId, {
        phase: cancelled.status === "ok" ? "cancelled" : "stopped",
        steps: [
          ...card.payload.steps,
          cancelled.status === "ok" ? "Cancelled this run." : "Stopped watching this run."
        ].slice(-RUN_STEPS_TAIL)
      })
    })
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

  /** Boot reconciliation: a live run card's pump resumes. */
  const resumeWorkflowRuns = (): void => {
    for (const card of liveRunCards()) void pumpWorkflowRun(card.id)
  }
  ctx.resumeWorkflowRuns = resumeWorkflowRuns

  const stopWorkflowPumps = (): void => {
    for (const pump of ctx.runPumps.values()) pump.stopped = true
    ctx.runPumps.clear()
    ctx.pumpPokes.clear()
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
