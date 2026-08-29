/**
 * One agent turn, rendered as an NDJSON stream of `TurnFrame` lines.
 *
 * The Worker owns the turn because the agent runs here: the seat credential is
 * a Worker secret, the sandbox is a Worker-side QuickJS realm, and the cards
 * the agent paints come back over the same stream the text does. The browser
 * shell reads one JSON object per line and never polls.
 *
 * Milestone 1 ships the mock path. `env.APP_MOCK_TURN !== "0"` streams a
 * plausible sequence so the shell works end to end; `"0"` asks for the real
 * `Agent.run` path below, which is written out in full and does not run under
 * workerd yet. The blockers are named at {@link liveTurn}.
 */
import type { AgentSpec, AnyFlowSpec, SandboxSpec, ToolsSpec } from "@smthrs/create-app/app"
import { layerFor, materializeFlow } from "@smthrs/create-app/runtime"
import * as Agent from "@smthrs/agent/Agent"
import * as AgentAction from "@smthrs/agent/AgentAction"
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Context from "effect/Context"
import type { AppCard, FlowSummary, Message, SessionSummary, TurnFrame, TurnRequest } from "../src/api.ts"
import { flows, paneNames } from "../routes.gen.ts"
import { CellHistory, type ExecutedCell, FlowStore, makeCells, promoteSource } from "../tools/promote.ts"
import { CardSink, makePanes, PaneNames, uiSource } from "../tools/ui.ts"
import { layerCrypto } from "./crypto.ts"
import type { Env } from "./env.ts"
import { seatsFor } from "./seats.ts"

/**
 * The half of `AppSession` a turn writes back into.
 *
 * A narrow structural seam rather than the class itself: `AppSession` imports
 * this module, so the dependency has to point one way.
 */
export interface TurnSession {
  /** Appends a transcript message and returns the stored row. */
  readonly appendMessage: (role: Message["role"], text: string) => Message
  /** Persists a card the turn emitted, so a reload replays it. */
  readonly appendCard: (card: AppCard) => void
  /** The `FlowStore.write` half: where `flows/write-flow` lands. */
  readonly writeFlow: (
    id: string,
    description: string,
    files: Record<string, string>
  ) => { readonly files: ReadonlyArray<string> }
  /** The flows this session has saved, for `FlowStore.list`. */
  readonly listFlows: () => ReadonlyArray<FlowSummary>
  /** Reports the turn's outcome to the session's row in the Recent column. */
  readonly settle: (status: SessionSummary["status"]) => void
}

export interface TurnOptions {
  readonly env: Env
  readonly session: TurnSession
  readonly request: TurnRequest
  /** Aborted by `POST /api/agent/turn/cancel` or by the client hanging up. */
  readonly signal: AbortSignal
}

/** One routed flow, as `routes.gen.ts` records it. */
interface FlowRoute {
  readonly id: string
  readonly spec: AnyFlowSpec
  readonly agent: AgentSpec
  readonly sandbox: SandboxSpec
  readonly tools: ToolsSpec
}

const routeFor = (flowId: string): FlowRoute | undefined =>
  (flows as unknown as ReadonlyArray<FlowRoute>).find((flow) => flow.id === flowId)

// ---------------------------------------------------------------------------
// Event mapping
// ---------------------------------------------------------------------------

/**
 * Tracks the per-turn state the frame projection needs and the event stream
 * does not carry: the ordinal of each executed cell, and the input a call was
 * started with, which arrives on `cell-call-started` and is wanted on
 * `cell-call-settled`.
 */
class FrameProjection {
  private cells = 0
  private readonly inputs = new Map<string, unknown>()

