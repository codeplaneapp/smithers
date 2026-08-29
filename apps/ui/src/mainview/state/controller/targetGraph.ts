/*
 * The target-graph controller (docs/LOCAL-APP.md "Cards: target graph"): the
 * chat commands' door to the five graph cards. `show graph` loads the typed
 * DAG into a graph card (focused on a label when one is named); a run started
 * while a graph card is up overlays its node frames live; `timeline` streams
 * one run's Gantt; `history` lists the recorded runs and selecting one
 * replays its events — the scrubber re-derives the timeline and the graph
 * overlay at the cursor; `affected` and `show ci` fill their cards from the
 * routes in smithers-shared/TargetGraph TARGET_GRAPH_ROUTES. Every store
 * change goes through the dispatcher with its actor; while the backend's
 * routes land in parallel, an explicit dev flag (dev/fixtureRunStream.ts)
 * swaps the routes for the captured fixtures — never in the product path.
 */
import type { TargetRunFrame } from "smithers-shared/LocalApp"
import type {
  AffectedResponse,
  CiMatrixResponse,
  NodeTiming,
  RunHistoryResponse,
  RunReplayResponse,
  RunSummary,
  TargetRunEvent
} from "smithers-shared/TargetGraph"
import {
  AffectedResponseSchema,
  CiMatrixResponseSchema,
  RunHistoryResponseSchema,
  RunReplayResponseSchema,
  TARGET_GRAPH_ROUTES,
  TargetGraphResponseSchema
} from "smithers-shared/TargetGraph"
import type { Card } from "../AppState"
import type { TargetRunClient } from "../TargetRunClient"
import type { TargetGraphDevFixtures } from "../../dev/fixtureRunStream"
import type { ControllerContext } from "./context"

export interface TargetGraphController {
  /** `show graph` / `graph <label>`: the DAG card, optionally focused on one label. */
  readonly showGraph: (repoId: string | undefined, label?: string) => Promise<string | void>
  /** The drawer's focus: pin the graph card on one label, or clear it when the label goes unnamed. */
  readonly focusGraph: (repoId: string | undefined, label?: string) => string | void
  /** `timeline [runId]`: one run's Gantt card, streamed live when the run is live. */
  readonly showTimeline: (repoId: string | undefined, runId?: string) => Promise<string | void>
  /** `history`: the recorded runs table. */
  readonly showHistory: (repoId: string | undefined) => Promise<string | void>
  /** A history row: replay the recorded run into a timeline card (with the scrubber) and the graph overlay. */
  readonly selectRun: (repoId: string | undefined, runId: string) => Promise<string | void>
  /** The scrubber: re-derive the timeline and the overlay at the cursor (time travel). */
  readonly scrubRun: (runId: string, cursor: number) => string | void
  /** `affected`: the working-tree diff's changed files and the labels they re-key. */
  readonly showAffected: (repoId: string | undefined) => Promise<string | void>
  /** `show ci`: the generated GitHub workflows/jobs/matrix card. */
  readonly showCi: (repoId: string | undefined) => Promise<string | void>
  /** targets.runTarget's hook: a live run paints any graph card of its repo. */
  readonly noteRunStarted: (repoId: string, runId: string, label: string) => void
  /** The drawer's "open" affordance: hand the declaration site to the backend. */
  readonly openSource: (repoId: string, file: string, line?: number) => Promise<string | void>
}

export interface TargetGraphControllerDependencies {
  readonly nextOrdinal: () => number
  readonly runs: TargetRunClient
  /** Dev-only fixture seam (dev/fixtureRunStream.ts); undefined outside the explicit flag. */
  readonly devFixtures?: TargetGraphDevFixtures | undefined
}

export const graphCardId = (repoId: string): string => `graph-${repoId}`
export const runTimelineCardId = (runId: string): string => `run-timeline-${runId}`
export const runHistoryCardId = (repoId: string): string => `run-history-${repoId}`
export const affectedCardId = (repoId: string): string => `affected-${repoId}`
export const ciMatrixCardId = (repoId: string): string => `ci-${repoId}`

