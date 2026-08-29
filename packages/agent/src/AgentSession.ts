/**
 * One control-plane launch, run as one durable agent session.
 *
 * This is the production `ControlExecutor`. `ControlLive.run` resolves the
 * executor through `Effect.serviceOption`, and until this module existed
 * nothing provided one, so every accepted run stayed `pending` forever. What it
 * does is take a stored plan, find the flow's descriptor and prompt body in the
 * registry, resolve the flow's declared seat through {@link SeatResolver}, and
 * run {@link module:Agent} as the body of one durable flow execution whose id
 * is the control run id.
 *
 * The session is the adapter, not the agent. Everything about how a frame is
 * built, sealed, and replayed belongs to `Agent`; what belongs here is the
 * control-plane half — status fencing, the resume bridge, the approval gate,
 * and the journal trail.
 *
 * What the composition declares, because the spec says a host must:
 *
 * - **Explicit sandbox limits.** `Options.limits` is required; an unlimited
 *   QuickJS cell can hang the frame, so there is no default-unlimited path.
 * - **A resolved context window.** `Seat.contextWindowTokens` comes back from
 *   the host's `SeatResolver`, so compaction is armed instead of silently
 *   disabled at zero. `SeatResolver.contextWindowTokensFor` is the catalog for
 *   known models.
 * - **Steering from the durable queue.** The `Steering.Source` is
 *   `@smthrs/harness/Notifications` over the same journal-backed queue
 *   `Control.steer` admits into, so an operator steer reaches the loop at the
 *   next frame boundary.
 * - **Approval through control.** The `ask` flow is gated in the `authorize`
 *   hook — before the durable boundary opens — by registering an in-run
 *   approval token (`ControlRuntime.registerApproval`) and failing with an
 *   encoded `Permission.PermissionRequired`, which the controller turns into
 *   a real durable park. `Control.approve` resolves the token and installs
 *   the grant; the resumed attempt re-asks against the grant store as it now
 *   stands and proceeds. The park is decided outside the activity on purpose:
 *   a requirement raised inside one would be journaled and replayed forever.
 *
 * Run-status writes stay fenced: the executor waits for the control plane's
 * own `running` transition before the engine starts, writes
 * `waiting-approval` when the execution parks, and writes the terminal status
 * when it settles. Resumption is event-driven — the executor follows the
 * journal for the control plane's resume events and re-drives the parked
 * engine execution.
 *
 * Reference consulted: `reference/effect` `unstable/workflow` by way of
 * `@smthrs/engine`'s `FlowRuntime` (register/execute/poll/resume), and
 * `reference/opencode` `packages/core/src/session` for the shape of a
 * background run driver owned by a scope.
 *
 * @since 0.1.0
 */
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import { LaunchFailed } from "@smthrs/control/ControlError"
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import type { ApprovalPayload, Envelope, RunStatus } from "@smthrs/control/ControlSchema"
import * as Digest from "@smthrs/core/Digest"
import { Flow, FlowRuntime } from "@smthrs/flow"
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import type * as Cell from "@smthrs/harness/Cell"
import * as CellTurn from "@smthrs/harness/CellTurn"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as HarnessError from "@smthrs/harness/HarnessError"
import * as Notifications from "@smthrs/harness/Notifications"
import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import type * as Sandbox from "@smthrs/harness/Sandbox"
import * as Steering from "@smthrs/harness/Steering"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as CanonicalJson from "@smthrs/model/CanonicalJson"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import type { NotificationQueue } from "@smthrs/notifications"
import { Node } from "@smthrs/plan"
import * as Registry from "@smthrs/registry/Registry"
import type { Crypto } from "effect"
import { Cause, Clock, Deferred, Duration, Effect, Exit, Fiber, Layer, Option, Schema, Scope, Stream } from "effect"
import { Agent } from "./Agent.ts"
import * as Seat from "./Seat.ts"
import { SeatResolver } from "./SeatResolver.ts"
import * as StandardFlows from "./StandardFlows.ts"