  /** Projects one agent event onto the frames the shell renders, if any. */
  frames(event: AgentEvent.AgentEvent): ReadonlyArray<TurnFrame> {
    switch (event._tag) {
      case "model-delta": {
        const delta = event.delta
        return delta.type === "text-delta" && delta.text.length > 0
          ? [{ type: "delta", text: delta.text }]
          : []
      }
      case "cell-produced":
        return [{ type: "cell", source: event.cell.text, ordinal: this.cells++ }]
      case "cell-call-started":
        this.inputs.set(event.call.flowName, event.call.input)
        return []
      case "cell-call-settled": {
        const input = this.inputs.get(event.flowName) ?? null
        this.inputs.delete(event.flowName)
        const message = event.result.message
        return [{
          type: "call",
          flow: event.flowName,
          input,
          outcome: event.result.outcome,
          ...(message === undefined ? {} : { message })
        }]
      }
      case "transition-applied":
        return event.transition._tag === "complete"
          ? [{ type: "done", output: event.transition.output }]
          : []
      case "suspended":
        return [{ type: "park", reason: event.reason.code, message: event.reason.message }]
      case "aborted":
        return [{ type: "error", message: event.reason }]
      default:
        return []
    }
  }
}

// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()

/** One NDJSON line. Frames are plain JSON structs, so no encoder is needed. */
const line = (frame: TurnFrame): Uint8Array => encoder.encode(`${JSON.stringify(frame)}\n`)

const failureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "The turn failed."

/**
 * Runs one turn and returns its NDJSON body.
 *
 * The stream is closed exactly once, on the one path every branch ends on: a
 * turn that fails still writes an `error` frame and then closes, because a
 * body that just stops is a spinner the shell cannot end.
 */
export const runTurn = (options: TurnOptions): ReadableStream<Uint8Array> => {
  const mock = options.env.APP_MOCK_TURN !== "0"
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (frame: TurnFrame): void => {
        controller.enqueue(line(frame))
      }
      try {
        await (mock ? mockTurn(options, emit) : liveTurn(options, emit))
        options.session.settle(options.signal.aborted ? "idle" : "ready")
      } catch (cause) {
        // The Recent column is written before the refusal, because the refusal
        // is the part that may fail: a reader that hung up makes every enqueue
        // throw, so it is written on a best-effort basis.
        options.session.settle(options.signal.aborted ? "idle" : "failed")
        try {
          emit({ type: "error", message: failureMessage(cause) })
        } catch {
          // The stream is already gone.
        }
      } finally {
        try {
          controller.close()
        } catch {
          // Already closed by the reader cancelling.
        }
      }
    }
  })
}

// ---------------------------------------------------------------------------
// The mock turn
// ---------------------------------------------------------------------------

/**
 * The milestone-1 turn: one plausible sequence, no model call.
 *
 * It exercises every frame kind the shell renders — deltas, a `ctx.call`
 * result, a pane card, and a terminal `done` — so the transcript, the pane
 * host, and the cancel button are all reachable before the agent path lands.
 */