/*
 * A per-node log tail cap, matching controller/targets.ts: these logs ride in
 * a card payload, and card payloads are persisted, so a chatty node must not
 * grow the store without bound. The TAIL is what a human reads.
 */
const MAX_LOG_CHARS = 200_000
const capLog = (text: string): string => (text.length > MAX_LOG_CHARS ? text.slice(text.length - MAX_LOG_CHARS) : text)

/** The replay fold: every recorded frame up to the cursor, as timeline/overlay state. */
export const replayAtCursor = (
  events: ReadonlyArray<TargetRunEvent>,
  cursor: number
): { readonly nodes: Array<NodeTiming>; readonly summary: RunSummary | undefined; readonly logs: Record<string, string>; readonly error: string | undefined } => {
  const nodes = new Map<string, NodeTiming>()
  const logs: Record<string, string> = {}
  let summary: RunSummary | undefined
  let error: string | undefined
  /*
   * stdout/stderr (and exit/error) frames carry no `at` of their own. They are
   * recorded IN ORDER, so an untimed frame happened at the clock of the last
   * timed frame before it — without that carry the cursor would gate the node
   * frames but let every log line through, and scrubbing to the start of a run
   * would show output the run had not produced yet.
   */
  let clock = Number.NEGATIVE_INFINITY
  for (const event of events) {
    if ("at" in event) clock = event.at
    if (clock > cursor) continue
    if (event.type === "node") nodes.set(event.node.label, event.node)
    else if (event.type === "summary") summary = event.summary
    else if (event.type === "error") error = event.message
    else if (event.type === "exit" && event.code !== 0 && error === undefined) error = event.code === null ? "The run ended without an exit code." : `The run exited ${event.code}.`
    else if ((event.type === "stdout" || event.type === "stderr") && event.label !== undefined) {
      logs[event.label] = capLog((logs[event.label] ?? "") + event.data)
    }
  }
  return { nodes: [...nodes.values()], summary, logs, error }
}

/** A live frame folds into the same per-run state the replay fold produces. */
export const foldRunFrame = (
  state: { nodes: Map<string, NodeTiming>; summary: RunSummary | undefined; logs: Map<string, string>; error?: string },
  frame: TargetRunFrame
): void => {
  if (frame.type === "node") state.nodes.set(frame.node.label, frame.node)
  else if (frame.type === "summary") state.summary = frame.summary
  else if (frame.type === "error") state.error = frame.message
  else if (frame.type === "exit" && frame.code !== 0 && state.error === undefined) state.error = frame.code === null ? "The run ended without an exit code." : `The run exited ${frame.code}.`
  else if ((frame.type === "stdout" || frame.type === "stderr") && "label" in frame && frame.label !== undefined) {
    state.logs.set(frame.label, capLog((state.logs.get(frame.label) ?? "") + frame.data))
  }
}

