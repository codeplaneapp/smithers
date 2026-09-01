/**
 * What a run may spend across its model calls, and what happens when it has
 * spent it.
 *
 * Two ceilings already existed and neither is this one. `Sandbox.Limits` bounds
 * one cell's own execution, and `Agent.Options.maxFrames` bounds one loop's
 * turns. Both are per call. Nothing accumulated what a run had spent across its
 * steps, so `Envelope.budget` — the tokens and milliseconds a control plane
 * APPROVED for a plan — bound nothing at all: a plan could be admitted for a
 * thousand tokens and spend a million.
 *
 * Old smithers spelled this `<Aspects tokenBudget latencySlo>` and enforced it
 * at dispatch, from usage accumulated over the run. This is the same rule at
 * the same place: the enforcement point is the model boundary in
 * {@link module:FlowEngineLike}, which every model call in the composition
 * passes through, so a budget cannot be evaded by a step that assembles its own
 * loop.
 *
 * Three things make it usable rather than merely present:
 *
 * - **The accumulator is per run, keyed by the model step's content key, and
 *   projected from the journal.** Every call writes a {@link usageEvent}
 *   record and the run's first question writes a {@link budgetStartedEvent}
 *   record on the journal's DURABLE channel. A budget entering a run folds
 *   both back before it decides anything. This is what makes a budget survive
 *   a restart: the engine resumes a run from its recorded NODE results and
 *   never re-enters a settled step's body, so memory-only usage would hand a
 *   resumed run a second token allowance and a memory-only clock would re-arm
 *   its latency allowance. Keying by the content key is the other half: a
 *   replayed call and its own recovered record are the same key, so it counts
 *   once. Keying the accumulator itself by execution id is the third: one
 *   layer built at composition level serves every run the engine drives, and a
 *   single shared tally would spend run A's tokens out of run B's allowance.
 * - **The accounting fails closed.** A budget whose record could not be
 *   written, whose ledger could not be read or decoded, or whose ledger is
 *   longer than one recovery reads raises {@link AccountingUnavailable}
 *   instead of answering. Every one of those is a run that would come back
 *   from a restart with an allowance it has already spent, and the difference
 *   between a budget and a decoration is that it refuses rather than guesses.
 *   Only the {@link budgetWarningEvent} record is allowed to be lost: nothing
 *   reads it back, so losing one costs a line in an operator view and no
 *   decision.
 * - **Refusal is a projection, not a post-mortem.** The check happens BEFORE a
 *   call, and it projects the call's cost as the largest one the run has made.
 *   A budget that only noticed after the fact would always be exceeded by the
 *   call that exceeded it.
 * - **The first call is never refused.** With nothing recorded, the only honest
 *   projection is zero, and a budget that refused a run's first call would be a
 *   configuration error reported as a runtime one.
 *
 * `onExceeded` is the composition's choice of what that means: `fail` reports a
 * typed {@link BudgetExceeded}, `warn` journals and proceeds, and
 * `skip-remaining` latches, so every later call in the run is refused without
 * asking a provider anything.
 *
 * @since 0.1.0
 */
import type * as ControlSchema from "@smthrs/control/ControlSchema"
import { FlowRuntime } from "@smthrs/flow"
import type * as RetryPolicy from "@smthrs/flow/RetryPolicy"
import { Journal, JournalEvent } from "@smthrs/journal"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"

/**
 * What a composition wants done when a budget runs out.
 *
 * @category models
 * @since 0.1.0
 */
export const OnExceeded = Schema.Literals(["fail", "warn", "skip-remaining"])

/**
 * What a composition wants done when a budget runs out.
 *
 * @category models
 * @since 0.1.0
 */
export type OnExceeded = typeof OnExceeded.Type

/**
 * The token ceiling for one run, and what exceeding it means.
 *
 * @category models
 * @since 0.1.0
 */
export interface TokenBudget {
  readonly max: number
  readonly onExceeded?: OnExceeded | undefined
}

/**
 * The wall-clock ceiling for one run, and what exceeding it means.
 *
 * It bounds when a call may START, not how long one may take: a call already
 * in flight is the provider's clock, and cutting it off is
 * `Agent.Options.modelCallMs`, which exists and is a different budget.
 * Its zero is the run's first budget question and is durable, so a park or
 * process restart does not grant the run the whole interval again.
 *
 * @category models
 * @since 0.1.0
 */
export interface LatencyBudget {
  readonly maxMillis: number
  readonly onExceeded?: OnExceeded | undefined
}

/**
 * Everything one composition declares about spending.
 *
 * An empty policy is a real policy: it accumulates usage and refuses nothing,
 * which is what a run wants when the numbers are for reporting.
 *
 * @category models
 * @since 0.1.0
 */
export interface Policy {
  readonly tokens?: TokenBudget | undefined
  readonly latency?: LatencyBudget | undefined
}