/**
 * Everything the host decides about the composition.
 *
 * `limits` is required on purpose: the composition never runs a cell without
 * an explicit memory and step budget. `flows` is the host's executable
 * catalog — filesystem, shell, memory — while the durable wait and the
 * control-wired approval are composed here, because they belong to the
 * engine and the control plane rather than to the host.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /** Host executable-flow sources composed into every run's catalog. */
  readonly flows?: ReadonlyArray<FlowBinding.Source> | undefined
  /** The explicit sandbox budget every cell runs under. Never unlimited. */
  readonly limits: Sandbox.Limits
  /** Stable system teaching placed ahead of the cell contract. */
  readonly system?: ReadonlyArray<string> | undefined
  readonly maxFrames?: number | undefined
  /**
   * Consecutive read-only frames a task run may spend before the controller
   * demands an edit or a justification, and twice that before it stops the
   * run. Defaults to `CellTurn.defaultReadOnlyFrames`.
   */
  readonly readOnlyCap?: number | undefined
  /**
   * Wall-clock milliseconds one model call may spend before the boundary
   * interrupts it and re-issues it. Defaults to `CellTurn.defaultModelCallMs`;
   * zero disarms it.
   */
  readonly modelCallMs?: number | undefined
  /**
   * Consecutive repeat-observation frames a run may spend before the
   * controller names the repetition and redirects it. Defaults to
   * `CellTurn.defaultRepeatFrames`; zero disarms it.
   */
  readonly repeatCap?: number | undefined
  /**
   * Completions a run may have bounced for narrowed evidence before the
   * controller stops naming the check it skipped. Defaults to
   * `CellTurn.defaultNarrowingDemands`; zero disarms it.
   */
  readonly narrowingCap?: number | undefined
  /**
   * Completions a run may have bounced for an unmoved tree before the
   * controller stops naming it. Defaults to `CellTurn.defaultUnmovedDemands`;
   * zero disarms it.
   */
  readonly unmovedCap?: number | undefined
  /**
   * Completions a run may have bounced for a failing check it replaced rather
   * than answered. Defaults to `CellTurn.defaultUnresolvedDemands`; zero
   * disarms it.
   */
  readonly unresolvedCap?: number | undefined
  /**
   * Whether a human answers this executor's runs, which is what makes a cell's
   * `park` transition honorable.
   *
   * The executor wires an approval gate on every run, but a gate is not an
   * answerer: a benchmark, a cron, and a CI lane all register approvals that
   * nobody will ever decide. So the host says. It defaults to false, and a run
   * that claims false has its `park` transitions refused and answered in-frame
   * rather than left waiting on an operator who is not there.
   */
  readonly approvalChannel?: boolean | undefined
  /**
   * The reasoning effort agent seats run at when their flow declares none.
   *
   * The flow's own `effort:` frontmatter wins; this is the host's default
   * beneath it, and the built-in default is `high` — an unset effort is not
   * neutral, it is near-zero thinking (the first SWE-bench runs recorded ~20
   * reasoning tokens per call while the same model under the Codex CLI ran
   * at medium and resolved four times as many instances).
   */
  readonly reasoningEffort?: ModelRequest.ReasoningEffort | undefined
}

const sourceId = JournalEvent.SourceId.make("/control/executor")

const assistantText = (message: ModelRequest.AssistantMessage): string =>
  message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")

/**
 * The journal projection of one agent event.
 *
 * The executor consumes the harness stream itself, so without this the whole
 * transcript — what the model said, the cell it produced, the flows that cell
 * called, and why a frame was rejected — existed only for the duration of the
 * run and a settled run could not be read back at all. Model deltas are the
 * one omission: they are the token-by-token prefix of `model-settled`, and
 * journaling them would multiply a run's event count by its token count for
 * no information the settlement does not already carry.
 *
 * `undefined` means "not journaled".
 *
 * @category projections
 * @since 0.1.0
 */
