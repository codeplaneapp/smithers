/**
 * Browser-safe port between the control plane and the execution engine, with a
 * deterministic in-memory implementation.
 *
 * `layerMemory` is the deterministic one: it models the production fence and
 * approval ordering seams but keeps everything in a `Map`, so nothing it
 * decides survives the process. The durable adapter is
 * {@link SqlControlRuntime}, and both are held to one shared contract suite —
 * see `test/ControlContract.ts`.
 *
 * @since 0.1.0
 */
import type * as PersistedPlan from "@smthrs/plan/Plan"
import { Context, Crypto, Effect, Fiber, Layer, Option } from "effect"
import type { ApprovalTarget, PlanInput } from "./Control.ts"
import {
  AlreadyResolved,
  ClaimLost,
  EnvelopeMismatch,
  FlowNotFound,
  InvalidInput,
  PersistenceError,
  PlanDenied,
  PlanDigestMismatch,
  PlanNotFound,
  RunNotFound
} from "./ControlError.ts"
import type {
  Envelope,
  FlowId,
  GrantScope,
  IdempotencyKey,
  PlanCard,
  PlanNode,
  Principal,
  Receipt,
  RunId,
  RunStatus,
  RunSummary,
  SignalPayload,
  SteerMessage
} from "./ControlSchema.ts"
import { canonicalIssue } from "./internal/issues.ts"
import {
  accepted,
  alreadyApplied as replayReceipt,
  canonical,
  emptyEnvelope,
  planCard,
  sameEnvelope
} from "./internal/planning.ts"
import { plannable } from "./SystemFlows.ts"

/**
 * A decoded input and immutable plan stored before execution.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface StoredPlan {
  readonly card: PlanCard
  readonly decodedInput: unknown
  readonly decision: "pending" | "approved" | "denied"
}

/**
 * One unresolved durable approval token.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface ApprovalToken {
  readonly tokenId: string
  readonly target: ApprovalTarget
  readonly resolved: boolean
  /** The authenticated principal that made the terminal decision. */
  readonly decisionPrincipal?: Principal | undefined
}

/**
 * One bulk permission grant. The envelope is deliberately not split into
 * individual capabilities at this boundary.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface BulkGrant {
  readonly tokenId: string
  readonly envelope: Envelope
  readonly scope: GrantScope
  readonly installedAt: number
}

/**
 * Result of launching an approved plan.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type LaunchResult =
  | {
    readonly _tag: "Started"
    readonly receipt: Receipt
    readonly run: RunSummary
  }
  | {
    readonly _tag: "Parked"
    readonly receipt: Receipt
  }

/**
 * A plan card and whether this call is the one that created it.
 *
 * A plan under an idempotency key the runtime has already seen answers with the
 * STORED card, which is what idempotency means. `Control.plan` needs to tell
 * that apart from a first ask, because it journals `control.plan.created` and
 * an unconditional entry appended one creation per retry: `Channels.ingest`
 * passes a key on every webhook redelivery, so a watcher of the plan partition
 * replayed N creations of one plan.
 *
 * @category models
 * @since 0.1.0
 */
export interface PlanOutcome {
  readonly card: PlanCard
  readonly created: boolean
}

/**
 * A stored idempotency-key outcome and the mutation fingerprint that produced
 * it.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface MutationRecord {
  readonly fingerprint: string
  readonly receipt: Receipt
}

/**
 * Flow metadata used by the memory runtime's input-decoding hook.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface MemoryFlow {
  readonly flowId: FlowId
  readonly description: string
  readonly deployClass: boolean
  readonly envelope: Envelope
  readonly decode?: ((input: unknown) => Effect.Effect<unknown, InvalidInput>) | undefined
  /**
   * Projects the decoded input into the keyed node graph the card reports.
   *
   * Planning performs no I/O, so this is a pure function of the input: the
   * host builds the graph (`@smthrs/core`'s `Graph.build`), keys it
   * (`@smthrs/plan`'s compiler), and reports each node as `cached` or `run`
   * against whatever step cache it holds.
   */
  readonly plan?:
    | ((
      input: unknown,
      planId: string
    ) => Effect.Effect<{
      readonly plan: PersistedPlan.Plan
      readonly statuses?: Readonly<Record<string, PlanNode["status"]>> | undefined
    }, InvalidInput>)
    | undefined
}

