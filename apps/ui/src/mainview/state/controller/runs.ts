/*
 * Lane runs — the run lifecycle beyond launch and cancel.
 *
 * `flow.run` launches a run and its card tracks it; this controller is
 * everything an operator does with a run after that: the inbox of every run
 * on the workspace (runs.list), opening one as a card (runs.open), the
 * lifecycle acts (resume, rerun, signal, the steer family), the facets a run
 * card grows (transcript with follow, the verbose events tab), stopping them
 * all, the trace's reader gestures (runs.trace.filter / runs.trace.select,
 * factory spec 06 §6), and the workspace approvals inbox (approvals.list /
 * approvals.open).
 *
 * Every read is a projection and every act a control procedure over the one
 * gateway seam (gateway.ts); nothing here invents a wire. What the wire does
 * not carry, the flows refuse honestly: `by=` names a launcher the run
 * summary does not record, so runs.list says that instead of silently
 * dropping the filter.
 */
import type { TraceFilter, TraceView } from "../../cards/RunTrace"
import { traceFromJournal } from "../../cards/RunTrace"
import { codingPlanOf } from "../../cards/CodingPlan"
import type { CommandResult } from "../../flows/Flows"
import type { Card } from "../AppState"
import type { ControllerContext } from "./context"
import type { RunSummaryRow } from "./gateway"
import type { WorkflowController } from "./workflows"
import { gatewayBindingFor, gatewayRunContextFor } from "../RepoContext"

export interface RunsController {
  readonly listRuns: (args: {
    readonly status?: string
    readonly flow?: string
    readonly lineage?: string
    readonly sourceCard?: string
    readonly by?: string
    readonly repo?: string
  }) => Promise<CommandResult>
  readonly openRun: (runId: string, repo?: string) => Promise<CommandResult>
  readonly resumeRun: (runId: string) => Promise<CommandResult>
  readonly rerunRun: (runId: string) => Promise<CommandResult>
  readonly signalRun: (runId: string, name: string, payload?: string) => Promise<CommandResult>
  readonly steerRun: (runId: string, body: string) => Promise<CommandResult>
  readonly steerRunSeat: (runId: string, seat: string) => Promise<CommandResult>
  readonly steerRunThinking: (runId: string, thinking: string) => Promise<CommandResult>
  readonly steerRunTools: (runId: string, toolNames: string) => Promise<CommandResult>
  readonly showRunLogs: (runId: string, follow?: boolean) => Promise<CommandResult>
  readonly showRunSteps: (runId: string) => CommandResult
  readonly showRunEvents: (runId: string) => Promise<CommandResult>
  /** `runs.trace.filter <runId> <filter>`: the trace's active filter, in the card payload (spec 06 §5, §6). */
  readonly traceFilter: (runId: string, filter: TraceFilter) => CommandResult
  /** `runs.trace.select <runId> <nodeId> [seq]`: the trace's selection and scrub cursor; leaves live tail. */
  readonly traceSelect: (runId: string, nodeId: string, seq?: number) => CommandResult
  readonly traceView: (runId: string, view: TraceView) => CommandResult
  readonly traceLive: (runId: string) => CommandResult
  readonly selectCodingChange: (runId: string, changeId: string) => CommandResult
  readonly stopAllRuns: (repo?: string) => Promise<CommandResult>
  readonly listApprovals: (repo?: string) => Promise<CommandResult>
  readonly openApproval: (runId: string) => Promise<CommandResult>
}

/** The card id a run's card has always had. */
const runCardId = (runId: string): string => `flow-run-${runId}`

/** Why a run is not moving, in one word the card can render. */
const waitingWord = (row: RunSummaryRow): string | undefined =>
  row.status === "accepted"
    // The CLI's own render-time convention: accepted means nothing is driving it yet.
    ? "executor"
    : row.status === "parked"
    ? row.waitingReason ?? "parked"
    : undefined