export const trace = (
  event: AgentEvent.AgentEvent
): { readonly eventType: string; readonly payload: unknown } | undefined => {
  switch (event._tag) {
    case "model-delta":
      return undefined
    case "model-retried":
      // The delay is journaled with the attempt because it cannot be
      // recovered from the timestamps: every retry of one sealed step is
      // written when that step settles, so a run that backed off for half a
      // minute and one that did not back off at all produce the same
      // timestamps. A wave report reads the schedule off this field.
      return {
        eventType: "control.agent.model-retried",
        payload: { attempt: event.attempt, code: event.code, delayMillis: event.delayMillis }
      }
    case "discipline-armed":
      // The positive record of what this run armed, written before any of it
      // can fire. A run that never completes still proves its arming here.
      return {
        eventType: "control.agent.discipline-armed",
        payload: {
          readOnlyCap: event.readOnlyCap,
          maxFrames: event.maxFrames,
          approvalChannel: event.approvalChannel,
          // The one budget a report can grade after the fact without any
          // further instrumentation: `control.agent.model-settled` already
          // journals `durationMillis` per call, so the pair says both what the
          // run promised and what every call it made actually spent.
          modelCallMs: event.modelCallMs,
          // Armed for the same reason and journaled the same way: a wave that
          // records no repeat demand must be able to say whether the control
          // was armed and never needed, or never armed at all.
          repeatCap: event.repeatCap,
          // The one control that acts on a completion rather than on a stall,
          // so a wave's report can say whether the run that finished was ever
          // asked about the evidence it finished on.
          narrowingCap: event.narrowingCap,
          // The two controls that judge what a completion is *about* rather
          // than how it was verified: whether the run changed anything at all,
          // and whether it answered the check that told it something was
          // broken. Journaled with the rest so a wave can tell "armed and never
          // needed" from "never armed".
          unmovedCap: event.unmovedCap,
          unresolvedCap: event.unresolvedCap,
          calls: event.calls,
          memoryBytes: event.memoryBytes,
          steps: event.steps,
          timeMs: event.timeMs,
          callMs: event.callMs,
          totalMs: event.totalMs
        }
      }
    case "turn-opened":
      return {
        eventType: "control.agent.turn-opened",
        payload: { seat: event.seat, contextDigest: event.contextDigest }
      }
    case "model-settled":
      return {
        eventType: "control.agent.model-settled",
        payload: {
          text: assistantText(event.message),
          usage: event.usage,
          // Wall-clock for this one sealed call. A run's total time was
          // already derivable from event stamps; per-call latency was not,
          // and it is the number a speed comparison actually needs.
          durationMillis: event.durationMillis
        }
      }
    case "cell-produced":
      return {
        eventType: "control.agent.cell-produced",
        payload: { language: event.cell.language, digest: event.cell.digest, text: event.cell.text }
      }
    case "cell-call-started":
      return {
        eventType: "control.agent.cell-call-started",
        payload: { flowName: event.call.flowName, input: event.call.input }
      }
    case "cell-call-settled":
      return {
        eventType: "control.agent.cell-call-settled",
        payload: {
          flowName: event.flowName,
          outcome: event.result.outcome,
          message: event.result.message,
          value: event.result.value
        }
      }
    case "cell-printed":
      // The whole of the REPL mode's context channel. Journaled with the cell
      // that produced it so a transcript projection can rebuild a resumed run's
      // window without re-running anything.
      return {
        eventType: "control.agent.cell-printed",
        payload: { cell: event.cell, text: event.text }
      }
    case "cell-settled":
      return { eventType: "control.agent.cell-settled", payload: { outcome: event.outcome } }
    case "transition-applied":
      return { eventType: "control.agent.transition-applied", payload: { transition: event.transition } }
    case "mutation-observed":
      // Written for every frame, not only for the ones that trip a control.
      // `basis` travels with it because a `declared` answer is paperwork and an
      // `observed` one is a fact about the tree, and a reader reconstructing a
      // run must not have to guess which it is holding.
      return {
        eventType: "control.agent.mutation-observed",
        payload: {
          basis: event.basis,
          mutated: event.mutated,
          digest: event.digest,
          paths: event.paths,
          declaredWrites: event.declaredWrites
        }
      }
    case "checkpoint-minted":
      // The store's own name for the tree travels with the id, because the
      // frame that reads against a checkpoint is usually not the frame that
      // pinned it: a journal holding only the reading could not say which tree
      // it was a reading of, and a fails-before proof is exactly that claim.
      return {
        eventType: "control.agent.checkpoint-minted",
        payload: { id: event.id, ref: event.ref, cell: event.cell, ordinal: event.ordinal }
      }
    case "read-only-demanded":
      return {
        eventType: "control.agent.read-only-demanded",
        payload: {
          streak: event.streak,
          cap: event.cap,
          nextFrame: event.nextFrame,
          nextAction: event.nextAction
        }
      }
    case "repeat-demanded":
      // Journaled at issuance, not at its answer: what answers this demand is
      // the shape of the next frame's calls, and `cell-call-started` already
      // writes those one at a time.
      return {
        eventType: "control.agent.repeat-demanded",
        payload: { frames: event.frames, cap: event.cap, nextFrame: event.nextFrame }
      }
    case "narrowed-demanded":
      // The two inputs and the two digests travel together because the whole
      // judgement is in the pair: without the digests a reader cannot tell a
      // stale broad check from a current one, and without the inputs it cannot
      // tell whether the narrowing was real. A grader reading this back can
      // second-guess the demand without replaying the run.
      return {
        eventType: "control.agent.narrowed-demanded",
        payload: {
          flow: event.flow,
          broader: event.broader,
          narrower: event.narrower,
          broaderDigest: event.broaderDigest,
          currentDigest: event.currentDigest,
          nextFrame: event.nextFrame
        }
      }
    case "unmoved-demanded":
      // Both digests, because the judgement is the comparison: a reader with
      // only one of them cannot tell an unmoved tree from a measurement that
      // never happened, and the pair reconciles directly against the run's own
      // `mutation-observed` record.
      return {
        eventType: "control.agent.unmoved-demanded",
        payload: {
          openedDigest: event.openedDigest,
          currentDigest: event.currentDigest,
          nextFrame: event.nextFrame
        }
      }
    case "unresolved-demanded":
      // The failing check and the reading that displaced it travel together
      // for the same reason the narrowing pair does: either one alone is
      // unremarkable, and the demand is entirely about the two of them.
      return {
        eventType: "control.agent.unresolved-demanded",
        payload: {
          flow: event.flow,
          failed: event.failed,
          instead: event.instead,
          currentDigest: event.currentDigest,
          nextFrame: event.nextFrame
        }
      }
    case "vacuous-verification-observed":
      // The stored check travels with the identity the controller matched it
      // by, because the whole judgement is that this exact call had already
      // been watched passing: a reader with only the text cannot tell an exact
      // reuse from a command that merely reads like one, and the signature
      // reconciles the row directly against the run's own
      // `cell-call-settled` record.
      return {
        eventType: "control.agent.vacuous-verification-observed",
        payload: {
          flow: event.flow,
          check: event.check,
          signature: event.signature,
          nextFrame: event.nextFrame
        }
      }
    case "suspended":
      return { eventType: "control.agent.suspended", payload: { reason: event.reason } }
    case "compaction-settled":
      return {
        eventType: "control.agent.compaction-settled",
        payload: { replacedPrefixDigest: event.replacedPrefixDigest }
      }
    case "turn-closed":
      return {
        eventType: "control.agent.turn-closed",
        payload: { stopReason: event.stopReason, outcome: event.outcome }
      }
    case "permission-required":
      return { eventType: "control.agent.permission-required", payload: { request: event.request } }
    case "aborted":
      return { eventType: "control.agent.aborted", payload: { reason: event.reason } }
    case "resolved":
      return { eventType: "control.agent.resolved", payload: { text: assistantText(event.message) } }
    default:
      return { eventType: `control.agent.${event._tag}`, payload: {} }
  }
}