/**
 * In-memory runtime configuration.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface MemoryOptions {
  readonly flows?: ReadonlyArray<MemoryFlow> | undefined
  readonly now?: (() => number) | undefined
  readonly principal?: Omit<Principal, "stampedAt"> | undefined
}

/**
 * One run that has been told to resume, and the sequence of the request.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface PendingResume {
  readonly runId: RunId
  readonly sequence: number
  /**
   * When the delegation was recorded.
   *
   * A host reads it to tell a decision it has just been handed from one that
   * has been standing unanswered: a run parked by a process that has since
   * exited has nobody left to recognize its own park, so its delegation is
   * taken up by whichever host can drive it once it has gone unanswered for
   * `Ownership.heartbeatStaleAfter` (triage B-15).
   */
  readonly requestedAtMs: number
}

/**
 * Execution-engine operations required by `ControlLive`.
 *
 * A production adapter must fence every owner-sensitive write, implement
 * resume as join-or-claim, release claims on every waiting or terminal
 * transition, and translate all conflicts into typed failures. Approval
 * resolution is exactly once and is invoked only after grant installation and
 * the flushed journal decision.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Service {
  readonly plan: (input: PlanInput) => Effect.Effect<PlanOutcome, FlowNotFound | InvalidInput | PersistenceError>
  readonly getPlan: (planId: string) => Effect.Effect<StoredPlan, PlanNotFound | PersistenceError>
  readonly listPlanIds: Effect.Effect<ReadonlyArray<string>, PersistenceError>
  readonly lookupApproval: (
    target: ApprovalTarget
  ) => Effect.Effect<
    ApprovalToken,
    PlanDigestMismatch | EnvelopeMismatch | AlreadyResolved | PlanNotFound | RunNotFound | PersistenceError
  >
  /**
   * Creates the durable token for one in-run approval request, or returns the
   * existing one.
   *
   * Plan tokens are created by `plan`; nothing created tokens for `Node`
   * targets, so an in-run request (a parked `ask`, a permission requirement)
   * could never be decided through `approve`/`deny`. Registration is
   * idempotent — the executor calls it on every parked attempt — and returns
   * the token with its current `resolved` state so a resumed attempt can read
   * the decision instead of parking again. A registered target that
   * disagrees with the stored digest or envelope is refused, exactly as
   * `lookupApproval` refuses it.
   */
  readonly registerApproval: (
    target: Extract<ApprovalTarget, { readonly _tag: "Node" }>
  ) => Effect.Effect<
    ApprovalToken,
    RunNotFound | PlanDigestMismatch | EnvelopeMismatch | PersistenceError
  >
  readonly installBulkGrant: (
    token: ApprovalToken,
    envelope: Envelope,
    scope: GrantScope
  ) => Effect.Effect<void, PersistenceError>
  readonly resolveApproval: (
    token: ApprovalToken,
    decision: "approved" | "denied",
    principal: Principal
  ) => Effect.Effect<void, AlreadyResolved | PersistenceError>
  readonly launch: (
    planId: string,
    digest: string,
    envelope: Envelope
  ) => Effect.Effect<
    LaunchResult,
    PlanNotFound | PlanDenied | PlanDigestMismatch | EnvelopeMismatch | ClaimLost | PersistenceError
  >
  readonly getRun: (runId: RunId) => Effect.Effect<RunSummary, RunNotFound | PersistenceError>
  readonly listRuns: Effect.Effect<ReadonlyArray<RunSummary>, PersistenceError>
  readonly listFlows: Effect.Effect<
    ReadonlyArray<{ readonly flowId: FlowId; readonly description: string }>,
    PersistenceError
  >
  readonly enqueueSteer: (runId: RunId, message: SteerMessage) => Effect.Effect<void, RunNotFound | PersistenceError>
  readonly drainSteering: (
    runId: RunId
  ) => Effect.Effect<ReadonlyArray<SteerMessage>, RunNotFound | PersistenceError>
  readonly deliverSignal: (runId: RunId, signal: SignalPayload) => Effect.Effect<void, RunNotFound | PersistenceError>
  readonly deliveredSignals: (
    runId: RunId
  ) => Effect.Effect<ReadonlyArray<SignalPayload>, RunNotFound | PersistenceError>
  /**
   * Records, durably, that this run has been told to resume.
   *
   * The record is the delegation. A decision on an in-run approval can be
   * taken by any process holding the control database, and only the process
   * hosting the execution can act on it, so the intent has to outlive the call
   * that made it: an in-process event bus reaches one process, and a journal
   * entry is per run and needs a reader that already knows which run to read.
   * The returned sequence is the cursor {@link Service.clearResume} checks, so
   * a resume requested while one is being taken up is not lost with it.
   */
  readonly requestResume: (runId: RunId) => Effect.Effect<number, RunNotFound | PersistenceError>
  /**
   * Every outstanding resume delegation for a run that is not terminal.
   *
   * This is what a host polls. A settled run's delegation is not reported: no
   * host will ever take it up, and reporting it forever would make an
   * unbounded backlog out of a run that is finished.
   */
  readonly pendingResumes: Effect.Effect<ReadonlyArray<PendingResume>, PersistenceError>
  /**
   * Clears a delegation a host has taken up, if it is still the one it read.
   *
   * The sequence check is what makes the clear safe: a resume requested
   * between the read and the clear has a higher sequence and survives, so the
   * host takes it up on its next tick instead of losing it.
   */
  readonly clearResume: (runId: RunId, sequence: number) => Effect.Effect<void, PersistenceError>
  readonly registerFiber: (
    runId: RunId,
    fiber: Fiber.Fiber<unknown, unknown>
  ) => Effect.Effect<void, RunNotFound | PersistenceError>
  readonly interrupt: (runId: RunId) => Effect.Effect<RunSummary, RunNotFound | ClaimLost | PersistenceError>
  /**
   * Joins or claims a suspended run.
   *
   * `scope: "launched"` restricts the claim to runs this plane launched.
   * The steer wake passes it, because claiming a run another driver created
   * would strand the row under this plane's fence where that driver's own
   * resume path gives up. An explicit `Control.resume` — an operator or a
   * monitor remedy acting on a run nobody is driving — omits it and may
   * claim any suspended run.
   */
  readonly resume: (
    runId: RunId,
    options?: { readonly scope?: "launched" | "any" | undefined } | undefined
  ) => Effect.Effect<RunSummary, RunNotFound | ClaimLost | PersistenceError>
  readonly claimFence: (runId: RunId) => Effect.Effect<string, RunNotFound | ClaimLost | PersistenceError>
  /**
   * Releases a launch the configured executor declined without changing its
   * public `accepted` status.
   *
   * The run remains available to an external executor, but the launching
   * process no longer appears to drive it. The presented fence is spent by
   * the release and cannot authorize a later write.
   */
  readonly releasePending: (
    runId: RunId,
    fence: string
  ) => Effect.Effect<RunSummary, RunNotFound | ClaimLost | PersistenceError>
  readonly writeStatus: (
    runId: RunId,
    fence: string,
    status: RunStatus
  ) => Effect.Effect<RunSummary, RunNotFound | ClaimLost | PersistenceError>
  readonly stampPrincipal: (submitted?: Principal | undefined) => Effect.Effect<Principal, PersistenceError>
  readonly lookupMutation: (
    key: IdempotencyKey,
    fingerprint: string
  ) => Effect.Effect<Receipt | undefined, PersistenceError>
  readonly recordMutation: (
    key: IdempotencyKey,
    fingerprint: string,
    receipt: Receipt
  ) => Effect.Effect<void, PersistenceError>
  readonly grants: Effect.Effect<ReadonlyArray<BulkGrant>, PersistenceError>
}