export const createTargetGraphController = (
  ctx: ControllerContext,
  dependencies: TargetGraphControllerDependencies
): TargetGraphController => {
  const { store, baseUrl } = ctx
  const { nextOrdinal, runs, devFixtures } = dependencies
  /** Recorded/replayed events per runId, for the scrubber. */
  const replayEvents = new Map<string, ReadonlyArray<TargetRunEvent>>()
  /** Live folds per runId, shared by the graph overlay and the timeline card. */
  const liveRuns = new Map<string, { nodes: Map<string, NodeTiming>; summary: RunSummary | undefined; logs: Map<string, string>; error?: string }>()

  const upsert = (card: Card): void => {
    store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card })
  }

  const patch = <K extends Card["kind"]>(
    id: string,
    kind: K,
    update: (card: Extract<Card, { kind: K }>) => { payload: Extract<Card, { kind: K }>["payload"]; status?: Card["status"] }
  ): void => {
    const existing = store.collections.cards.get(id)
    if (existing === undefined || existing.kind !== kind) return
    const next = update(existing as unknown as Extract<Card, { kind: K }>)
    store.dispatch({
      type: "card.updated",
      actor: "system",
      id,
      patch: { payload: next.payload, ...(next.status === undefined ? {} : { status: next.status }) }
    })
  }

  /** The repo a command names, or the one open repo when it goes unnamed. */
  const resolveRepoId = (repoId: string | undefined): string | { readonly error: string } => {
    if (repoId !== undefined && repoId !== "") return repoId
    const repos = [...store.collections.cards.values()].filter((card) => card.kind === "repo")
    if (repos.length === 1) {
      const only = repos[0] as Extract<Card, { kind: "repo" }>
      return only.payload.repo.id
    }
    return {
      error: repos.length === 0
        ? "Open a repository first — there is no graph to show."
        : "Name the repository: more than one is open."
    }
  }

  const post = async <T>(
    route: string,
    body: unknown,
    schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
    shapeError: string
  ): Promise<T | { readonly error: string }> => {
    let response: Response
    try {
      response = await ctx.boundedFetch(`${baseUrl}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      })
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
    if (!response.ok) return { error: await ctx.errorMessageOf(response, `The request answered ${response.status}`) }
    const parsed = schema.safeParse(await response.json().catch(() => undefined))
    if (!parsed.success || parsed.data === undefined) return { error: shapeError }
    return parsed.data
  }

  /** Paint a live fold into the graph overlay and the timeline card of one run. */
  const paintRun = (repoId: string, runId: string): void => {
    const fold = liveRuns.get(runId)
    if (fold === undefined) return
    const nodes = [...fold.nodes.values()]
    const summary = fold.summary
    patch(graphCardId(repoId), "graph", (card) => ({
      payload: { ...card.payload, runId, run: { nodes, ...(summary === undefined ? {} : { summary }) } }
    }))
    const timelineId = runTimelineCardId(runId)
    if (store.collections.cards.get(timelineId)?.kind === "run-timeline") {
      patch(timelineId, "run-timeline", (card) => ({
        payload: {
          ...card.payload,
          status: fold.error !== undefined ? "failed" : summary !== undefined ? (summary.ok ? "done" : "failed") : "running",
          nodes,
          ...(summary === undefined ? {} : { summary }),
          logs: Object.fromEntries(fold.logs),
          ...(fold.error === undefined ? {} : { error: fold.error })
        }
      }))
    }
  }

  /*
   * Attach one run's frames into the overlay and (when open) its timeline card.
   *
   * The attachment has to be RELEASED when the run exits. TargetRunClient keeps
   * a topic subscribed while any listener is registered and re-announces
   * `target-run.attach` for every live topic after a reconnect, so a listener
   * left on a finished run makes the app re-attach to dead runs forever. The
   * accumulated fold outlives the attachment on purpose: a timeline card opened
   * after the run settled still paints from it.
   */
  const detachers = new Map<string, () => void>()
  const releaseRun = (runId: string): void => {
    const detach = detachers.get(runId)
    if (detach === undefined) return
    detachers.delete(runId)
    detach()
  }
  const watchRun = (repoId: string, runId: string, label: string): void => {
    if (liveRuns.has(runId)) return
    liveRuns.set(runId, { nodes: new Map(), summary: undefined, logs: new Map() })
    const onFrame = (frame: TargetRunFrame): void => {
      const fold = liveRuns.get(runId)
      if (fold === undefined) return
      foldRunFrame(fold, frame)
      paintRun(repoId, runId)
      if (frame.type === "exit") releaseRun(runId)
    }
    detachers.set(runId, devFixtures !== undefined ? devFixtures.streamRun(runId, label, onFrame) : runs.attach(runId, onFrame))
  }
  ctx.onDispose(() => {
    for (const runId of [...detachers.keys()]) releaseRun(runId)
  })

  const showGraph: TargetGraphController["showGraph"] = async (repoIdArg, label) => {
    const repoId = resolveRepoId(repoIdArg)
    if (typeof repoId !== "string") return repoId.error
    const id = graphCardId(repoId)
    const repoName = repoId
    upsert({
      id,
      kind: "graph",
      title: `${repoName} graph`,
      status: "active",
      createdAt: Date.now(),
      ordinal: nextOrdinal(),
      payload: { repoId, repoName, status: "pending", ...(label === undefined ? {} : { focus: label }) }
    })
    if (devFixtures !== undefined) {
      const graph = devFixtures.graph(repoId)
      patch(id, "graph", (card) => ({ payload: { ...card.payload, status: "done", graph }, status: "acted" }))
      return
    }
    /*
     * Two phases, deliberately.
     *
     * The DAG and the plan facts used to be ONE request, and `plan: true`
     * with no label plans `//...` — every target in the workspace. On the
     * real force checkout that is ~4.7s for the graph against ~15.9s for
     * graph+plan, and under the load of a real session (the auto-loaded
     * targets card querying the loader at the same time) it crosses the
     * boundedFetch deadline and the card dies with `seam timeout` showing
     * NOTHING — a DAG that was ready in seconds, thrown away for facts only
     * the drawer reads. So: paint the graph as soon as it lands, then patch
     * the plan facts in. The card's final state is unchanged.
     */
    const labels = label === undefined ? {} : { labels: [label] }
    const answer = await post(
      TARGET_GRAPH_ROUTES.graph,
      { repoId, ...labels },
      TargetGraphResponseSchema,
      "The graph route answered an unexpected shape."
    )
    if ("error" in answer) {
      patch(id, "graph", (card) => ({ payload: { ...card.payload, status: "failed", error: answer.error }, status: "error" }))
      return answer.error
    }
    patch(id, "graph", (card) => ({ payload: { ...card.payload, status: "done", graph: answer }, status: "acted" }))

    const planned = await post(
      TARGET_GRAPH_ROUTES.graph,
      { repoId, plan: true, ...labels },
      TargetGraphResponseSchema,
      "The graph route answered an unexpected shape."
    )
    /*
     * A plan that fails leaves the painted graph exactly as it is. The drawer
     * shows the facts it has and omits the ones it does not, which it already
     * does for every node the planner refuses.
     */
    if ("error" in planned) return
    patch(id, "graph", (card) => ({ payload: { ...card.payload, status: "done", graph: planned }, status: "acted" }))
  }

  /*
   * The drawer opens on the card payload's focus, so dismissing it has to
   * clear that focus — local component state alone would let the drawer
   * spring back on the next render of a `graph //src:lint` card.
   */
  const focusGraph: TargetGraphController["focusGraph"] = (repoIdArg, label) => {
    const repoId = resolveRepoId(repoIdArg)
    if (typeof repoId !== "string") return repoId.error
    const id = graphCardId(repoId)
    if (store.collections.cards.get(id)?.kind !== "graph") return "There is no graph card open to focus."
    patch(id, "graph", (card) => {
      const { focus: _cleared, ...rest } = card.payload
      return { payload: label === undefined || label === "" ? rest : { ...rest, focus: label } }
    })
  }

  const showTimeline: TargetGraphController["showTimeline"] = async (repoIdArg, runIdArg) => {
    const repoId = resolveRepoId(repoIdArg)
    if (typeof repoId !== "string") return repoId.error
    if (runIdArg === undefined) return "Name the run to show — pick one from the history card."
    upsert({
      id: runTimelineCardId(runIdArg),
      kind: "run-timeline",
      title: `Run ${runIdArg}`,
      status: "active",
      createdAt: Date.now(),
      ordinal: nextOrdinal(),
      payload: { repoId, runId: runIdArg, label: runIdArg, status: "running", nodes: [] }
    })
    watchRun(repoId, runIdArg, runIdArg)
    /* A run the overlay has been folding since it started is already known; paint it now rather than waiting for the next frame (a settled run has none). */
    paintRun(repoId, runIdArg)
  }

  const showHistory: TargetGraphController["showHistory"] = async (repoIdArg) => {
    const repoId = resolveRepoId(repoIdArg)
    if (typeof repoId !== "string") return repoId.error
    const id = runHistoryCardId(repoId)
    upsert({
      id,
      kind: "run-history",
      title: `${repoId} runs`,
      status: "active",
      createdAt: Date.now(),
      ordinal: nextOrdinal(),
      payload: { repoId, status: "pending", runs: [] }
    })
    const answer = devFixtures !== undefined
      ? devFixtures.history(repoId)
      : await post(
        TARGET_GRAPH_ROUTES.runs,
        { repoId },
        RunHistoryResponseSchema,
        "The runs route answered an unexpected shape."
      )
    if ("error" in answer) {
      patch(id, "run-history", (card) => ({ payload: { ...card.payload, status: "failed", error: answer.error }, status: "error" }))
      return answer.error
    }
    patch(id, "run-history", (card) => ({
      payload: { ...card.payload, status: "done", runs: (answer as RunHistoryResponse).runs },
      status: "acted"
    }))
  }

  const selectRun: TargetGraphController["selectRun"] = async (repoIdArg, runId) => {
    const repoId = resolveRepoId(repoIdArg)
    if (typeof repoId !== "string") return repoId.error
    const answer = devFixtures !== undefined
      ? devFixtures.replay(runId)
      : await post(
        TARGET_GRAPH_ROUTES.replay,
        { runId },
        RunReplayResponseSchema,
        "The replay route answered an unexpected shape."
      )
    if (answer === undefined) return `There is no recording of run ${runId}.`
    if ("error" in answer) return answer.error
    const replay = answer as RunReplayResponse
    replayEvents.set(runId, replay.events)
    /*
     * The end of a run that never recorded `endedAt` is its last timed frame.
     * A fold, never `Math.max(...events)`: a chatty run retains ~10^6 tiny
     * log frames under the store's cap, and spreading a million arguments
     * overflows the call stack — selecting such a run crashed the controller
     * instead of opening its timeline.
     */
    let endCursor = replay.run.startedAt
    if (replay.run.endedAt === undefined) {
      for (const event of replay.events) {
        if ("at" in event && event.at > endCursor) endCursor = event.at
      }
    } else {
      endCursor = replay.run.endedAt
    }
    const state = replayAtCursor(replay.events, endCursor)
    patch(runHistoryCardId(repoId), "run-history", (card) => ({ payload: { ...card.payload, selected: runId } }))
    upsert({
      id: runTimelineCardId(runId),
      kind: "run-timeline",
      title: `${replay.run.label} (replay)`,
      status: "acted",
      createdAt: Date.now(),
      ordinal: nextOrdinal(),
      payload: {
        repoId,
        runId,
        label: replay.run.label,
        status: replay.run.status,
        nodes: state.nodes,
        ...(state.summary === undefined ? {} : { summary: state.summary }),
        ...(state.error === undefined ? {} : { error: state.error }),
        cursor: endCursor,
        extent: { start: replay.run.startedAt, end: endCursor },
        logs: state.logs
      }
    })
    // Time travel paints the graph overlay too, when the graph card is up.
    if (store.collections.cards.get(graphCardId(repoId))?.kind === "graph") {
      patch(graphCardId(repoId), "graph", (card) => ({
        payload: {
          ...card.payload,
          runId,
          run: { nodes: state.nodes, ...(state.summary === undefined ? {} : { summary: state.summary }) }
        }
      }))
    }
  }

  const scrubRun: TargetGraphController["scrubRun"] = (runId, cursor) => {
    const events = replayEvents.get(runId)
    if (events === undefined) return `There is no recording of run ${runId} to scrub.`
    const state = replayAtCursor(events, cursor)
    const cardId = runTimelineCardId(runId)
    const card = store.collections.cards.get(cardId)
    if (card === undefined || card.kind !== "run-timeline") return
    const repoId = card.payload.repoId
    /*
     * Time travel replaces the fold, it does not merge into it: a cursor
     * BEFORE the summary frame has no summary, so spreading the old payload
     * would leave the finished run's totals and critical path painted over a
     * half-replayed run.
     */
    patch(cardId, "run-timeline", (current) => {
      const { summary: _dropped, error: _oldError, ...rest } = current.payload
      return {
        payload: {
          ...rest,
          nodes: state.nodes,
          ...(state.summary === undefined ? {} : { summary: state.summary }),
          ...(state.error === undefined ? {} : { error: state.error }),
          cursor,
          logs: state.logs
        }
      }
    })
    if (store.collections.cards.get(graphCardId(repoId))?.kind === "graph") {
      patch(graphCardId(repoId), "graph", (current) => ({
        payload: {
          ...current.payload,
          runId,
          run: { nodes: state.nodes, ...(state.summary === undefined ? {} : { summary: state.summary }) }
        }
      }))
    }
  }

  const showAffected: TargetGraphController["showAffected"] = async (repoIdArg) => {
    const repoId = resolveRepoId(repoIdArg)
    if (typeof repoId !== "string") return repoId.error
    const id = affectedCardId(repoId)
    upsert({
      id,
      kind: "affected",
      title: `${repoId} affected`,
      status: "active",
      createdAt: Date.now(),
      ordinal: nextOrdinal(),
      payload: { repoId, status: "pending" }
    })
    const answer = devFixtures !== undefined
      ? devFixtures.affected(repoId)
      : await post(
        TARGET_GRAPH_ROUTES.affected,
        { repoId },
        AffectedResponseSchema,
        "The affected route answered an unexpected shape."
      )
    if ("error" in answer) {
      patch(id, "affected", (card) => ({ payload: { ...card.payload, status: "failed", error: answer.error }, status: "error" }))
      return answer.error
    }
    patch(id, "affected", (card) => ({
      payload: { ...card.payload, status: "done", result: answer as AffectedResponse },
      status: "acted"
    }))
  }

  const showCi: TargetGraphController["showCi"] = async (repoIdArg) => {
    const repoId = resolveRepoId(repoIdArg)
    if (typeof repoId !== "string") return repoId.error
    const id = ciMatrixCardId(repoId)
    upsert({
      id,
      kind: "ci-matrix",
      title: `${repoId} CI`,
      status: "active",
      createdAt: Date.now(),
      ordinal: nextOrdinal(),
      payload: { repoId, status: "pending" }
    })
    const answer = devFixtures !== undefined
      ? devFixtures.ci(repoId)
      : await post(
        TARGET_GRAPH_ROUTES.ci,
        { repoId },
        CiMatrixResponseSchema,
        "The CI route answered an unexpected shape."
      )
    if ("error" in answer) {
      patch(id, "ci-matrix", (card) => ({ payload: { ...card.payload, status: "failed", error: answer.error }, status: "error" }))
      return answer.error
    }
    patch(id, "ci-matrix", (card) => ({
      payload: { ...card.payload, status: "done", result: answer as CiMatrixResponse },
      status: "acted"
    }))
  }

  const noteRunStarted: TargetGraphController["noteRunStarted"] = (repoId, runId, label) => {
    if (store.collections.cards.get(graphCardId(repoId))?.kind !== "graph") return
    patch(graphCardId(repoId), "graph", (card) => ({ payload: { ...card.payload, runId } }))
    watchRun(repoId, runId, label)
  }

  const openSource: TargetGraphController["openSource"] = async (repoId, file, line) => {
    const answer = await post(
      TARGET_GRAPH_ROUTES.openSource,
      { repoId, file, ...(line === undefined ? {} : { line }) },
      { safeParse: (value: unknown) => ({ success: true, data: value as Record<string, unknown> }) },
      "The open-source route answered an unexpected shape."
    )
    if (answer !== null && "error" in answer && typeof answer.error === "string") {
      return `Could not open the declaration: ${answer.error}`
    }
  }

  return {
    showGraph,
    focusGraph,
    showTimeline,
    showHistory,
    selectRun,
    scrubRun,
    showAffected,
    showCi,
    noteRunStarted,
    openSource
  }
}