/**
 * Resolves the reasoning effort one run's model calls request.
 *
 * The flow's `effort:` frontmatter wins, then the host's configured default,
 * then `high`. The frontmatter value is validated against the effort
 * vocabulary and an unrecognised spelling falls through rather than failing
 * the launch: effort is a tuning knob, not a contract.
 */
const effortFor = (
  descriptor: { readonly frontmatter: Readonly<Record<string, unknown>> },
  host: ModelRequest.ReasoningEffort | undefined
): ModelRequest.ReasoningEffort => {
  const declared = descriptor.frontmatter["effort"]
  if (typeof declared === "string" && Schema.is(ModelRequest.ReasoningEffort)(declared)) {
    return declared
  }
  return host ?? "high"
}

/** The envelope an in-run ask approval binds to: the ask flow, nothing else. */
const askEnvelope: Envelope = { capabilities: [], flows: ["ask"], budget: {} }

interface AskInput {
  readonly question: string
  readonly options?: ReadonlyArray<string> | undefined
}

/**
 * The identity of one ask, derived from its run and whole input. Including the
 * run id prevents a grant for a byte-identical question in one run from
 * answering it in another, while remaining stable across this run's park and
 * resumed attempt. The raw call input and its decoded form digest identically
 * — both are plain JSON and canonical serialization sorts keys.
 */
const askIdentity = (
  runId: string,
  input: unknown
): { readonly digest: string; readonly requestId: string } => {
  const digest = Digest.digest(CanonicalJson.stringify({ input, runId }))
  return { digest, requestId: `ask/${runId}/${digest}` }
}

/**
 * Parses one formatted capability into the pattern schema, refusing anything
 * it cannot name. Dropping an unparseable entry narrows authority — the
 * fail-closed direction — because an empty envelope grants nothing.
 *
 * The bare `*` is the one token that is whole authority rather than an
 * action-and-resource pair. `@smthrs/registry`'s `MarkdownFlow` emits exactly
 * that string for a flow whose frontmatter declares no `capabilities:`, and
 * `flows plan` prints it back as the plan's envelope, so refusing it left
 * every markdown-declared agent run with an empty envelope: `bash`, `read`,
 * and `write` all failed with "outside this run's capability envelope" and
 * the built-in harness could not touch a file or run a command. It expands to
 * `{ action: "*", resource: "**" }` — `**` and not `*`, because
 * `Capability.subsumes` recognises only `**` as recursive and a grant written
 * with `*` can never be proven to cover anything.
 */
const pattern = (formatted: string): Option.Option<Capability.CapabilityPattern> => {
  if (formatted === "*") {
    return Schema.decodeUnknownOption(Capability.CapabilityPattern)({ action: "*", resource: "**" })
  }
  const first = formatted.indexOf(":")
  if (first < 0) return Option.none()
  const head = formatted.slice(0, first)
  if (head === "*") {
    return Schema.decodeUnknownOption(Capability.CapabilityPattern)({
      action: "*",
      resource: formatted.slice(first + 1)
    })
  }
  const second = formatted.indexOf(":", first + 1)
  if (second < 0) return Option.none()
  return Schema.decodeUnknownOption(Capability.CapabilityPattern)({
    action: formatted.slice(0, second),
    resource: formatted.slice(second + 1)
  })
}

/**
 * Parses a run envelope's formatted capabilities, dropping every entry
 * {@link pattern} cannot name.
 *
 * @category conversions
 * @since 0.1.0
 */
export const patterns = (capabilities: ReadonlyArray<string>): ReadonlyArray<Capability.CapabilityPattern> =>
  capabilities.flatMap((formatted) => {
    const parsed = pattern(formatted)
    return Option.isSome(parsed) ? [parsed.value] : []
  })

/**
 * Renders the prompt-flow body and its decoded input into the task the run is
 * admitted with. An absent or empty input adds nothing.
 */
const prompt = (text: string, input: unknown): string => {
  const rendered = input == null ? "null" : JSON.stringify(input, null, 2)
  return rendered === "null" || rendered === "{}"
    ? text.trim()
    : `${text.trim()}\n\nInput:\n${rendered}`
}

/**
 * The one durable flow every agent run executes. Its plan-time body is inert;
 * the behaviour is the `execute` registered by {@link make}, and the
 * execution id is the control run id.
 */
const agentFlow = Flow.make("agent/run", {
  payload: { runId: Schema.String, planId: Schema.String },
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Node.succeed(undefined)
})

/**
 * Waits for ControlLive to publish its running transition before a driver
 * starts the engine. Keeping the bounded retry here makes the publication race
 * deterministic to exercise without coupling it to a particular scheduler.
 *
 * @category helpers
 * @since 0.1.0
 */
export const waitForRunning = (
  status: (runId: string) => Effect.Effect<RunStatus, unknown>,
  runId: string,
  attempts: number,
  retryDelay: Effect.Effect<void> = Effect.sleep(Duration.millis(10))
): Effect.Effect<boolean, unknown> =>
  Effect.gen(function*() {
    const current = yield* status(runId)
    if (current === "running") {
      // The running row is written inside ControlLive's admission transaction.
      // Cross the same asynchronous retry boundary once more so that
      // transaction can commit before the engine opens its own durable
      // transaction.
      yield* retryDelay
      return true
    }
    if (current === "accepted" && attempts > 0) {
      yield* retryDelay
      return yield* waitForRunning(status, runId, attempts - 1, retryDelay)
    }
    if (current === "accepted") {
      return yield* Effect.fail(
        new LaunchFailed({
          runId,
          message: "The accepted run was not published as running before its driver admission budget expired"
        })
      )
    }
    return false
  })