/**
 * Service key for the execution-engine port.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export class ControlRuntime extends Context.Service<ControlRuntime, Service>()(
  "/control/ControlRuntime"
) {}

/**
 * Constructs a runtime service from an implementation record.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (implementation: Service): Service => ControlRuntime.of(implementation)

interface MutablePlan {
  readonly card: PlanCard
  readonly decodedInput: unknown
  decision: "pending" | "approved" | "denied"
}

interface MutableToken {
  readonly tokenId: string
  readonly target: ApprovalTarget
  resolved: boolean
  decisionPrincipal?: Principal | undefined
}

interface MutableRun {
  summary: RunSummary
  fence?: string | undefined
  localFence?: string | undefined
  fiber?: Fiber.Fiber<unknown, unknown> | undefined
  readonly steering: Array<SteerMessage>
  readonly signals: Array<SignalPayload>
  /** The sequence of the outstanding resume delegation, if there is one. */
  pendingResume?: number | undefined
  /** When that delegation was recorded. */
  pendingResumeAtMs?: number | undefined
}

// SQL persistence breaks caller reference identity through serialization. The
// memory adapter must copy at the same boundaries or its test results diverge
// from the durable implementation when a caller mutates an input or result.
const snapshot = <A>(value: A): A => structuredClone(value)