/**
 * A run that would exceed what it was approved for.
 *
 * `used` is what the run has spent, `max` what it was allowed, and `next` the
 * projected cost of the call that was refused — the largest call the run has
 * made so far, which is the only estimate available before a provider answers.
 *
 * @category errors
 * @since 0.1.0
 */
export class BudgetExceeded extends Schema.TaggedError<BudgetExceeded>()(
  "flows/agent/BudgetExceeded",
  {
    scope: Schema.Literals(["tokens", "latency"]),
    onExceeded: OnExceeded,
    used: Schema.Number,
    max: Schema.Number,
    next: Schema.Number,
    message: Schema.String
  }
) {}

/**
 * The tag {@link Skipped} carries on the wire.
 *
 * @category errors
 * @since 0.1.0
 */
export const skippedTag = "flows/agent/Skipped"

/**
 * A model call refused because the run's budget already latched.
 *
 * `skip-remaining` is not the same verdict as `fail`. `fail` reports the call
 * that would have overspent; `skip-remaining` reports every call after it,
 * including calls in steps that had nothing to do with the overspend. An
 * operator reading a run needs to tell the step that broke the budget from the
 * steps the broken budget skipped, and a supervisor needs to know that no
 * retry can change the answer: the latch is permanent for the run.
 *
 * The failure carries the {@link BudgetExceeded} it latched on, so the numbers
 * are the same ones the first refusal reported.
 *
 * @category errors
 * @since 0.1.0
 */
export class Skipped extends Schema.TaggedError<Skipped>()(
  skippedTag,
  {
    budget: BudgetExceeded,
    message: Schema.String
  }
) {}

/**
 * The budget could not account a run, so it will not say what the run may
 * spend.
 *
 * A budget is a projection of a durable ledger, and every way that ledger can
 * be unavailable is a way a resumed run gets its allowance back: a usage
 * record that was not written, a ledger that could not be read, a ledger
 * longer than one recovery reads. None of them is a smaller number — they are
 * an UNKNOWN number, and answering "proceed" to an unknown is how a run that
 * has spent its whole envelope keeps spending.
 *
 * So the seam fails instead. `phase` says which half broke: `record` is the
 * write after a call the accumulator counted, `recover` is the read a run
 * makes before its first decision. A usage `record` failure is worth retrying:
 * the model step it accounts is sealed, so a re-dispatch replays the recorded
 * answer and writes the record again rather than paying a provider twice. A
 * clock-zero `record` failure happens before the call and retries the write.
 * `cause` preserves the encodable shape of the underlying storage failure so
 * an operator keeps its tag, code, and fields alongside the human summary.
 *
 * @category errors
 * @since 0.1.0
 */