/**
 * Polls a durable execution until it is published as parked. A missing poll is
 * a still-live execution, so retries are bounded before a resume is attempted.
 *
 * @category helpers
 * @since 0.1.0
 */
export const waitForParked = (
  poll: () => Effect.Effect<Option.Option<{ readonly _tag: string }>, unknown>,
  attempts: number
): Effect.Effect<boolean, unknown> =>
  Effect.gen(function*() {
    const result = yield* poll()
    if (Option.isNone(result)) {
      if (attempts <= 0) return false
      yield* Effect.sleep(Duration.millis(10))
      return yield* waitForParked(poll, attempts - 1)
    }
    return result.value._tag === "Suspended"
  })

/**
 * Keeps a control cancellation durable even when its engine interrupt fails.
 *
 * @category helpers
 * @since 0.1.0
 */
export const preserveDriverInterrupt = <R>(
  interrupt: () => Effect.Effect<void, unknown, R>
): Effect.Effect<void, never, R> => interrupt().pipe(Effect.catchCause(() => Effect.void))

/**
 * Translates a failed driver registration into the executor's launch error.
 *
 * @category helpers
 * @since 0.1.0
 */
export const registerDriver = (
  register: () => Effect.Effect<void, unknown>,
  runId: string
): Effect.Effect<void, LaunchFailed> =>
  register().pipe(
    Effect.mapError((cause) =>
      new LaunchFailed({
        runId,
        message: "The run driver could not be registered for cancellation",
        cause
      })
    )
  )

/**
 * Re-throws a cancelled driver while logging a non-interrupt engine failure.
 *
 * @category helpers
 * @since 0.1.0
 */
export const settleDriverFailure = <E, R>(
  cause: Cause.Cause<unknown>,
  runId: string,
  writeFailed: (detail: string) => Effect.Effect<void, E, R>
): Effect.Effect<void, E, R> =>
  Cause.hasInterruptsOnly(cause)
    ? Effect.interrupt
    : Effect.andThen(
      Effect.annotateLogs(
        Effect.logError("An accepted agent run could not start on the engine"),
        { runId, cause: Cause.pretty(cause) }
      ),
      writeFailed(Cause.pretty(cause))
    )

/** Everything the executor captures at construction and re-provides per run. */
type Services =
  | Agent
  | ControlRuntime
  | Crypto.Crypto
  | FlowRuntime.FlowRuntime
  | Journal.Journal
  | NotificationQueue.NotificationQueue
  | Registry.Registry
  | SeatResolver