const asStored = (plan: MutablePlan): StoredPlan => ({
  card: snapshot(plan.card),
  decodedInput: snapshot(plan.decodedInput),
  decision: plan.decision
})

// JSON tuple encoding keeps caller-chosen ids in separate fields, so a node's
// request id cannot alias another run's request or a plan id.
const approvalKey = (target: ApprovalTarget): string =>
  target._tag === "Plan"
    ? JSON.stringify([target._tag, target.planId])
    : JSON.stringify([target._tag, target.runId, target.requestId])

const sameApprovalIdentity = (left: ApprovalTarget, right: ApprovalTarget): boolean =>
  left._tag === "Plan"
    ? right._tag === "Plan" && left.planId === right.planId
    : right._tag === "Node" && left.runId === right.runId && left.requestId === right.requestId

const approvalToken = (token: MutableToken): ApprovalToken => ({
  tokenId: token.tokenId,
  target: snapshot(token.target),
  resolved: token.resolved,
  ...(token.decisionPrincipal === undefined ? {} : { decisionPrincipal: snapshot(token.decisionPrincipal) })
})

/**
 * Deterministic in-memory runtime. It models the production fence and approval
 * ordering seams but intentionally does not claim durable process survival;
 * see `control-runtime-engine-integration`.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerMemory = (options: MemoryOptions = {}): Layer.Layer<ControlRuntime, never, Crypto.Crypto> =>
  Layer.effect(
    ControlRuntime,
    Effect.gen(function*() {
      const crypto = yield* Crypto.Crypto
      const now = options.now ?? Date.now
      const configuredFlows = options.flows ?? plannable.map((entry): MemoryFlow => ({
        flowId: entry.flowId,
        description: `Reserved ${entry.verb} system flow`,
        deployClass: entry.deployClass,
        envelope: emptyEnvelope
      }))
      const flows = new Map(configuredFlows.map((flow) =>
        [
          flow.flowId,
          { ...flow, envelope: snapshot(flow.envelope) }
        ] as const
      ))
      const plans = new Map<string, MutablePlan>()
      const planKeys = new Map<IdempotencyKey, {
        readonly fingerprint: string
        readonly planId: string
      }>()
      const tokens = new Map<string, MutableToken>()
      const runs = new Map<RunId, MutableRun>()
      const mutations = new Map<IdempotencyKey, MutationRecord>()
      const installedGrants: Array<BulkGrant> = []
      const installedGrantKeys = new Set<string>()
      let planSequence = 0
      let runSequence = 0
      let fenceSequence = 0
      let resumeSequence = 0

      const requireRun = (runId: RunId): Effect.Effect<MutableRun, RunNotFound> =>
        Effect.fromOption(Option.fromNullishOr(runs.get(runId)), () => new RunNotFound({ runId }))

      const updateSummary = (run: MutableRun, fields: Partial<RunSummary>): RunSummary => {
        run.summary = snapshot({ ...run.summary, ...fields, updatedAt: now() })
        return snapshot(run.summary)
      }

      const checkFence = (runId: RunId, run: MutableRun, fence: string): Effect.Effect<void, ClaimLost> =>
        run.fence === undefined || run.fence !== fence
          ? Effect.fail(new ClaimLost({ runId }))
          : Effect.void

      const service = make({
        plan: Effect.fn("ControlRuntime.plan")(function*(input) {
          const flow = flows.get(input.flowId)
          if (flow === undefined) return yield* new FlowNotFound({ flowId: input.flowId })
          const planFingerprint = yield* Effect.try({
            // Validate before cloning. Canonicalization reports a throwing
            // getter at its stable path, while `structuredClone` would invoke
            // the getter first and erase that safe diagnostic.
            try: () => canonical({ flowId: input.flowId, input: input.input }),
            catch: (cause) => new InvalidInput({ issue: canonicalIssue(cause) })
          })
          const submitted = yield* Effect.try({
            try: () => snapshot(input),
            catch: (cause) => new InvalidInput({ issue: canonicalIssue(cause) })
          })
          if (submitted.idempotencyKey !== undefined) {
            const prior = planKeys.get(submitted.idempotencyKey)
            if (prior !== undefined) {
              if (prior.fingerprint !== planFingerprint) {
                return yield* new InvalidInput({
                  issue: `idempotency key ${submitted.idempotencyKey} was used for another plan`
                })
              }
              const stored = plans.get(prior.planId)
              /* v8 ignore next -- this map never loses a plan a key names; `SqlControlRuntime` covers the storage that can */
              if (stored !== undefined) return { card: snapshot(stored.card), created: false }
            }
          }
          const decoded = yield* (flow.decode?.(submitted.input) ?? Effect.try({
            try: () => {
              canonical(submitted.input)
              return submitted.input
            },
            catch: (cause) => new InvalidInput({ issue: canonicalIssue(cause) })
          }))
          const planId = `plan-${++planSequence}`
          const handoff = flow.plan === undefined ? undefined : yield* flow.plan(decoded, planId)
          const card = snapshot(
            yield* planCard({
              planId,
              flowId: submitted.flowId,
              decodedInput: decoded,
              envelope: flow.envelope,
              deployClass: flow.deployClass,
              handoff,
              idempotencyKey: submitted.idempotencyKey
            }).pipe(Effect.provideService(Crypto.Crypto, crypto))
          )
          plans.set(planId, { card, decodedInput: snapshot(decoded), decision: "pending" })
          tokens.set(approvalKey(card.approval.target), {
            tokenId: planId,
            target: snapshot(card.approval.target),
            resolved: false
          })
          if (submitted.idempotencyKey !== undefined) {
            planKeys.set(submitted.idempotencyKey, {
              fingerprint: planFingerprint,
              planId
            })
          }
          return { card: snapshot(card), created: true }
        }),
        getPlan: Effect.fn("ControlRuntime.getPlan")((planId) =>
          Effect.fromOption(Option.fromNullishOr(plans.get(planId)), () => new PlanNotFound({ planId })).pipe(
            Effect.map(asStored)
          )
        ),
        listPlanIds: Effect.fn("ControlRuntime.listPlanIds")(() => Effect.sync(() => Array.from(plans.keys())))(),
        lookupApproval: Effect.fn("ControlRuntime.lookupApproval")(function*(target) {
          const requested = snapshot(target)
          const tokenId = requested._tag === "Plan" ? requested.planId : requested.requestId
          const token = yield* Effect.fromOption(
            Option.fromNullishOr(tokens.get(approvalKey(requested))),
            () =>
              requested._tag === "Node"
                ? new RunNotFound({ runId: requested.runId })
                : new PlanNotFound({ planId: requested.planId })
          )
          // A stored target that disagrees with its composite key is corrupted;
          // accepting only its digest and envelope would recreate the alias the
          // composite identity closes. In memory the key is DERIVED from the
          // identity, so only a caller reaching into the map can produce the
          // disagreement; `SqlControlRuntime` stores the two apart and covers
          // the same refusal against a rewritten row.
          /* v8 ignore next 6 -- unreachable while the map key is derived from the identity it is compared against */
          if (!sameApprovalIdentity(token.target, requested)) {
            return yield* new PersistenceError({
              operation: "validate an approval token",
              message: "The stored approval target does not match its identity"
            })
          }
          if (token.target.digest !== requested.digest) {
            return yield* new PlanDigestMismatch({
              planId: tokenId,
              expected: token.target.digest,
              actual: requested.digest
            })
          }
          if (!sameEnvelope(token.target.envelope, requested.envelope)) {
            return yield* new EnvelopeMismatch({
              planId: tokenId,
              expected: canonical(token.target.envelope),
              actual: canonical(requested.envelope)
            })
          }
          if (token.resolved) return yield* new AlreadyResolved({ requestId: tokenId })
          return approvalToken(token)
        }),
        registerApproval: Effect.fn("ControlRuntime.registerApproval")(function*(target) {
          const requested = snapshot(target)
          yield* requireRun(requested.runId)
          const key = approvalKey(requested)
          const existing = tokens.get(key)
          if (existing === undefined) {
            const stored = { tokenId: requested.requestId, target: requested, resolved: false }
            tokens.set(key, stored)
            return approvalToken(stored)
          }
          /* v8 ignore next 6 -- as in `lookupApproval`: the map key is derived from the identity, so a stored target can only disagree with it after a reach into the map */
          if (!sameApprovalIdentity(existing.target, requested)) {
            return yield* new PersistenceError({
              operation: "validate an approval token",
              message: "The stored approval target does not match its identity"
            })
          }
          if (existing.target.digest !== requested.digest) {
            return yield* new PlanDigestMismatch({
              planId: requested.requestId,
              expected: existing.target.digest,
              actual: requested.digest
            })
          }
          if (!sameEnvelope(existing.target.envelope, requested.envelope)) {
            return yield* new EnvelopeMismatch({
              planId: requested.requestId,
              expected: canonical(existing.target.envelope),
              actual: canonical(requested.envelope)
            })
          }
          return approvalToken(existing)
        }),
        installBulkGrant: Effect.fn("ControlRuntime.installBulkGrant")((token, envelope, scope) =>
          Effect.sync(() => {
            const storedToken = snapshot(token)
            const key = approvalKey(storedToken.target)
            if (installedGrantKeys.has(key)) return
            installedGrantKeys.add(key)
            installedGrants.push({
              tokenId: storedToken.tokenId,
              envelope: snapshot(envelope),
              scope,
              installedAt: now()
            })
          })
        ),
        resolveApproval: Effect.fn("ControlRuntime.resolveApproval")(function*(token, decision, principal) {
          const requested = snapshot(token)
          const mutable = tokens.get(approvalKey(requested.target))
          if (mutable === undefined || mutable.resolved) {
            return yield* new AlreadyResolved({ requestId: requested.tokenId })
          }
          mutable.resolved = true
          mutable.decisionPrincipal = snapshot(principal)
          if (requested.target._tag === "Plan") {
            const plan = plans.get(requested.target.planId)
            /* v8 ignore next -- a plan token is only ever registered by `plan`, which stores the plan in the same call */
            if (plan !== undefined) plan.decision = decision
          }
        }),
        launch: Effect.fn("ControlRuntime.launch")(function*(planId, requestedDigest, envelope) {
          const plan = yield* Effect.fromOption(
            Option.fromNullishOr(plans.get(planId)),
            () => new PlanNotFound({ planId })
          )
          if (plan.card.digest !== requestedDigest) {
            return yield* new PlanDigestMismatch({
              planId,
              expected: plan.card.digest,
              actual: requestedDigest
            })
          }
          if (!sameEnvelope(plan.card.envelope, envelope)) {
            return yield* new EnvelopeMismatch({
              planId,
              expected: canonical(plan.card.envelope),
              actual: canonical(envelope)
            })
          }
          if (plan.decision === "pending") {
            return {
              _tag: "Parked",
              receipt: {
                _tag: "Parked",
                receiptId: `launch:${planId}`,
                planId,
                status: "waiting-approval"
              }
            }
          }
          if (plan.decision !== "approved") {
            return yield* new PlanDenied({ planId })
          }
          const runId = `run-${++runSequence}`
          const fence = `fence-${++fenceSequence}`
          const timestamp = now()
          const summary: RunSummary = {
            runId,
            flowId: plan.card.flowId,
            status: "accepted",
            planId,
            planDigest: plan.card.digest,
            ownerId: "memory-owner",
            createdAt: timestamp,
            updatedAt: timestamp
          }
          runs.set(runId, {
            summary: snapshot(summary),
            fence,
            localFence: fence,
            steering: [],
            signals: []
          })
          return {
            _tag: "Started",
            receipt: accepted(`launch:${planId}:${runId}`, runId),
            run: snapshot(summary)
          }
        }),
        getRun: Effect.fn("ControlRuntime.getRun")((runId) =>
          Effect.map(requireRun(runId), (run) => snapshot(run.summary))
        ),
        listRuns: Effect.fn("ControlRuntime.listRuns")(() =>
          Effect.sync(() => Array.from(runs.values(), (run) => snapshot(run.summary)))
        )(),
        listFlows: Effect.fn("ControlRuntime.listFlows")(() =>
          Effect.sync(() =>
            Array.from(flows.values(), (flow) => ({
              flowId: flow.flowId,
              description: flow.description
            }))
          )
        )(),
        enqueueSteer: Effect.fn("ControlRuntime.enqueueSteer")((runId, message) =>
          Effect.tap(requireRun(runId), (run) => Effect.sync(() => void run.steering.push(snapshot(message))))
        ),
        drainSteering: Effect.fn("ControlRuntime.drainSteering")(function*(runId) {
          const queue = (yield* requireRun(runId)).steering
          const drained = snapshot(queue)
          queue.length = 0
          return drained
        }),
        deliverSignal: Effect.fn("ControlRuntime.deliverSignal")((runId, signal) =>
          Effect.tap(requireRun(runId), (run) => Effect.sync(() => void run.signals.push(snapshot(signal))))
        ),
        deliveredSignals: Effect.fn("ControlRuntime.deliveredSignals")((runId) =>
          Effect.map(requireRun(runId), (run) => snapshot(run.signals))
        ),
        requestResume: Effect.fn("ControlRuntime.requestResume")(function*(runId) {
          const run = yield* requireRun(runId)
          const sequence = ++resumeSequence
          run.pendingResume = sequence
          run.pendingResumeAtMs = now()
          updateSummary(run, { pendingResume: sequence })
          return sequence
        }),
        pendingResumes: Effect.sync(() =>
          Array.from(runs.entries()).flatMap(([runId, run]) =>
            run.pendingResume === undefined || run.pendingResumeAtMs === undefined ||
              run.summary.status === "cancelled" ||
              run.summary.status === "completed" || run.summary.status === "failed"
              ? []
              : [{ runId, sequence: run.pendingResume, requestedAtMs: run.pendingResumeAtMs }]
          )
        ),
        clearResume: Effect.fn("ControlRuntime.clearResume")((runId, sequence) =>
          Effect.sync(() => {
            const run = runs.get(runId)
            if (run === undefined || run.pendingResume !== sequence) return
            run.pendingResume = undefined
            run.pendingResumeAtMs = undefined
            updateSummary(run, { pendingResume: undefined })
          })
        ),
        registerFiber: Effect.fn("ControlRuntime.registerFiber")((runId, fiber) =>
          Effect.tap(requireRun(runId), (run) =>
            Effect.sync(() => {
              run.fiber = fiber
            }))
        ),
        interrupt: Effect.fn("ControlRuntime.interrupt")(function*(runId) {
          const run = yield* requireRun(runId)
          // Terminal first, as `resume` does: a settled run released its fence,
          // and answering `ClaimLost` there would name the wrong problem.
          if (
            run.summary.status === "cancelled" ||
            run.summary.status === "completed" ||
            run.summary.status === "failed"
          ) return snapshot(run.summary)
          if (run.localFence === undefined) return yield* new ClaimLost({ runId })
          yield* checkFence(runId, run, run.localFence)
          if (run.fiber !== undefined) yield* Fiber.interrupt(run.fiber)
          run.fence = undefined
          run.localFence = undefined
          return updateSummary(run, { status: "cancelled", ownerId: undefined, parkedBy: undefined })
        }),
        resume: Effect.fn("ControlRuntime.resume")(function*(runId) {
          const run = yield* requireRun(runId)
          if (run.summary.status === "running") {
            /* v8 ignore next 3 -- one process holds this whole runtime, and it writes `fence` and `localFence` together; the peer this refuses exists only over a shared database, which is `SqlControlRuntime`'s fence */
            if (run.localFence === undefined || run.fence !== run.localFence) {
              return yield* new ClaimLost({ runId })
            }
            return snapshot(run.summary)
          }
          if (
            run.summary.status === "cancelled" ||
            run.summary.status === "completed" ||
            run.summary.status === "failed"
          ) return snapshot(run.summary)
          const fence = `fence-${++fenceSequence}`
          run.fence = fence
          run.localFence = fence
          // Claiming ends the park, so it ends the record of who wrote it.
          return updateSummary(run, { status: "accepted", ownerId: "memory-owner", parkedBy: undefined })
        }),
        claimFence: Effect.fn("ControlRuntime.claimFence")(function*(runId) {
          const run = yield* requireRun(runId)
          if (run.localFence === undefined) return yield* new ClaimLost({ runId })
          return run.localFence
        }),
        releasePending: Effect.fn("ControlRuntime.releasePending")(function*(runId, fence) {
          const run = yield* requireRun(runId)
          yield* checkFence(runId, run, fence)
          run.fence = undefined
          run.localFence = undefined
          return updateSummary(run, {
            status: "accepted",
            ownerId: undefined,
            parkedBy: undefined
          })
        }),
        writeStatus: Effect.fn("ControlRuntime.writeStatus")(function*(runId, fence, status) {
          const run = yield* requireRun(runId)
          yield* checkFence(runId, run, fence)
          // Ownership is released by any status that is not being driven, so the
          // fence that wrote a terminal or parked status is spent by writing it.
          if (status === "accepted" || status === "running") {
            return updateSummary(run, { status, parkedBy: undefined })
          }
          run.fence = undefined
          run.localFence = undefined
          // The spent fence is kept on a park, and only on a park: it is the
          // only thing left on the row that says which host parked it.
          return updateSummary(run, {
            status,
            ownerId: undefined,
            parkedBy: status === "parked" || status === "waiting-approval" ? fence : undefined
          })
        }),
        // Precedence matches `SqlControlRuntime`: the submitted identity is
        // the one a server authenticated, and the configured one is this
        // composition's fallback for a caller that named none.
        stampPrincipal: Effect.fn("ControlRuntime.stampPrincipal")((submitted) =>
          Effect.sync(() => ({
            id: submitted?.id ?? options.principal?.id ?? "memory",
            kind: submitted?.kind ?? options.principal?.kind ?? "test",
            stampedAt: now()
          }))
        ),
        lookupMutation: Effect.fn("ControlRuntime.lookupMutation")((key, fingerprint) =>
          Effect.sync(() => {
            const record = mutations.get(key)
            if (record === undefined) return undefined
            return record.fingerprint === fingerprint
              ? replayReceipt(key, record.receipt)
              : { _tag: "Conflict", message: `idempotency key ${key} was used for another mutation` }
          })
        ),
        recordMutation: Effect.fn("ControlRuntime.recordMutation")((key, fingerprint, receipt) =>
          Effect.gen(function*() {
            const prior = mutations.get(key)
            if (
              prior !== undefined &&
              (prior.fingerprint !== fingerprint || canonical(prior.receipt) !== canonical(receipt))
            ) {
              return yield* Effect.fail(
                new PersistenceError({
                  operation: "record a mutation",
                  message: `Idempotency key ${key} was already settled by another mutation`
                })
              )
            }
            mutations.set(key, { fingerprint, receipt: snapshot(receipt) })
          })
        ),
        grants: Effect.fn("ControlRuntime.grants")(() => Effect.sync(() => snapshot(installedGrants)))()
      })
      return service
    })
  )