const mockTurn = async (options: TurnOptions, emit: (frame: TurnFrame) => void): Promise<void> => {
  const { request, session, signal } = options
  const route = routeFor(request.flowId)
  if (route === undefined && flows.length > 0) {
    emit({ type: "error", message: `No flow is routed as "${request.flowId}".` })
    return
  }
  session.appendMessage("user", request.message)

  const deltas = [
    "Checking the balance",
    " on the forked chain",
    "..."
  ]
  let answer = ""
  for (const text of deltas) {
    if (signal.aborted) return emit({ type: "error", message: "The turn was cancelled." })
    answer += text
    emit({ type: "delta", text })
  }

  emit({
    type: "call",
    flow: "tevm/getBalance",
    input: { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
    outcome: "success"
  })

  const card: AppCard = {
    kind: "pane",
    id: `${request.sessionId}:chain-balance`,
    name: "chain-balance",
    title: "Balance",
    props: {
      address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      chainId: 1,
      balanceWei: "1234567890123456789",
      symbol: "ETH"
    },
    fullscreen: false
  }
  session.appendCard(card)
  emit({ type: "card", card })

  const closing = " That address holds about 1.23 ETH."
  answer += closing
  emit({ type: "delta", text: closing })
  session.appendMessage("assistant", answer)
  emit({ type: "done", output: { answer } })
}

// ---------------------------------------------------------------------------
// The real turn
// ---------------------------------------------------------------------------

/**
 * The declared payload every chat flow takes.
 *
 * The router names a flow by its directory and the flow declares its own
 * payload, so this is the one shape the Worker can build from an HTTP body.
 * A pipeline flow with a richer payload runs through `POST /api/flows/run`,
 * not through a turn.
 */
const TurnPayload = Schema.Struct({ message: Schema.String })

// ---------------------------------------------------------------------------
// Session-backed tools
// ---------------------------------------------------------------------------

/**
 * The registered panes as `ui/pane` checks them.
 *
 * `fullscreen` lives in the pane component and reading it would mean importing
 * `routes.ui.gen.ts`, and with it React and every page of the app, into the
 * Worker bundle. The flag only rides along on the emitted card, so the Worker
 * reports `false` and the shell resolves the real value from the component it
 * already has.
 *
 * TODO(upstream): `routes.gen.ts` records pane names but not their `fullscreen`
 * flag. Emitting it from the generator would remove this compromise
 * (@smthrs/create-app/router).
 */
const panes = paneNames.map((name) => ({ name, fullscreen: false }))

/** The one-line description of a saved flow, read out of the source it saved. */
const DESCRIPTION = /description:\s*(["'`])([\s\S]*?)\1/

/**
 * The description `GET /api/flows` shows for a saved flow.
 *
 * `flows/write-flow` takes a description and `FlowStoreService.write` does not
 * forward it, so it is recovered from the `defineFlow({ description })` line of
 * the source that was written. The model wrote both from one input, so they
 * agree.
 *
 * TODO(upstream): give `FlowStoreService.write` the description instead
 * (tools/promote.ts:88, dropped at tools/promote.ts:278).
 */
const descriptionOf = (id: string, files: Record<string, string>): string => {
  const source = files[`flows/${id}/flow.ts`]
  const match = source === undefined ? null : DESCRIPTION.exec(source)
  return match?.[2]?.trim() ?? `Saved from a session as "${id}"`
}

/**
 * The turn's tool sources: the declared ones, with `ui` and `flows` rebound to
 * this session.
 *
 * TOOLS.ts composes both against no-op hosts, because a layer file has no
 * session to write into. Replacing them by name keeps every other source
 * (`tevm`) exactly as the app declared it, so a source added to TOOLS.ts
 * reaches the turn without a change here.
 */
const sessionSources = (
  route: FlowRoute,
  session: TurnSession,
  executed: ReadonlyArray<ExecutedCell>,
  emit: (frame: TurnFrame) => void
): ReadonlyArray<FlowBinding.Source> => {
  const ui = uiSource(
    Context.add(
      Context.make(CardSink, {
        emit: (card: AppCard) =>
          Effect.sync(() => {
            session.appendCard(card)
            emit({ type: "card", card })
          }),
        update: (card: AppCard) =>
          Effect.sync(() => {
            session.appendCard(card)
            emit({ type: "card.update", card })
          })
      }),
      PaneNames,
      makePanes(panes)
    )
  )
  const promote = promoteSource(
    Context.add(
      Context.make(CellHistory, makeCells(executed)),
      FlowStore,
      {
        write: (id: string, files: Record<string, string>) =>
          Effect.sync(() => session.writeFlow(id, descriptionOf(id, files), files)),
        list: () => Effect.sync(() => session.listFlows())
      }
    )
  )
  const replacements = new Map([[ui.name, ui], [promote.name, promote]])
  return route.tools.sources.map((source) => replacements.get(source.name) ?? source)
}

/**
 * One turn on the real agent, streaming every event as a frame.
 *
 * TODO(upstream): this path cannot run inside workerd yet. Three items, all in
 * ~/flows/flows and all listed in TODO.md:
 *
 *  1. `packages/harness/src/QuickJSSandbox.ts:22` imports
 *     `@jitl/quickjs-singlefile-browser-release-sync` and compiles it at
 *     `:383` with `newQuickJSWASMModuleFromVariant(variant)`. That is a
 *     runtime `WebAssembly.compile` over bytes, which workerd refuses; a
 *     Worker needs the wasmfile variant behind a real `.wasm` module import.
 *     `packages/agent/src/Agent.ts:474` (`layerDefaults`) merges that layer
 *     unconditionally, and `layerFor` composes `layerDefaults`, so every real
 *     turn dies there before it reaches the model.
 *  2. `@smthrs/create-app/runtime` builds `AgentAction.layerHost`
 *     without `flows`, so the app's tool sources never reach the cell through
 *     the layer. `AgentAction.Host` already declares the field
 *     (`packages/agent/src/AgentAction.ts:88`) and `AgentAction` already
 *     forwards it to `agent.run`, so the fix is one line in the vendored stub;
 *     until it lands, this function attaches the sources on `Agent.run`
 *     itself, which is the seam the stub's own TODO points at.
 *  3. `packages/database` has no Durable Object SQLite driver, so the turn
 *     runs on `FlowEngine.layerMemory` (composed by `layerFor`) and its
 *     journal does not survive the request. `AppSession` persists the app's
 *     own state instead.
 */
const liveTurn = async (options: TurnOptions, emit: (frame: TurnFrame) => void): Promise<void> => {
  const { env, request, session, signal } = options
  const route = routeFor(request.flowId)
  if (route === undefined) {
    emit({ type: "error", message: `No flow is routed as "${request.flowId}".` })
    return
  }
  session.appendMessage("user", request.message)

  const materialized = materializeFlow(route.id, route.spec, route.agent)
  const projection = new FrameProjection()
  const answer: Array<string> = []
  // Read live by `flows/show-script`: the array is the same object the history
  // service holds, so a call late in the turn sees every cell that ran before
  // it.
  const executed: Array<ExecutedCell> = []
  const sources = sessionSources(route, session, executed, emit)

  /**
   * The turn as one durable action.
   *
   * `Agent.run` must be started from inside a running flow body, because the
   * engine port it drives is built per execution. An action is the smallest
   * thing that gives it one, and running the loop here rather than through
   * `materialized.action` is what makes the events reachable: `AgentAction`
   * buffers them and hands back only the decoded output.
   */
  const turn = Action.make(`app/${route.id}/turn`, {
    payload: TurnPayload,
    success: Schema.String,
    error: AgentAction.AgentFailure
  })

  const implementation = turn.toLayer((payload) =>
    Effect.gen(function*() {
      const host = yield* AgentAction.Host
      const seats = yield* SeatResolver.SeatResolver
      const agent = yield* Agent.Agent
      const instance = yield* FlowRuntime.FlowInstance
      const seat = yield* seats.resolve(route.agent.seat)
      yield* agent.run({
        session: instance.executionId,
        seat,
        prompt: payload.message,
        system: [...route.agent.system, ...(route.spec.system ?? [])],
        registry: host.registry,
        // TODO(upstream) item 2: the sources belong on the host layer.
        flows: sources,
        limits: host.limits,
        maxFrames: route.agent.maxFrames ?? host.maxFrames
      }).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            for (const frame of projection.frames(event)) {
              if (frame.type === "delta") answer.push(frame.text)
              if (frame.type === "cell") executed.push({ ordinal: frame.ordinal, source: frame.source })
              emit(frame)
            }
          })
        )
      )
      return answer.join("")
    })
  )

  const flow = Flow.make(`app/${route.id}/turn`, {
    payload: TurnPayload,
    success: Schema.String,
    error: AgentAction.AgentFailure,
    body: (payload) => turn.call(payload)
  })

  const layer = Layer.mergeAll(implementation, Interpreter.layer(flow)).pipe(
    Layer.provideMerge(layerFor({
      agent: route.agent,
      sandbox: route.sandbox,
      tools: { ...route.tools, sources },
      seats: seatsFor(env),
      crypto: layerCrypto
    }))
  )

  const program = flow.execute(
    { message: request.message },
    { executionId: `${request.sessionId}:${Date.now()}` }
  ).pipe(Effect.provide(layer))

  const text = await Effect.runPromise(program, { signal })
  session.appendMessage("assistant", text)
  emit({ type: "done", output: { answer: text } })
}