export class AccountingUnavailable extends Schema.TaggedError<AccountingUnavailable>()(
  "flows/agent/BudgetAccountingUnavailable",
  {
    phase: Schema.Literals(["record", "recover"]),
    /** The run whose ledger is unavailable. */
    runId: Schema.String,
    message: Schema.String,
    /** The encodable storage or codec failure that made the ledger unavailable. */
    cause: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * The error tags no retry can turn into a success.
 *
 * A {@link Skipped} step is a verdict, not a transient failure: the latch is
 * set for the rest of the run, so a re-dispatch spends an attempt to be
 * refused identically without asking a provider anything.
 *
 * @category errors
 * @since 0.1.0
 */
export const nonRetryableTags: ReadonlyArray<string> = [skippedTag]

/**
 * Adds {@link nonRetryableTags} to a retry policy.
 *
 * A composition that retries model-backed steps builds its policy through
 * this. `RetryPolicy` classifies by tag, and a policy that does not name
 * {@link Skipped} re-dispatches every skipped step through its whole ladder.
 *
 * @example
 * ```ts
 * import * as Budget from "@smthrs/agent/Budget"
 * import { RetryPolicy } from "@smthrs/flow"
 *
 * const policy = Budget.neverRetrySkipped(RetryPolicy.defaultRetryPolicy)
 * ```
 *
 * @category errors
 * @since 0.1.0
 */
export const neverRetrySkipped = (policy: RetryPolicy.RetryPolicy): RetryPolicy.RetryPolicy => ({
  ...policy,
  nonRetryable: [
    ...(policy.nonRetryable ?? []),
    ...nonRetryableTags.filter((tag) => !(policy.nonRetryable ?? []).includes(tag))
  ]
})

/**
 * What one run has spent so far.
 *
 * @category models
 * @since 0.1.0
 */
export interface Usage {
  readonly tokens: number
  /** Distinct model steps counted, replays included exactly once. */
  readonly calls: number
  /** The largest single call, which is what the next one is projected to cost. */
  readonly largestCall: number
}

/**
 * The answer to "may this call be made".
 *
 * @category models
 * @since 0.1.0
 */
export type Verdict =
  | { readonly _tag: "proceed" }
  | { readonly _tag: "warn"; readonly exceeded: BudgetExceeded }
  | {
    readonly _tag: "refuse"
    /** The ceiling and the numbers that broke it. */
    readonly exceeded: BudgetExceeded
    /**
     * The error the caller raises. It is {@link Skipped} once the run has
     * latched and the {@link BudgetExceeded} itself otherwise, so the step
     * that broke the budget and the steps the broken budget skipped report
     * different failures.
     */
    readonly failure: BudgetExceeded | Skipped
  }

/**
 * The budget a composition enforces.
 *
 * @category services
 * @since 0.1.0
 */
export interface Service {
  /**
   * Decides whether the model call keyed by `stepKey` may be made.
   *
   * The key is what makes a verdict attributable, and attribution is the whole
   * difference between a budget and a trap on a resumed run. A run resumes by
   * re-executing its frames, so it asks this again for every model step it has
   * already paid for — and those steps replay from the journal without asking a
   * provider anything. A projection that adds the next call's estimate to a
   * ledger that already holds this very step refuses a call that costs zero,
   * and a run killed after its last model call comes back dead on arrival.
   *
   * So a step the ledger has already counted proceeds, whatever the ceiling
   * says. `undefined` is the honest answer for a caller with no key, and it
   * gets the projection, because a call the ledger cannot recognize is a call
   * the run has not made.
   */
  readonly check: (stepKey: string | undefined) => Effect.Effect<Verdict, AccountingUnavailable>
  /** Accounts one model step's usage, idempotently in its step key. */
  readonly record: (stepKey: string, usage: ModelEvent.Usage) => Effect.Effect<void, AccountingUnavailable>
  /** What the CURRENT run has spent. Outside a run, what the caller recorded. */
  readonly usage: Effect.Effect<Usage, AccountingUnavailable>
  /**
   * What one named run has spent, whether or not this process is driving it.
   *
   * A budget accounts per run, so a composition-level service holds many
   * tallies and `usage` alone cannot name which. A run this process is driving
   * answers from its live accumulator; any other run answers from the durable
   * usage records it left, which is how a supervisor reads the spend of a run
   * that is parked, finished, or owned by another host.
   * {@link module:Budget.looseRunId} names the tally of calls recorded outside
   * any run.
   */
  readonly usageOf: (runId: string) => Effect.Effect<Usage, AccountingUnavailable>
}

/**
 * The {@link Service} tag.
 *
 * @category services
 * @since 0.1.0
 */
export class Budget extends Context.Service<Budget, Service>()("@smthrs/agent/Budget") {}

/**
 * The journal event one allowed-over-budget call writes.
 *
 * @category records
 * @since 0.1.0
 */
export const budgetWarningEvent = "flows.agent.budget-warning.v1"

/**
 * The journal event one accounted model call writes.
 *
 * Unlike {@link budgetWarningEvent}, which is evidence, this record is READ
 * BACK: a budget entering a resumed run projects its accumulator from these
 * records, because the engine resumes from recorded node results and never
 * re-enters a settled step. That is why it goes on the DURABLE channel and the
 * warning does not. The lossy channel is documented as droppable telemetry —
 * `Dropped` receipts and `drop-oldest` evictions are acceptable there — and a
 * dropped record here would silently hand a resumed run a second allowance.
 *
 * The write is unfenced. A budget is a client of the run it accounts for, not
 * its owner, and the record advances nothing: the accumulator's own step-key
 * dedupe, not the journal fence, is what makes a repeated write harmless. A
 * composition with no journal at all (the reference memory engine) still
 * accounts within one process and simply recovers nothing across a restart.
 *
 * A write that FAILS is a different thing from a composition that keeps no
 * journal, and it is not ignored: it raises {@link AccountingUnavailable}, so
 * the step that made the call fails rather than the run continuing with spend
 * only this process remembers. The read side fails closed the same way when a
 * current-version record does not decode through {@link UsageRecord}: that is
 * a ledger this budget cannot read, not evidence that the call never happened.
 * If forward-compatible skipping is ever wanted, it must be gated on an
 * explicit version-field mismatch rather than on a failed current-version
 * decode.
 *
 * @category records
 * @since 0.1.0
 */
export const usageEvent = "flows.agent.usage.v1"

/**
 * The payload one {@link usageEvent} record carries.
 *
 * This is the wire format of a DURABLE record read back on resume, so it has
 * an owner on both the write and read side. A record that does not decode is a
 * ledger this budget cannot read rather than a call that never happened, and
 * recovery fails closed instead of handing the run that allowance again.
 *
 * The cost field is `spent` and not `tokens` because the journal REDACTS a
 * field whose name reads as a credential: `@smthrs/journal`'s
 * `Redaction.isSensitiveKey` strips one trailing plural and tests the suffix,
 * so `tokens` canonicalizes to `token` and the production `SqlJournal` writes
 * `"[REDACTED]"` in place of the number. Under the old field name every usage
 * record this module wrote came back unreadable, and the read side dropped it
 * silently, so the durable projection was a no-op wherever a real journal was
 * composed. `spent` names the same number and names no credential. Records
 * written under the old name do not decode; they never carried a readable
 * number either, so nothing is lost by refusing them.
 *
 * @category records
 * @since 1.0.0-rc.0
 */
export const UsageRecord = Schema.Struct({
  stepKey: Schema.String,
  spent: Schema.Finite
})

/**
 * The journal event one run's latency clock zero is written to.
 *
 * Like {@link usageEvent}, this record is READ BACK on resume. A run whose
 * zero is not recovered re-arms its whole latency allowance on every park,
 * reclaim, or process restart, so the first recovery writes it durably and
 * later recoveries keep the earliest value they find.
 *
 * @category records
 * @since 1.0.0-rc.0
 */
export const budgetStartedEvent = "flows.agent.budget-started.v1"

/**
 * The payload one {@link budgetStartedEvent} record carries.
 *
 * This is a durable wire format owned by both the first writer and every
 * resumed reader. An undecodable current-version payload leaves the latency
 * ledger unknown, so recovery fails closed instead of choosing a new zero.
 *
 * @category records
 * @since 1.0.0-rc.0
 */
export const BudgetStartedRecord = Schema.Struct({
  startedAt: Schema.Finite
})

/** The journal source every record this module writes is attributed to. */
const recordSource = JournalEvent.SourceId.make("/agent/budget")

/**
 * The tokens one model call cost.
 *
 * Providers report either a total or the parts, and some report both. The total
 * wins when it is there, because a provider that publishes one has already
 * decided what counts.
 *
 * @category accounting
 * @since 0.1.0
 */
export const tokensOf = (usage: ModelEvent.Usage): number =>
  usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) +
      (usage.reasoningTokens ?? 0)

interface State {
  readonly tokens: number
  readonly largestCall: number
  readonly counted: ReadonlySet<string>
  readonly latched: BudgetExceeded | undefined
}

const exceeded = (
  scope: "tokens" | "latency",
  onExceeded: OnExceeded,
  used: number,
  max: number,
  next: number
): BudgetExceeded =>
  new BudgetExceeded({
    scope,
    onExceeded,
    used,
    max,
    next,
    message: scope === "tokens"
      ? `The run has spent ${used} of its ${max} approved tokens and the next call is projected at ${next}`
      : `The run has been running for ${used} ms of its ${max} ms budget`
  })

const skippedFor = (failure: BudgetExceeded): Skipped =>
  new Skipped({
    budget: failure,
    message: `The run stopped making model calls after it exceeded its ${failure.scope} budget`
  })

const verdictFor = (failure: BudgetExceeded): Verdict =>
  failure.onExceeded === "warn"
    ? { _tag: "warn", exceeded: failure }
    : {
      _tag: "refuse",
      exceeded: failure,
      failure: failure.onExceeded === "skip-remaining" ? skippedFor(failure) : failure
    }

/**
 * Writes one record for the current run, when the composition has a journal
 * and is inside a run.
 *
 * Both lookups are optional because a budget is as valid on the reference
 * memory engine as on the durable one, and neither absence changes what the
 * budget decides.
 */
const emit = (
  write: (journal: Journal.Service, input: JournalEvent.Input) => Effect.Effect<unknown, unknown>,
  eventType: string,
  payload: unknown
): Effect.Effect<void, unknown> =>
  Effect.gen(function*() {
    const journal = yield* Effect.serviceOption(Journal.Journal)
    const instance = yield* Effect.serviceOption(FlowRuntime.FlowInstance)
    if (Option.isNone(journal) || Option.isNone(instance)) return
    yield* write(
      journal.value,
      new JournalEvent.Input({
        runId: JournalEvent.RunId.make(instance.value.executionId),
        sourceId: recordSource,
        eventType,
        payload
      })
    )
  })

/**
 * Makes an accounting cause survive its error schema's encoder.
 *
 * This mirrors the action-boundary idiom in `AgentAction`: render a live error
 * instance to plain JSON so its tag, code, and fields survive, and keep a
 * string approximation only for a value JSON cannot represent.
 */
const encodableCause = (cause: unknown): unknown => {
  try {
    return JSON.parse(JSON.stringify(cause))
  } catch {
    /* v8 ignore next -- journal and schema failures in this module carry JSON-compatible fields; this arm keeps a future cyclic or BigInt-bearing failure from replacing the accounting error with a rendering defect */
    return String(cause)
  }
}

/**
 * The failure a broken half of the ledger reports.
 *
 * One sentence per phase rather than a shared one, because the two are
 * different operational facts: a write that failed leaves spend this process
 * knows about and no successor will, and a read that failed leaves a run whose
 * spend nobody knows.
 */
const unavailable = (
  phase: "record" | "recover",
  runId: string,
  detail: string,
  cause?: unknown
): AccountingUnavailable =>
  new AccountingUnavailable({
    phase,
    runId,
    message: phase === "record"
      ? `The budget could not durably record run ${runId}'s ledger, so a resumed run could be given that allowance again: ${detail}`
      : `The budget could not read run ${runId}'s ledger, so it cannot say what allowance is left: ${detail}`,
    ...(cause === undefined ? {} : { cause: encodableCause(cause) })
  })

/**
 * Writes one warning record on the journal's lossy channel, when the
 * composition has a journal and is inside a run.
 *
 * Both lookups are optional because a budget is as valid on the reference
 * memory engine as on the durable one, and neither absence changes what the
 * budget decides. The channel is the lossy one because a warning IS telemetry:
 * nothing reads it back, and a dropped one costs a line in an operator view.
 */
const journalWarning = (payload: Record<string, unknown>): Effect.Effect<void> =>
  emit((journal, input) => journal.emitLossy(input), budgetWarningEvent, payload).pipe(Effect.ignore)

/**
 * Writes one usage record on the journal's DURABLE channel.
 *
 * See {@link usageEvent} for why this record cannot travel on the lossy
 * channel and why the durable write is unfenced.
 */
const journalUsage = (
  runId: string,
  payload: typeof UsageRecord.Encoded
): Effect.Effect<void, AccountingUnavailable> =>
  emit((journal, input) => journal.emitDurableUnfenced(input), usageEvent, payload).pipe(
    Effect.mapError((cause) => unavailable("record", runId, String(cause), cause))
  )

/**
 * Writes one latency clock zero on the journal's DURABLE channel.
 *
 * See {@link budgetStartedEvent} for why a fresh process must recover this
 * value instead of starting the whole latency allowance again.
 */
const journalBudgetStarted = (
  runId: string,
  payload: typeof BudgetStartedRecord.Encoded
): Effect.Effect<void, AccountingUnavailable> =>
  emit((journal, input) => journal.emitDurableUnfenced(input), budgetStartedEvent, payload).pipe(
    Effect.mapError((cause) => unavailable("record", runId, String(cause), cause))
  )

/** How many journal entries one recovery read asks for at a time. */
const recoveryPageSize = 500

/**
 * How many journal entries one recovery reads before it gives up.
 *
 * A recovery pages to the END of the run's journal; this is not a stopping
 * point, it is the point at which the budget declares the ledger unreadable
 * and fails. The difference matters: a bound that stopped early would return a
 * PARTIAL ledger indistinguishable from a complete one, and hand a long run
 * back the allowance the entries past the bound describe. A million entries is
 * far past any run a budget guards, so reaching it is a broken journal rather
 * than a busy one.
 *
 * @category constructors
 * @since 0.1.0
 */
export const defaultRecoveryEntries = 1_000_000

interface RecoveredLedger {
  readonly usage: ReadonlyMap<string, number>
  readonly startedAt: number | undefined
}

/**
 * Reads back the usage and latency zero one run already recorded.
 *
 * Returns calls keyed by step, so the caller folds them through the same
 * accumulator a live call goes through and the dedupe applies to both. The
 * earliest clock zero wins, making a duplicate write harmless without letting
 * a later incarnation move the allowance forward.
 *
 * A composition with no journal recovers nothing, because it never recorded
 * anything and there is nothing to be wrong about. Every OTHER absence fails:
 * a journal that cannot be flushed or read, and a journal longer than
 * `entryLimit`, are runs whose spend or clock zero is unknown rather than zero.
 */
const recoverUsage = (
  runId: string,
  entryLimit: number
): Effect.Effect<RecoveredLedger, AccountingUnavailable> =>
  Effect.gen(function*() {
    const recovered = new Map<string, number>()
    let startedAt = Number.POSITIVE_INFINITY
    const journal = yield* Effect.serviceOption(Journal.Journal)
    if (Option.isNone(journal)) return { usage: recovered, startedAt: undefined }
    const id = JournalEvent.RunId.make(runId)
    const unreadable = (cause: unknown) => unavailable("recover", runId, String(cause), cause)
    const undecodable = (entry: JournalEvent.Entry, record: string) =>
      unavailable(
        "recover",
        runId,
        `its ${record} record at seq ${entry.seq} from ${entry.sourceId} does not decode`
      )
    // Flushed first, and the flush failure is the read's failure: entries the
    // journal is still holding are entries this run spent.
    yield* journal.value.flush.pipe(Effect.mapError(unreadable))
    let after: JournalEvent.Seq | undefined
    let scanned = 0
    for (;;) {
      const read = yield* journal.value.entries(
        after === undefined
          ? { runId: id, limit: recoveryPageSize }
          : { runId: id, after, limit: recoveryPageSize }
      ).pipe(Effect.mapError(unreadable))
      for (const entry of read.entries) {
        if (entry.eventType === usageEvent) {
          const payload = yield* Schema.decodeUnknownEffect(UsageRecord)(entry.payload).pipe(
            Effect.mapError(() => undecodable(entry, "usage"))
          )
          recovered.set(payload.stepKey, payload.spent)
        } else if (entry.eventType === budgetStartedEvent) {
          const payload = yield* Schema.decodeUnknownEffect(BudgetStartedRecord)(entry.payload).pipe(
            Effect.mapError(() => undecodable(entry, "budget-started"))
          )
          startedAt = Math.min(startedAt, payload.startedAt)
        }
      }
      scanned += read.entries.length
      const last = read.entries.at(-1)
      if (!read.hasMore || last === undefined) {
        return {
          usage: recovered,
          startedAt: startedAt === Number.POSITIVE_INFINITY ? undefined : startedAt
        }
      }
      if (scanned >= entryLimit) {
        return yield* Effect.fail(
          unavailable(
            "recover",
            runId,
            `its journal holds more than the ${entryLimit} entries one recovery reads`
          )
        )
      }
      after = last.seq
    }
  })

/**
 * One run's accounting.
 *
 * The budget holds one of these per execution id rather than one per instance.
 * A composition provides `Budget` where it provides its engine — above every
 * run, not inside one — so a single accumulator would spend run A's tokens out
 * of run B's allowance, and `startedAt` captured at layer build would put a
 * latency budget's clock at process start.
 */
interface RunAccount {
  /** The latency zero, replaced once when recovery finds its earlier durable value. */
  startedAt: number
  readonly state: Ref.Ref<State>
  /**
   * Serializes the one-time recovery.
   *
   * A semaphore rather than a flag: a run whose first two model calls are
   * concurrent must not have one of them decide against an accumulator the
   * other is still filling.
   */
  readonly recovery: Semaphore.Semaphore
  recovered: boolean
}

/**
 * The run id {@link Service.usageOf} answers about calls recorded outside any
 * run under.
 *
 * A budget accounts by execution id, and a caller with no run — a unit test, a
 * composition measuring before it executes anything — still has to account
 * somewhere. Its tally is held apart from the run map, so no bound evicts it.
 *
 * @category accounting
 * @since 0.1.0
 */
export const looseRunId = ""

/**
 * How many runs' tallies one budget keeps in memory by default.
 *
 * The accumulator has to be held between one run's model calls, and a run
 * publishes no "I am finished" the budget could listen for: `FlowInstance`'s
 * scope closes at the end of every NODE dispatch, not at the end of the run,
 * so it cannot be the lifetime. The bound is what keeps a control plane that
 * drives runs for weeks from holding one tally per run it ever drove. It is
 * far above any plausible concurrency, so the entry a running run needs is
 * always the most recently used one and is never the one evicted; an evicted
 * run projects both its spend and its original latency zero back from its own
 * durable records the next time it asks a question.
 *
 * @category constructors
 * @since 0.1.0
 */
export const defaultMaxRuns = 256

/**
 * What a composition can tune about one budget instance.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /** How many runs' tallies to keep in memory. Defaults to {@link defaultMaxRuns}. */
  readonly maxRuns?: number | undefined
  /**
   * How many journal entries one recovery reads before it fails closed.
   * Defaults to {@link defaultRecoveryEntries}.
   */
  readonly recoveryEntries?: number | undefined
}