/**
 * Constructs the production executor.
 *
 * Must be built in a scope: the scope owns the registered agent flow, every
 * forked run driver, and the resume bridge that follows the journal.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  options: Options
): Effect.Effect<ControlExecutor.Service, never, Services | Scope.Scope> =>
  Effect.gen(function*() {
    const runtime = yield* ControlRuntime
    const journal = yield* Journal.Journal
    const registry = yield* Registry.Registry
    const engine = yield* FlowRuntime.FlowRuntime
    const seats = yield* SeatResolver
    const agent = yield* Agent
    const scope = yield* Effect.scope
    const services = yield* Effect.context<Services>()

    const emit = (
      runId: string,
      eventType: string,
      payload: unknown
    ): Effect.Effect<void, unknown> =>
      // Unfenced: a session is a client of the runs it traces, not their
      // owner — its records are first-writer-wins admissions on the run's
      // journal.
      journal.emitDurableUnfenced(
        new JournalEvent.Input({
          runId: JournalEvent.RunId.make(runId),
          sourceId,
          eventType,
          payload: JSON.parse(JSON.stringify(payload))
        })
      )

    /**
     * Emits one agent-trace event on the journal's lossy channel.
     *
     * The channel matters more than it looks. A trace event is telemetry, not
     * lifecycle state, and the executor emits it from inside the harness
     * stream's own consumer — so a durable emit deadlocks: the write joins the
     * single writer's transaction queue behind the engine transaction that the
     * harness frame is still inside, while the frame cannot proceed until the
     * consumer accepts the event. Runs stalled silently at 0% CPU a few frames
     * in. `emitLossy` queues instead of joining the transaction, which is the
     * documented channel for exactly this.
     */
    const trail = (
      runId: string,
      eventType: string,
      payload: unknown
    ): Effect.Effect<void, unknown> =>
      journal.emitLossy(
        new JournalEvent.Input({
          runId: JournalEvent.RunId.make(runId),
          sourceId,
          eventType,
          payload: JSON.parse(JSON.stringify(payload))
        })
      )

    /**
     * Decides one ask before its durable boundary opens. An unresolved ask
     * registers its token, publishes the exact approval payload an operator
     * replays through `flows approve`, and parks the run with an encoded
     * `PermissionRequired`; a resolved one lets the activity run and read the
     * decision.
     */
    const authorize = (runId: string) => (call: Cell.Call): Effect.Effect<void, HarnessError.HarnessError> =>
      Effect.gen(function*() {
        if (call.flowName !== StandardFlows.askFlow.name) return
        const input = call.input as unknown as AskInput
        const identity = askIdentity(runId, call.input)
        const target = {
          _tag: "Node" as const,
          runId,
          requestId: identity.requestId,
          digest: identity.digest,
          envelope: askEnvelope
        }
        const token = yield* runtime.registerApproval(target).pipe(
          Effect.mapError(
            (cause) =>
              new HarnessError.HarnessError({
                code: "engine_failed",
                message: "The approval request could not be registered with the control plane",
                cause
              })
          )
        )
        if (token.resolved) return
        const payload: ApprovalPayload = {
          target,
          scope: "run",
          idempotencyKey: `approve:${identity.requestId}`
        }
        yield* emit(runId, "control.approval.requested", {
          runId,
          requestId: identity.requestId,
          question: input.question,
          payload
        }).pipe(
          Effect.mapError(
            (cause) =>
              new HarnessError.HarnessError({
                code: "engine_failed",
                message: "The approval request could not be journaled",
                cause
              })
          )
        )
        return yield* Effect.fail(
          new HarnessError.HarnessError({
            code: "engine_failed",
            message: `Approval required: ${input.question}`,
            cause: Schema.encodeUnknownSync(Permission.PermissionRequired)(
              new Permission.PermissionRequired({
                code: "permission_required",
                requestId: identity.requestId,
                runId,
                // No action in the capability vocabulary names a human
                // decision; the request carries the question in `meta` and
                // the model seat's own action as the closest formal claim.
                capability: Capability.make("model:call", `ask/${identity.digest}`),
                tier: "irreversible",
                meta: { question: input.question }
              })
            )
          })
        )
      })

    /**
     * Answers a decided ask from the grant store. The activity only runs once
     * {@link authorize} has seen the token resolved, so the read is stable:
     * an approval installed a grant under the request id, a denial did not.
     */
    const asker = (runId: string): StandardFlows.Asker => ({
      ask: (input) =>
        Effect.gen(function*() {
          const identity = askIdentity(runId, input)
          const grants = yield* runtime.grants.pipe(
            Effect.mapError(
              (cause) =>
                new HarnessError.HarnessError({
                  code: "engine_failed",
                  message: `The grant store could not be read for run ${runId}`,
                  cause
                })
            )
          )
          const approved = grants.some((grant) => grant.tokenId === identity.requestId)
          return { answer: approved ? "approved" : "denied", approved }
        })
    })

    /**
     * Writes one fenced status transition and its journal record.
     *
     * A terminal `failed` carries the rendered cause. Before it did, the
     * cause went only to `Effect.logWarning`, so a failed run was
     * undiagnosable from its own journal: three of the five first SWE-bench
     * benchmark runs ended `control.run.failed {runId, status}` and nothing
     * else, and the log line was long gone. The journal is the record a
     * `flows status` diagnosis reads, so the reason a run died belongs in it.
     */
    const writeStatus = (runId: string, status: RunStatus, detail?: string) =>
      Effect.gen(function*() {
        const fence = yield* runtime.claimFence(runId)
        yield* runtime.writeStatus(runId, fence, status)
        yield* emit(
          runId,
          `control.run.${status}`,
          detail === undefined ? { runId, status } : { runId, status, cause: detail.slice(0, 4096) }
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.annotateLogs(
              Effect.logWarning("An agent run lifecycle event could not be journaled"),
              { runId, status, cause: Cause.pretty(cause) }
            )
          )
        )
      })

    /**
     * Settles the control-plane status from one execution attempt's exit. A
     * suspension surfaces as an interrupt-only cause — the engine parked the
     * frame — and every re-executed attempt settles again, so the resumed
     * run writes its own terminal status.
     */
    const settle = (
      runId: string,
      suspended: boolean,
      exit: Exit.Exit<unknown, unknown>
    ) =>
      Exit.isSuccess(exit)
        ? writeStatus(runId, "completed")
        // Flow suspension deliberately interrupts the user body. Process
        // shutdown and Control.cancel do too, but neither sets the durable
        // execution's suspension bit; reporting those as an approval wait
        // would leave a cancelled run looking resumable.
        : Cause.hasInterruptsOnly(exit.cause)
        ? suspended
          ? writeStatus(runId, "waiting-approval")
          // Cancellation and process shutdown both close the execution scope.
          // The control operation owns cancellation's terminal write, while a
          // shutdown must leave the run reclaimable rather than misreport it
          // as a model failure.
          : Effect.void
        : Effect.andThen(
          Effect.annotateLogs(Effect.logWarning("An agent run failed"), {
            runId,
            cause: Cause.pretty(exit.cause)
          }),
          writeStatus(runId, "failed", Cause.pretty(exit.cause))
        )

    /** One agent run, executed as the whole of one durable flow execution. */
    const body = (payload: { readonly runId: string; readonly planId: string }) =>
      Effect.gen(function*() {
        const plan = yield* runtime.getPlan(payload.planId)
        const card = plan.card
        const descriptor = yield* registry.get(card.flowId)
        // The launch already validated the seat and body; re-validation here
        // guards a registry that changed between acceptance and execution.
        const seatId = yield* Effect.fromOption(
          descriptor.model,
          () => new Seat.SeatUnresolved({ seat: card.flowId, message: `Flow ${card.flowId} declares no model seat` })
        )
        const flowBody = yield* registry.loadBody(card.flowId)
        if (flowBody._tag !== "Prompt") {
          return yield* Effect.fail(
            new Seat.SeatUnresolved({
              seat: seatId,
              message: `Flow ${card.flowId} has a module body; only prompt flows run on the agent`
            })
          )
        }
        const seat = yield* seats.resolve(seatId)
        const steering = yield* Notifications.make({ runId: payload.runId, lineageId: payload.runId })
        // The three services a durable flow body already holds, captured
        // together: `StandardFlows.clock` hands them back to a `DurableClock`
        // sleep, whose deferred key is hashed, so `Crypto` travels with the
        // runtime rather than being substituted at the binding.
        const engineServices = yield* Effect.context<
          Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance
        >()
        const tags: Array<string> = []
        // The trail is buffered in memory and written by a fiber of its own,
        // never by the stream's consumer.
        //
        // The consumer runs inside the frame: the harness cannot emit its next
        // event until this callback returns, and the frame it is inside holds
        // the engine's write transaction. A journal write here therefore waits
        // on a writer that is waiting on this callback, and the run stalls
        // silently at 0% CPU a few frames in — which is exactly what happened
        // when this was a plain `emitDurable`, and still happened on the lossy
        // channel because its queue drains through the same writer. Pushing
        // onto an array cannot block, so the frame always proceeds; the pump
        // below writes whatever has accumulated once the writer is free again.
        const pending: Array<{ readonly eventType: string; readonly payload: unknown }> = []
        const flush = Effect.suspend(() =>
          Effect.forEach(
            pending.splice(0, pending.length),
            (entry) => trail(payload.runId, entry.eventType, entry.payload),
            { discard: true }
          )
        ).pipe(Effect.ignore)
        // Journaling is best-effort on purpose: a full or rejecting journal
        // must not fail an agent run that is otherwise making progress.
        // Occurrence time is stamped into the payload because the pump
        // flushes in batches: `emitted_at_ms` is admission time, so every
        // event in one flush shares a millisecond and per-call timing is
        // unrecoverable from the row alone.
        const record = (event: AgentEvent.AgentEvent): Effect.Effect<void> =>
          Effect.flatMap(Clock.currentTimeMillis, (at) =>
            Effect.sync(() => {
              tags.push(event._tag)
              const projected = trace(event)
              if (projected !== undefined) {
                pending.push({
                  eventType: projected.eventType,
                  payload: { ...(projected.payload as Record<string, unknown>), at }
                })
              }
            }))
        const pump = yield* Effect.forkChild(
          Effect.forever(Effect.andThen(Effect.sleep(Duration.millis(250)), flush))
        )
        yield* agent.run({
          session: payload.runId,
          seat,
          modelParams: ModelRequest.GenerationParams.make({
            reasoningEffort: effortFor(descriptor, options.reasoningEffort)
          }),
          prompt: prompt(flowBody.text, plan.decodedInput),
          system: options.system,
          registry,
          flows: [
            ...(options.flows ?? []),
            StandardFlows.clock(engineServices),
            StandardFlows.approval(asker(payload.runId))
          ],
          authorize: authorize(payload.runId),
          capabilityEnvelope: patterns(card.envelope.capabilities),
          limits: options.limits,
          maxFrames: options.maxFrames,
          // A task run's frames are supposed to change something, so hold it
          // to a rhythm of acting rather than only reading.
          readOnlyCap: options.readOnlyCap ?? CellTurn.defaultReadOnlyFrames,
          // Passed straight through rather than defaulted here: unlike the
          // read-only cap, the controller's own default is the one this
          // executor wants, and a second copy of the number would be a second
          // thing to keep true. The repeat cap is passed the same way.
          modelCallMs: options.modelCallMs,
          repeatCap: options.repeatCap,
          narrowingCap: options.narrowingCap,
          unmovedCap: options.unmovedCap,
          unresolvedCap: options.unresolvedCap,
          approvalChannel: options.approvalChannel ?? false
        }).pipe(
          Stream.runForEach(record),
          Effect.provide(QuickJSSandbox.layer),
          Effect.provideService(Steering.Source, steering),
          // The pump is interrupted before the final flush so the two never
          // race for the same buffered entries, and the flush runs on the way
          // out of every exit — settled, failed, or parked — because a parked
          // run's trail is the one an operator most needs to read.
          Effect.onExit(() => Effect.andThen(Fiber.interrupt(pump), flush))
        )
        return tags
      })

    const activeBodies = new Map<string, Fiber.Fiber<unknown, unknown>>()

    const driver = (runId: string, planId: string) =>
      Effect.gen(function*() {
        const admitted = yield* waitForRunning(
          (id) => runtime.getRun(id).pipe(Effect.orDie, Effect.map((run) => run.status)),
          runId,
          400
        )
        if (!admitted) return
        yield* engine.execute(agentFlow, {
          executionId: runId,
          payload: { runId, planId },
          discard: true
        }).pipe(
          // ControlRuntime awaits this driver while it owns the control
          // transaction. Interrupt the active flow body synchronously so no
          // tool can escape cancellation, then let the engine's durable
          // cancellation finish after the control transaction commits.
          Effect.onInterrupt(() =>
            Effect.gen(function*() {
              const bodyFiber = activeBodies.get(runId)
              if (bodyFiber !== undefined) {
                yield* Fiber.interrupt(bodyFiber).pipe(
                  Effect.forkDetach({ startImmediately: true })
                )
              }
              yield* preserveDriverInterrupt(() => engine.interrupt(agentFlow, runId)).pipe(
                Effect.forkDetach({ startImmediately: true })
              )
            })
          )
        )
      }).pipe(
        Effect.catchCause((cause) =>
          settleDriverFailure(cause, runId, (detail) => writeStatus(runId, "failed", detail))
        )
      )

    const awaitParked = (runId: string, attempts: number): Effect.Effect<boolean, unknown> =>
      waitForParked(
        () =>
          engine.poll(agentFlow, runId).pipe(
            // The journal carries resume events for runs other executors own —
            // a paused system flow, a shared control database. An execution
            // this engine does not know will not become parked by waiting, so
            // it is published as a settled non-parked state: the wait ends
            // now instead of holding the single-concurrency bridge through
            // the whole retry budget.
            Effect.catchTag(
              "@smthrs/flow/FlowExecutionNotFound",
              () => Effect.succeed(Option.some({ _tag: "NotFound" }))
            )
          ),
        attempts
      )

    const resumeExecution = (runId: string): Effect.Effect<void> =>
      Effect.gen(function*() {
        const parked = yield* awaitParked(runId, 500)
        // False when the execution settled before the resume arrived, or when
        // the resumed run belongs to an executor other than this one.
        if (parked) yield* engine.resume(agentFlow, runId)
      }).pipe(
        Effect.catchCause(
          (cause) =>
            Effect.annotateLogs(
              Effect.logWarning("A parked agent run could not be resumed"),
              { runId, cause: Cause.pretty(cause) }
            )
        )
      )

    /**
     * Follows the journal for the control plane's resume events and re-drives
     * the parked engine execution. `Control.resume` and `Control.run`'s
     * `Resume` branch record different event types; both mean the same thing
     * here.
     */
    const resumeBridge = Effect.gen(function*() {
      const subscription = yield* journal.changes
      yield* Stream.fromSubscription(subscription).pipe(
        Stream.filter((entry) => entry.eventType === "control.run.resume" || entry.eventType === "control.run.resumed"),
        Stream.mapEffect((entry) => resumeExecution(entry.runId), { concurrency: 1 }),
        Stream.runDrain
      )
    }).pipe(
      Effect.catchCause(
        (cause) =>
          Effect.annotateLogs(
            Effect.logError("The executor resume bridge stopped"),
            { cause: Cause.pretty(cause) }
          )
      )
    )

    yield* engine.register(agentFlow, (payload) =>
      Effect.gen(function*() {
        const instance = yield* FlowRuntime.FlowInstance
        const fiber = yield* Effect.forkChild(
          body(payload).pipe(
            Effect.onExit((exit) => settle(payload.runId, instance.suspended, exit)),
            Effect.provide(services)
          ),
          { startImmediately: true }
        )
        activeBodies.set(payload.runId, fiber)
        return yield* Fiber.join(fiber).pipe(
          Effect.ensuring(Effect.sync(() => activeBodies.delete(payload.runId)))
        )
      })).pipe(Scope.provide(scope))

    yield* Effect.forkIn(resumeBridge, scope)

    const launch = (
      input: ControlExecutor.Launch
    ): Effect.Effect<ControlExecutor.Acceptance, LaunchFailed> =>
      Effect.gen(function*() {
        const flowId = input.plan.card.flowId
        const descriptor = yield* registry.getOption(flowId)
        if (Option.isNone(descriptor) || Option.isNone(descriptor.value.model)) {
          // Not an agent flow — a system flow, or a flow this composition
          // cannot execute. Pending is the honest acceptance: nothing runs.
          return "pending" as const
        }
        const flowBody = yield* registry.loadBody(flowId).pipe(
          Effect.mapError(
            (cause) =>
              new LaunchFailed({
                runId: input.run.runId,
                message: `The body of flow ${flowId} could not be loaded`,
                cause: String(cause)
              })
          )
        )
        if (flowBody._tag !== "Prompt") return "pending" as const
        // Resolve the seat now, so a missing key refuses the launch as a
        // typed failure instead of failing the run after it was accepted.
        yield* seats.resolve(descriptor.value.model.value).pipe(
          Effect.mapError((error) =>
            new LaunchFailed({
              runId: input.run.runId,
              message: error.message,
              cause: { seat: error.seat }
            })
          )
        )
        const start = yield* Deferred.make<void>()
        const fiber = Effect.runForkWith(services)(
          Deferred.await(start).pipe(
            Effect.andThen(driver(input.run.runId, input.plan.card.planId))
          )
        )
        yield* Scope.addFinalizer(scope, Fiber.interrupt(fiber))
        yield* registerDriver(
          () => runtime.registerFiber(input.run.runId, fiber),
          input.run.runId
        ).pipe(
          Effect.onExit((exit) => Exit.isFailure(exit) ? Fiber.interrupt(fiber) : Effect.void)
        )
        yield* Deferred.succeed(start, void 0)
        return "accepted" as const
      })

    return ControlExecutor.make({
      launch: Effect.fn("AgentSession.launch")(launch)
    })
  })

/**
 * Provides the production {@link ControlExecutor.ControlExecutor}.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  options: Options
): Layer.Layer<ControlExecutor.ControlExecutor, never, Services> =>
  Layer.effect(ControlExecutor.ControlExecutor)(make(options))