export const createRunsController = (
  ctx: ControllerContext,
  nextTranscriptOrdinal: () => number,
  workflows: WorkflowController
): RunsController => {
  const { store, gateway } = ctx

  const runCardFor = (runId: string): Extract<Card, { kind: "run-trace" }> | undefined => {
    const card = store.collections.cards.get(runCardId(runId))
    return card?.kind === "run-trace" ? card : undefined
  }

  const patchRunCard = (
    runId: string,
    patch: Partial<Extract<Card, { kind: "run-trace" }>["payload"]>
  ): void => {
    const card = runCardFor(runId)
    if (card === undefined) return
    store.dispatch({
      type: "card.updated",
      actor: "system",
      id: card.id,
      patch: { payload: { ...card.payload, ...patch } }
    })
  }

  /** Wake the run's pump so an act's effect shows on the card this cycle, not next poll. */
  const pokeRun = (runId: string): void => {
    ctx.pumpPokes.get(runCardId(runId))?.()
  }

  /**
   * Where a run-id act aims: the run card's own repo when the card is in hand,
   * the loaded-repository answer otherwise (the loaded set is the universe).
   */
  const repoForRun = (
    runId: string,
    preferred?: string
  ): { readonly repo: string } | { readonly error: string } => {
    if (preferred !== undefined) return { repo: preferred }
    const recorded = gatewayRunContextFor(store, runId)
    if (recorded !== undefined) return recorded
    return workflows.workflowTargetRepo()
  }

  const listRuns = async (args: {
    readonly status?: string
    readonly flow?: string
    readonly lineage?: string
    readonly sourceCard?: string
    readonly by?: string
    readonly repo?: string
  }): Promise<CommandResult> => {
    const guard = workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    /*
     * The wire's run summary carries no launcher principal, and Control.list
     * refuses the filter — so a by= the app silently dropped would list runs
     * the human asked to exclude. Refuse in words instead.
     */
    if (args.by !== undefined) {
      return "Runs don't record who launched them on this wire, so there is no by= to filter with — status, flow, and lineage are the filters that exist."
    }
    const target = workflows.workflowTargetRepo(args.repo)
    if ("error" in target) return target.error
    const repo = target.repo
    const source = args.sourceCard === undefined ? undefined : store.collections.cards.get(args.sourceCard)
    if (args.sourceCard !== undefined && (source?.kind !== "run-list" || source.payload.repo !== repo)) {
      return "The run list is unavailable or belongs to another repository."
    }
    const binding = source?.kind === "run-list"
      ? (source.payload.workspaceId === undefined ? {} : { workspaceId: source.payload.workspaceId })
      : gatewayBindingFor(store, repo)
    if ("error" in binding) return binding.error
    const provisioned = await workflows.provisionWorkspace(repo, binding)
    if (provisioned !== true) return provisioned
    const listed = await gateway.workspaceRuns(repo, binding)
    if (listed.status !== "ok") return listed.message
    const rows = listed.value
      .filter((row) =>
        (args.status === undefined || row.status === args.status) &&
        (args.flow === undefined || row.flowId === args.flow) &&
        (args.lineage === undefined || row.lineageId === args.lineage)
      )
      .sort((left, right) => right.createdAt - left.createdAt)
    const cardId = `run-list-${repo}${binding.workspaceId === undefined ? "" : `-${binding.workspaceId}`}`
    const existing = store.collections.cards.get(cardId)
    const card: Card = {
      id: cardId,
      kind: "run-list",
      title: `Runs — ${repo}`,
      status: "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? nextTranscriptOrdinal(),
      payload: {
        repo, ...binding,
        ...(args.status === undefined ? {} : { status: args.status }),
        ...(args.flow === undefined ? {} : { flow: args.flow }),
        ...(args.lineage === undefined ? {} : { lineage: args.lineage }),
        // Every status the UNFILTERED workspace carries, so the filter chips (and "All") survive a single-status filter.
        statuses: [...new Set(listed.value.map((row) => row.status))].sort(),
        runs: rows.map((row) => ({
          runId: row.runId,
          flowId: row.flowId,
          status: row.status,
          ...(waitingWord(row) === undefined ? {} : { waiting: waitingWord(row) }),
          createdAt: row.createdAt,
          turns: row.turns,
          calls: row.calls
        }))
      }
    }
    store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card })
    return {
      value: rows.length === 0
        ? `No runs on ${repo} match.`
        : `${rows.length} run${rows.length === 1 ? "" : "s"} on ${repo}.`
    }
  }

  const openRun = async (runId: string, repoArg?: string): Promise<CommandResult> => {
    const guard = workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    const target = repoForRun(runId, repoArg)
    if ("error" in target) return target.error
    const repo = target.repo
    const binding = gatewayBindingFor(store, repo, runId)
    if ("error" in binding) return binding.error
    const provisioned = await workflows.provisionWorkspace(repo, binding)
    if (provisioned !== true) return provisioned
    const summary = await gateway.run(repo, runId, binding)
    if (summary.status !== "ok") return summary.message
    if (summary.value === undefined) return `There's no run ${runId} on ${repo}.`
    const row = summary.value
    workflows.upsertRunCard({
      runId,
      repo,
      ...binding,
      workflow: row.flowId,
      title: `${row.flowId} — ${repo}`,
      firstStep: `Watching ${row.flowId} (run ${runId}).`
      /*
       * No `input`: this run was not launched from here, so its launch input
       * is not recorded on this client — `runs.rerun` says so honestly rather
       * than relaunching with a guessed one.
       */
    })
    return { value: `run-opened run=${runId} repo=${repo}` }
  }

  const resumeRun = async (runId: string): Promise<CommandResult> => {
    const guard = workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    const target = repoForRun(runId)
    if ("error" in target) return target.error
    const card = runCardFor(runId)
    const resumed = await gateway.resume(
      target.repo,
      runId,
      card?.payload.waiting === "executor" ? "Nothing was driving the run." : undefined
    )
    if (resumed.status !== "ok") return resumed.message
    pokeRun(runId)
    return { value: `resume-requested run=${runId}` }
  }

  const rerunRun = async (runId: string): Promise<CommandResult> => {
    const guard = workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    const card = runCardFor(runId)
    if (card === undefined) {
      return `Open the run first (runs.open ${runId}) — rerunning needs the card that knows the flow and its launch input.`
    }
    if (card.payload.input === undefined) {
      return `This run's launch input isn't recorded on this client, so there's nothing faithful to rerun — start the flow fresh with flow.run ${card.payload.workflow}.`
    }
    const repo = card.payload.repo
    const binding = gatewayBindingFor(store, repo, runId)
    if ("error" in binding) return binding.error
    const provisioned = await workflows.provisionWorkspace(repo, binding)
    if (provisioned !== true) return provisioned
    const launched = await workflows.launchWorkflow({
      repo,
      binding,
      workflow: card.payload.workflow,
      input: card.payload.input,
      title: `${card.payload.workflow} — ${repo}`
    })
    if ("message" in launched) return launched.message
    return { value: `run-started workflow=${card.payload.workflow} run=${launched.runId} repo=${repo}` }
  }

  const signalRun = async (runId: string, name: string, payloadText?: string): Promise<CommandResult> => {
    const guard = workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    if (name.trim() === "") return "runs.signal needs the signal's name."
    let payload: unknown = {}
    if (payloadText !== undefined && payloadText.trim() !== "") {
      try {
        payload = JSON.parse(payloadText)
      } catch {
        return `That signal payload isn't JSON: ${payloadText}`
      }
    }
    const target = repoForRun(runId)
    if ("error" in target) return target.error
    const signaled = await gateway.signal(target.repo, runId, name.trim(), payload)
    if (signaled.status !== "ok") return signaled.message
    pokeRun(runId)
    return { value: `signal-sent run=${runId} signal=${name.trim()}` }
  }

  const steer = async (
    runId: string,
    item:
      | { readonly kind: "Message"; readonly body: string }
      | { readonly kind: "Seat"; readonly seat: string }
      | { readonly kind: "Thinking"; readonly thinking: string }
      | { readonly kind: "Tools"; readonly toolNames: ReadonlyArray<string> }
  ): Promise<CommandResult> => {
    const guard = workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    const target = repoForRun(runId)
    if ("error" in target) return target.error
    const steered = await gateway.steer(target.repo, runId, item)
    if (steered.status !== "ok") return steered.message
    patchRunCard(runId, { steeringPending: true })
    pokeRun(runId)
    return { value: `steered run=${runId}` }
  }

  const steerRun = (runId: string, body: string): Promise<CommandResult> =>
    body.trim() === ""
      ? Promise.resolve("runs.steer needs the message to deliver.")
      : steer(runId, { kind: "Message", body })

  const steerRunSeat = (runId: string, seat: string): Promise<CommandResult> =>
    seat.trim() === ""
      ? Promise.resolve("runs.seat needs the seat to move the run to.")
      : steer(runId, { kind: "Seat", seat: seat.trim() })

  const steerRunThinking = (runId: string, thinking: string): Promise<CommandResult> =>
    thinking.trim() === ""
      ? Promise.resolve("runs.thinking needs the thinking level.")
      : steer(runId, { kind: "Thinking", thinking: thinking.trim() })

  const steerRunTools = (runId: string, toolNames: string): Promise<CommandResult> => {
    const names = toolNames.split(",").map((name) => name.trim()).filter((name) => name !== "")
    return names.length === 0
      ? Promise.resolve("runs.tools needs the tool names, comma-separated.")
      : steer(runId, { kind: "Tools", toolNames: names })
  }

  /**
   * The transcript facet. `--follow` toggles the live merge (the pump keeps
   * the rows current while the run moves); without it the tab is one snapshot
   * of where the transcript stood when asked.
   */
  const showRunLogs = async (runId: string, follow?: boolean): Promise<CommandResult> => {
    const guard = workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    const card = runCardFor(runId)
    if (card === undefined) return `Open the run first (runs.open ${runId}) — the transcript lives on its card.`
    const target = repoForRun(runId)
    if ("error" in target) return target.error
    const following = follow === true ? card.payload.follow !== true : false
    const transcript = await gateway.transcript(target.repo, runId)
    if (transcript.status !== "ok") return transcript.message
    patchRunCard(runId, {
      facet: "transcript",
      follow: following,
      transcriptRows: transcript.value.map((row) => ({
        sequence: row.sequence,
        ...(row.turn === undefined ? {} : { turn: row.turn }),
        ...(row.at === undefined ? {} : { at: row.at }),
        kind: row.kind,
        text: row.text
      }))
    })
    if (following) pokeRun(runId)
    return { value: following ? `following run=${runId}` : `transcript run=${runId}` }
  }

  /** Back to the default facet; unfollows the transcript if it was following. */
  const showRunSteps = (runId: string): CommandResult => {
    const card = runCardFor(runId)
    if (card === undefined) return `Open the run first (runs.open ${runId}).`
    patchRunCard(runId, { facet: "steps", follow: false })
    return { value: `steps run=${runId}` }
  }

  /** The raw journal, a debug surface: it exists only where verbose does. */
  const showRunEvents = async (runId: string): Promise<CommandResult> => {
    const guard = workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    if (store.session().verbose !== true) {
      return "The events tab is the run's raw journal — a debug view. Turn on /debug.verbose first."
    }
    const card = runCardFor(runId)
    if (card === undefined) return `Open the run first (runs.open ${runId}) — the events live on its card.`
    const target = repoForRun(runId)
    if ("error" in target) return target.error
    const events = await gateway.runEvents(target.repo, runId)
    if (events.status !== "ok") return events.message
    patchRunCard(runId, {
      facet: "events",
      events: events.value.map((event) => ({ ...(event as unknown as Record<string, unknown>) }))
    })
    return { value: `events run=${runId}` }
  }

  /*
   * The trace's reader gestures (spec 06 §6). Both change the card payload
   * alone (§5: the trace, selection, cursor, filters and live-tail flag live
   * there), so the tree, the waterfall and the pane re-render from one record
   * and no request leaves the browser. The pump keeps the journal current on
   * its own cycle.
   */
  const traceFilter = (runId: string, filter: TraceFilter): CommandResult => {
    const card = runCardFor(runId)
    if (card === undefined) return `Open the run first (runs.open ${runId}): the trace lives on its card.`
    store.dispatch({
      type: "card.updated",
      actor: ctx.commandActor,
      id: card.id,
      patch: { payload: { ...card.payload, filter } }
    })
    return { value: `trace-filter run=${runId} filter=${filter}` }
  }

  const traceSelect = (runId: string, nodeId: string, seq?: number): CommandResult => {
    const card = runCardFor(runId)
    if (card === undefined) return `Open the run first (runs.open ${runId}): the trace lives on its card.`
    // The node must be one the journal in hand folds to; a made-up id selects nothing, so say so.
    const { workflow, phase, kind, events } = card.payload
    const latest = (events ?? []).reduce(
      (max, record) => typeof record.sequence === "number" ? Math.max(max, record.sequence) : max,
      0
    )
    const cursorSeq = seq ?? card.payload.cursorSeq ?? latest
    if (!Number.isSafeInteger(cursorSeq) || cursorSeq < 0 || cursorSeq > latest) {
      return `Run ${runId} has no recorded journal sequence ${cursorSeq}.`
    }
    const records = (events ?? []).filter((record) =>
      typeof record.sequence === "number" && record.sequence <= cursorSeq
    )
    const model = traceFromJournal({
      runId,
      flowId: workflow,
      status: cursorSeq < latest ? "running" : phase,
      ...(kind === undefined ? {} : { kind })
    }, records)
    if (!model.rows.some((span) => span.id === nodeId)) return `Run ${runId} has no trace node ${nodeId}.`
    // A selection is the reader's focus: it leaves live tail (§2) until the reader resumes it.
    store.dispatch({
      type: "card.updated",
      actor: ctx.commandActor,
      id: card.id,
      patch: { payload: { ...card.payload, selection: nodeId, liveTail: false, cursorSeq } }
    })
    return { value: `trace-select run=${runId} node=${nodeId}${seq === undefined ? "" : ` seq=${seq}`}` }
  }

  const selectCodingChange = (runId: string, changeId: string): CommandResult => {
    const card = runCardFor(runId)
    if (card === undefined) return `Open the run first (runs.open ${runId}): its plan lives on the card.`
    if (!codingPlanOf(card)?.changes.some((change) => change.id === changeId)) return `Run ${runId} has no recorded planned Change ${changeId}.`
    const { codingChangeId: previous, ...payload } = card.payload
    const selected = previous === changeId ? {} : { codingChangeId: changeId }
    store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card: { ...card, payload: { ...payload, ...selected } } })
    return { value: `coding-plan-selection run=${runId} change=${previous === changeId ? "none" : changeId}` }
  }

  const traceView = (runId: string, view: TraceView): CommandResult => {
    const card = runCardFor(runId)
    if (card === undefined) return `Open the run first (runs.open ${runId}): the trace lives on its card.`
    store.dispatch({
      type: "card.updated",
      actor: ctx.commandActor,
      id: card.id,
      patch: { payload: { ...card.payload, traceView: view } }
    })
    return { value: `trace-view run=${runId} view=${view}` }
  }

  const traceLive = (runId: string): CommandResult => {
    const card = runCardFor(runId)
    if (card === undefined) return `Open the run first (runs.open ${runId}): the trace lives on its card.`
    const { selection: _selection, cursorSeq: _cursorSeq, ...payload } = card.payload
    // card.updated merges payload fields. Replace the card to remove the cursor
    // durably: undefined patch values would disappear in the JSON journal.
    store.dispatch({
      type: "card.upsert",
      actor: ctx.commandActor,
      card: { ...card, payload: { ...payload, liveTail: true } }
    })
    return { value: `trace-live run=${runId}` }
  }

  /** Stop every live run card's run — one workspace's, when named. Each cancel is durable; the cards settle from the pump. */
  /** The wire statuses the run inbox counts as live (mirrors RunsCards LIVE_STATUSES). */
  const RUN_LIST_LIVE_STATUSES: ReadonlySet<string> = new Set(["accepted", "running", "parked", "waiting-approval"])
  const stopAllRuns = async (repoArg?: string): Promise<CommandResult> => {
    const guard = workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    /*
     * The button reads "Stop all N" off the run inbox's rows, so the act
     * cancels THOSE rows — the wire's live runs under the inbox's active
     * filter — never just the runs this client happens to hold cards for.
     * With no inbox open, the client's live cards are the only known set.
     */
    const inboxes = [...store.collections.cards.values()].filter(
      (card) => card.kind === "run-list" && (repoArg === undefined || card.payload.repo === repoArg)
    ) as Array<Extract<Card, { kind: "run-list" }>>
    const live: Array<{ readonly repo: string; readonly runId: string }> = inboxes.length > 0
      ? inboxes.flatMap((card) =>
        card.payload.runs
          .filter((run) => RUN_LIST_LIVE_STATUSES.has(run.status))
          .map((run) => ({ repo: card.payload.repo, runId: run.runId }))
      )
      : ([...store.collections.cards.values()].filter(
        (card) =>
          card.kind === "run-trace" &&
          (card.payload.phase === "launching" ||
            card.payload.phase === "running" ||
            card.payload.phase === "waiting-approval" ||
            card.payload.phase === "reconnecting")
      ) as Array<Extract<Card, { kind: "run-trace" }>>)
        .filter((card) => repoArg === undefined || card.payload.repo === repoArg)
        .map((card) => ({ repo: card.payload.repo, runId: card.payload.runId }))
    if (live.length === 0) return repoArg === undefined ? "No runs are live." : `No runs are live on ${repoArg}.`
    let stopped = 0
    let firstRefusal: string | undefined
    for (const card of live) {
      const cancelled = await gateway.cancel(card.repo, card.runId, "the human stopped every run")
      if (cancelled.status === "ok") {
        stopped += 1
      } else if (firstRefusal === undefined) {
        firstRefusal = cancelled.message
      }
    }
    return {
      value: `stop-all stopped=${stopped} of ${live.length}${
        firstRefusal === undefined ? "" : ` — first refusal: ${firstRefusal}`
      }`
    }
  }

  const listApprovals = async (repoArg?: string): Promise<CommandResult> => {
    const guard = workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    const target = workflows.workflowTargetRepo(repoArg)
    if ("error" in target) return target.error
    const repo = target.repo
    const binding = gatewayBindingFor(store, repo)
    if ("error" in binding) return binding.error
    const provisioned = await workflows.provisionWorkspace(repo, binding)
    if (provisioned !== true) return provisioned
    const inbox = await gateway.approvalsInbox(repo, binding)
    if (inbox.status !== "ok") return inbox.message
    const pending = inbox.value.filter((row) => row.status === "pending")
    const cardId = `approvals-inbox-${repo}${binding.workspaceId === undefined ? "" : `-${binding.workspaceId}`}`
    const existing = store.collections.cards.get(cardId)
    const prior = existing?.kind === "approvals-inbox" ? existing.payload.approvals : []
    const card: Card = {
      id: cardId,
      kind: "approvals-inbox",
      title: `Approvals — ${repo}`,
      status: "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? nextTranscriptOrdinal(),
      payload: {
        repo, ...binding,
        approvals: pending.map((row) => {
          // A row's recorded decision survives a refresh: the freeze is the
          // server's answer, not something a re-list may thaw.
          const before = prior.find((entry) => entry.requestId === row.requestId)
          return {
            runId: row.runId,
            requestId: row.requestId,
            title: row.title,
            approval: row.payload as Record<string, unknown>,
            requestedAt: row.requestedAt,
            ...(before?.decision === undefined ? {} : { decision: before.decision }),
            ...(before?.decidedAt === undefined ? {} : { decidedAt: before.decidedAt }),
            ...(before?.decisionError === undefined ? {} : { decisionError: before.decisionError })
          }
        })
      }
    }
    store.dispatch({ type: "card.upsert", actor: "system", card })
    return {
      value: pending.length === 0
        ? `No approvals are pending on ${repo}.`
        : `${pending.length} approval${pending.length === 1 ? "" : "s"} pending on ${repo}.`
    }
  }

  /**
   * Bring one run's pending gates into the transcript as approval cards —
   * the same cards the pump would have upserted, so deciding them rides the
   * existing per-card path (`approval.approve` / `approval.deny`) unchanged.
   */
  const openApproval = async (runId: string): Promise<CommandResult> => {
    const guard = workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    const target = repoForRun(runId)
    if ("error" in target) return target.error
    const repo = target.repo
    const binding = gatewayBindingFor(store, repo, runId)
    if ("error" in binding) return binding.error
    const alreadyOpen = [...store.collections.cards.values()].filter(
      (card) =>
        store.approvalRequest(card.id) !== undefined && card.kind === "approval" && card.payload.runId === runId &&
        card.payload.decision === undefined
    )
    if (alreadyOpen.length > 0) {
      return {
        value: `${alreadyOpen.length} approval card${
          alreadyOpen.length === 1 ? " is" : "s are"
        } already open for run ${runId}.`
      }
    }
    const provisioned = await workflows.provisionWorkspace(repo, binding)
    if (provisioned !== true) return provisioned
    const approvals = await gateway.approvals(repo, runId, binding)
    if (approvals.status !== "ok") return approvals.message
    const pending = approvals.value.filter((row) => row.status === "pending")
    if (pending.length === 0) return `Run ${runId} has no approvals pending.`
    for (const approval of pending) {
      const card: Card = {
        id: `approval-${runId}-${approval.requestId}`,
        kind: "approval",
        title: approval.title,
        status: "active",
        createdAt: Date.now(),
        ordinal: nextTranscriptOrdinal(),
        payload: {
          capability: approval.title,
          runId,
          requestId: approval.requestId,
          approval: approval.payload as Record<string, unknown>,
          repo, ...binding
        }
      }
      store.dispatch({ type: "card.upsert", actor: "system", card })
    }
    return { value: `${pending.length} approval${pending.length === 1 ? "" : "s"} opened for run ${runId}.` }
  }

  return {
    listRuns,
    openRun,
    resumeRun,
    rerunRun,
    signalRun,
    steerRun,
    steerRunSeat,
    steerRunThinking,
    steerRunTools,
    showRunLogs,
    showRunSteps,
    showRunEvents,
    traceFilter,
    traceSelect,
    selectCodingChange,
    traceView,
    traceLive,
    stopAllRuns,
    listApprovals,
    openApproval
  }
}