/**
 * Builds a budget over one policy.
 *
 * One instance serves a whole composition: the accumulator is keyed by
 * execution id, so a layer built once above an engine accounts every run it
 * drives separately.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (policy: Policy, options: Options = {}): Effect.Effect<Service> =>
  Effect.gen(function*() {
    const maxRuns = Math.max(1, options.maxRuns ?? defaultMaxRuns)
    const recoveryEntries = Math.max(1, options.recoveryEntries ?? defaultRecoveryEntries)
    const accounts = new Map<string, RunAccount>()
    const registry = yield* Semaphore.make(1)

    const newAccount = Effect.gen(function*() {
      const startedAt = yield* Clock.currentTimeMillis
      const state = yield* Ref.make<State>({
        tokens: 0,
        largestCall: 0,
        counted: new Set<string>(),
        latched: undefined
      })
      const recovery = yield* Semaphore.make(1)
      return { startedAt, state, recovery, recovered: false } satisfies RunAccount
    })

    // The loose account exists from construction so a caller outside a run —
    // a unit test, a composition that accounts before it executes anything —
    // starts its latency clock where the budget was built. It is held apart
    // from the run map so it is never the entry a bound evicts.
    const loose = yield* newAccount

    /**
     * This run's accounting, created on the run's first question.
     *
     * Creation runs under a permit so two concurrent first calls of one run
     * cannot build two accumulators and each decide against half the spend.
     * A `Map` iterates in insertion order, so re-inserting on every touch
     * makes the first key the least recently used one.
     */
    const accountFor = (runId: string): Effect.Effect<RunAccount> =>
      registry.withPermits(1)(Effect.suspend(() => {
        const existing = accounts.get(runId)
        if (existing !== undefined) {
          accounts.delete(runId)
          accounts.set(runId, existing)
          return Effect.succeed(existing)
        }
        return Effect.map(newAccount, (created) => {
          // Evicted before the insert, so the map never exceeds the bound.
          for (const oldest of accounts.keys()) {
            if (accounts.size < maxRuns) break
            accounts.delete(oldest)
          }
          accounts.set(runId, created)
          return created
        })
      }))

    /**
     * Folds one call into a run's accumulator, at most once per step key.
     *
     * Answers whether this call was new, so a caller that also has to write the
     * call down does so exactly when the accumulator took it.
     */
    const account = (run: RunAccount, stepKey: string, spent: number): Effect.Effect<boolean> =>
      Ref.modify(run.state, (current) => {
        if (current.counted.has(stepKey)) return [false, current] as const
        const counted = new Set(current.counted)
        counted.add(stepKey)
        return [
          true,
          {
            ...current,
            tokens: current.tokens + spent,
            largestCall: Math.max(current.largestCall, spent),
            counted
          }
        ] as const
      })

    /** Recovers one run's earlier spend and latency zero once, before its first decision. */
    const ensureRecovered = (run: RunAccount, runId: string): Effect.Effect<void, AccountingUnavailable> =>
      run.recovery.withPermits(1)(
        Effect.suspend(() => {
          if (run.recovered) return Effect.void
          return recoverUsage(runId, recoveryEntries).pipe(
            Effect.flatMap((ledger) =>
              Effect.gen(function*() {
                if (ledger.startedAt === undefined) {
                  const payload = yield* Schema.encodeEffect(BudgetStartedRecord)({
                    startedAt: run.startedAt
                  }).pipe(
                    Effect.mapError((cause) =>
                      unavailable("record", runId, "its latency clock zero does not encode", cause)
                    )
                  )
                  yield* journalBudgetStarted(runId, payload)
                } else {
                  run.startedAt = ledger.startedAt
                }
                yield* Effect.forEach(
                  ledger.usage,
                  ([stepKey, spent]) => account(run, stepKey, spent),
                  { discard: true }
                )
              })
            ),
            Effect.andThen(Effect.sync(() => {
              run.recovered = true
            }))
          )
        })
      )

    /**
     * This run's accumulator, with everything it recorded before folded in,
     * and the id it is accounted under.
     *
     * The id travels with the account because the write side needs it: a
     * record that cannot be written names the run whose ledger is now short.
     */
    const recovered: Effect.Effect<
      { readonly run: RunAccount; readonly runId: string },
      AccountingUnavailable
    > = Effect.gen(function*() {
      const instance = yield* Effect.serviceOption(FlowRuntime.FlowInstance)
      if (Option.isNone(instance)) return { run: loose, runId: looseRunId }
      const runId = instance.value.executionId
      const run = yield* accountFor(runId)
      yield* ensureRecovered(run, runId)
      return { run, runId }
    })

    /** Applies one exceeded budget: latch, journal, or simply report. */
    const settle = (run: RunAccount, failure: BudgetExceeded): Effect.Effect<Verdict> =>
      Effect.gen(function*() {
        if (failure.onExceeded === "skip-remaining") {
          yield* Ref.update(run.state, (current) => ({ ...current, latched: failure }))
        }
        if (failure.onExceeded === "warn") {
          yield* journalWarning({
            scope: failure.scope,
            used: failure.used,
            max: failure.max,
            next: failure.next
          })
        }
        return verdictFor(failure)
      })

    const check = (stepKey: string | undefined): Effect.Effect<Verdict, AccountingUnavailable> =>
      Effect.gen(function*() {
        const { run } = yield* recovered
        const current = yield* Ref.get(run.state)
        // A step the ledger already holds is a step this run already paid for,
        // so the call about to be made is its replay and costs nothing. Every
        // ceiling below projects the NEXT call's cost onto the ledger, and
        // projecting it onto a ledger that already counts this step refuses a
        // call for spend the refusal is itself double-counting. It is checked
        // ahead of the latch for the same reason: `skip-remaining` stops the
        // calls a run has not made, not the ones it is replaying.
        if (stepKey !== undefined && current.counted.has(stepKey)) return { _tag: "proceed" }
        const now = yield* Clock.currentTimeMillis
        if (current.latched !== undefined) return verdictFor(current.latched)
        const latency = policy.latency
        if (latency !== undefined && now - run.startedAt > latency.maxMillis) {
          return yield* settle(
            run,
            exceeded(
              "latency",
              latency.onExceeded ?? "fail",
              now - run.startedAt,
              latency.maxMillis,
              0
            )
          )
        }
        const tokens = policy.tokens
        if (tokens !== undefined && current.tokens + current.largestCall > tokens.max) {
          return yield* settle(
            run,
            exceeded(
              "tokens",
              tokens.onExceeded ?? "fail",
              current.tokens,
              tokens.max,
              current.largestCall
            )
          )
        }
        return { _tag: "proceed" }
      })

    const summarize = (current: State): Usage => ({
      tokens: current.tokens,
      calls: current.counted.size,
      largestCall: current.largestCall
    })

    return Budget.of({
      check,
      record: (stepKey, usage) =>
        Effect.gen(function*() {
          const { run, runId } = yield* recovered
          const spent = tokensOf(usage)
          const counted = yield* account(run, stepKey, spent)
          if (!counted) return
          // Written only when the accumulator took the call, and after it: the
          // record exists to be read back by the NEXT incarnation of this run,
          // and a record whose call the live budget never counted would make
          // the resumed run count it twice.
          const payload = yield* Schema.encodeEffect(UsageRecord)({ stepKey, spent }).pipe(
            Effect.mapError((cause) => unavailable("record", runId, "its usage record does not encode", cause))
          )
          yield* journalUsage(runId, payload)
        }),
      usage: recovered.pipe(
        Effect.flatMap(({ run }) => Ref.get(run.state)),
        Effect.map(summarize)
      ),
      usageOf: (runId) =>
        Effect.suspend(() => {
          const live = runId === looseRunId ? loose : accounts.get(runId)
          // A run this process is driving answers from the accumulator its own
          // calls are folded into. Reading its records instead would report a
          // call the journal has not flushed yet as unspent.
          if (live !== undefined) {
            return ensureRecovered(live, runId).pipe(
              Effect.andThen(Ref.get(live.state)),
              Effect.map(summarize)
            )
          }
          // No accumulator, so no caching either: answering about an arbitrary
          // run must not leave one tally per run the process was ever asked
          // about.
          return Effect.map(recoverUsage(runId, recoveryEntries), (ledger) => {
            let tokens = 0
            let largestCall = 0
            for (const spent of ledger.usage.values()) {
              tokens += spent
              largestCall = Math.max(largestCall, spent)
            }
            return { tokens, calls: ledger.usage.size, largestCall }
          })
        })
    })
  })

/**
 * A budget that accounts nothing and refuses nothing.
 *
 * This is an explicit decision to give up plan-envelope spending enforcement,
 * never a production default.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeUnbounded = (): Service =>
  Budget.of({
    check: () => Effect.succeed<Verdict>({ _tag: "proceed" }),
    record: () => Effect.void,
    usage: Effect.succeed({ tokens: 0, calls: 0, largestCall: 0 }),
    usageOf: () => Effect.succeed({ tokens: 0, calls: 0, largestCall: 0 })
  })

/**
 * Provides one budget for the composition it is built in.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (policy: Policy, options: Options = {}): Layer.Layer<Budget> =>
  Layer.effect(Budget, make(policy, options))

/**
 * Explicitly provides {@link makeUnbounded}.
 *
 * This gives up token, call, and latency ceilings for the composed run.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerUnbounded = (): Layer.Layer<Budget> => Layer.succeed(Budget)(makeUnbounded())

/**
 * Reads the budget a composition explicitly provided.
 *
 * There is deliberately no fallback. Every production composition must bind a
 * policy, normally with {@link layerFromEnvelope}, or explicitly opt into
 * {@link layerUnbounded}.
 *
 * @category accessors
 * @since 0.1.0
 */
export const current: Effect.Effect<Service, never, Budget> = Budget

/**
 * Turns an approved plan envelope into a policy.
 *
 * This is the point of the whole module: `Envelope.budget` is what a control
 * plane approved, and until it becomes a {@link Policy} it is a number in a
 * record that nothing reads. A missing field is not a zero budget — it is no
 * budget at all — so an envelope that approves neither produces an empty policy
 * rather than a run that can spend nothing.
 *
 * @category conversions
 * @since 0.1.0
 */
export const policyFromEnvelope = (
  envelope: ControlSchema.Envelope,
  options: { readonly onExceeded?: OnExceeded | undefined } = {}
): Policy => {
  const onExceeded = options.onExceeded ?? "fail"
  return {
    ...(envelope.budget.tokens === undefined
      ? {}
      : { tokens: { max: envelope.budget.tokens, onExceeded } }),
    ...(envelope.budget.milliseconds === undefined
      ? {}
      : { latency: { maxMillis: envelope.budget.milliseconds, onExceeded } })
  }
}

/**
 * Provides a budget built from an approved plan envelope.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerFromEnvelope = (
  envelope: ControlSchema.Envelope,
  options: { readonly onExceeded?: OnExceeded | undefined } = {}
): Layer.Layer<Budget> => layer(policyFromEnvelope(envelope, options))
