/**
 * Idempotent admission of collaborative commands onto a branch document.
 *
 * Three different things look identical from the server's side — an optimistic
 * client re-sending after a timeout, a reconnecting client flushing its
 * outbox, and two people pressing the same button at once — and all three must
 * produce exactly one durable command. The client-minted `commandId` is the
 * idempotency key for all three.
 *
 * The exactly-once constraint is durable, not process-local: every append
 * carries the producer identity `(branch run, commandSourceId(commandId),
 * commandSourceSeq)`, which the journal enforces inside its own write
 * transaction. Two independently constructed servers that race the same
 * command therefore collide in the journal — one appends, the other receives
 * a duplicate receipt or an idempotency conflict and resolves the canonical
 * sequence by replaying the branch (audit finding F-14). The in-memory
 * ledger, permit, and replay cursor are a fast path only: they answer known
 * duplicates without a journal write and keep a restarted server from
 * re-executing history, but correctness never depends on them.
 *
 * @since 0.1.0
 */
import { Journal } from "@smthrs/journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import {
  type BranchId,
  branchRunId,
  CommandEvent,
  type CommandId,
  CommandIdentity,
  CommandReceipt,
  commandSourceId,
  commandSourceSeq,
  CommandSubmission,
  ShareCapability
} from "./BranchProtocol.ts"
import * as BranchShare from "./BranchShare.ts"
import { causeCode } from "./internal/causeText.ts"
import { positiveInt } from "./internal/options.ts"
import { SyncError } from "./SyncError.ts"
import * as SyncProtocol from "./SyncProtocol.ts"

/**
 * A capability-bearing command submission.
 *
 * @category models
 * @since 0.1.0
 */
export const SubmitRequest = Schema.Struct({ capability: ShareCapability, submission: CommandSubmission })
/**
 * The value form of {@link SubmitRequest}.
 *
 * @category models
 * @since 0.1.0
 */
export type SubmitRequest = typeof SubmitRequest.Type

/**
 * Branch command admission operations.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly submit: (request: SubmitRequest) => Effect.Effect<CommandReceipt, SyncError>
}

/**
 * The branch command ledger.
 *
 * @category services
 * @since 0.1.0
 */
export class BranchCommands extends Context.Service<BranchCommands, Service>()("@smthrs/sync/BranchCommands") {}

/**
 * Constructs a command ledger from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (implementation: Service): Service => BranchCommands.of(implementation)

/**
 * Constructs a command ledger that admits nothing.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  make({
    submit: () => Effect.fail(new SyncError({ code: "closed", message: "Branch commands are unavailable" })),
    ...overrides
  })

/**
 * Provides a command ledger that admits nothing.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<BranchCommands> = Layer.succeed(BranchCommands, makeNoop())

/**
 * Projects a journal write failure onto the sync boundary.
 *
 * The public `message` is a constant and the `cause` names the failure's type
 * only. A branch writer may hold nothing but a share link, and the journal's
 * own message is the SQLite driver's, which carries SQL text, table and column
 * names, and constraint identifiers.
 */
const journalFailure = (cause: unknown): SyncError =>
  new SyncError({
    code: "unknown",
    message: "Branch journal write failed",
    cause: causeCode(cause)
  })

/** How many entries one rehydration page reads. */
const pageSize = 256

/**
 * Receipts one branch keeps in memory before the oldest are evicted.
 *
 * The ledger is a fast path: it answers a known duplicate without a journal
 * write, and losing an entry costs a round trip, never correctness, because
 * the journal's own producer identity is the durable exactly-once constraint
 * and returns a `Duplicate` receipt for a command already admitted. Retaining
 * one receipt per command forever meant a process serving a hundred branches
 * of a hundred thousand commands held ten million of them, so the fast path
 * is bounded and the durable path is what makes it safe to bound.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultLedgerCapacity = 4096

/**
 * Admission policy.
 *
 * The default caps one encoded command submission at 1 MiB and one branch's
 * in-memory receipt ledger at {@link defaultLedgerCapacity} commands.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /**
   * Largest encoded command submission admitted, in bytes. Defaults to
   * {@link SyncProtocol.defaultMaxFrameBytes}.
   */
  readonly maxCommandBytes?: number | undefined
  /**
   * Receipts one branch keeps in memory before the oldest are evicted.
   * Defaults to {@link defaultLedgerCapacity}.
   */
  readonly ledgerCapacity?: number | undefined
}

/** The ledger over an already-validated policy. */
const makeWith = (
  resolved: { readonly maxCommandBytes: number; readonly ledgerCapacity: number }
): Effect.Effect<Service, never, Journal.Journal | BranchShare.BranchShare> =>
  Effect.gen(
    function*() {
      const journal = yield* Journal.Journal
      const share = yield* BranchShare.BranchShare
      // One permit PER BRANCH. A single process-wide permit serialized
      // admission across every branch the process served, so one branch's
      // first-touch history replay blocked every other branch's writes.
      const permits = new Map<BranchId, Semaphore.Semaphore>()
      const permitFor = (branchId: BranchId): Semaphore.Semaphore => {
        const known = permits.get(branchId)
        if (known !== undefined) return known
        const fresh = Semaphore.makeUnsafe(1)
        permits.set(branchId, fresh)
        return fresh
      }
      // Nested, never a concatenated key: `${branchId} ${commandId}` collides
      // for valid branded strings, so `("a", "b c")` and `("a b", "c")` shared
      // a slot and one branch's receipt answered another branch's command.
      const ledger = new Map<BranchId, Map<CommandId, CommandReceipt>>()
      const cursors = new Map<BranchId, JournalEvent.Seq>()
      const hydrated = new Set<BranchId>()
      const { ledgerCapacity, maxCommandBytes } = resolved

      const receiptOf = (branchId: BranchId, commandId: CommandId): CommandReceipt | undefined =>
        ledger.get(branchId)?.get(commandId)

      /**
       * Records one receipt, evicting the branch's oldest once the branch is
       * at capacity. `Map` iterates in insertion order, so the first key is
       * the least recently recorded one; re-recording a known command
       * refreshes it in place rather than growing the branch.
       */
      const record = (receipt: CommandReceipt): void => {
        const branch = ledger.get(receipt.branchId) ?? new Map<CommandId, CommandReceipt>()
        branch.delete(receipt.commandId)
        branch.set(receipt.commandId, receipt)
        for (const oldest of branch.keys()) {
          if (branch.size <= ledgerCapacity) break
          branch.delete(oldest)
        }
        ledger.set(receipt.branchId, branch)
      }

      const duplicateOf = (known: CommandReceipt): CommandReceipt =>
        new CommandReceipt({
          branchId: known.branchId,
          commandId: known.commandId,
          status: "duplicate",
          seq: known.seq
        })

      /**
       * Pages a branch's journal forward from `from`, handing each entry to
       * `visit` along with the command identity it carries, if any.
       */
      const walk = (
        branchId: BranchId,
        from: JournalEvent.Seq | undefined,
        visit: (entry: JournalEvent.Entry, commandId: CommandId | undefined) => void
      ): Effect.Effect<void, SyncError> =>
        Effect.gen(function*() {
          const runId = branchRunId(branchId)
          let after = from
          let hasMore = true
          while (hasMore) {
            const page = yield* journal.entries({
              runId,
              ...(after === undefined ? {} : { after }),
              limit: pageSize
            }).pipe(Effect.mapError(journalFailure))
            for (const entry of page.entries) {
              after = entry.seq
              const submission = entry.eventType === CommandEvent
                ? Schema.decodeUnknownOption(CommandIdentity)(entry.payload)
                : Option.none()
              visit(entry, Option.isSome(submission) ? submission.value.commandId : undefined)
            }
            // An empty page ends the walk whatever the page claims, the same
            // guard `SyncServer.tail` carries: `after` cannot move, so the
            // next read is byte-identical and the loop would never terminate
            // — while holding this branch's admission permit.
            if (page.entries.length === 0) return
            hasMore = page.hasMore
          }
        })

      /**
       * Replays the branch journal forward from the last replayed sequence into
       * the ledger. Used once on first touch, so a process that restarts
       * mid-collaboration still recognises every command it already admitted,
       * and again after an admission conflict, to read the command another
       * writer admitted after this process last looked.
       */
      const replay = (branchId: BranchId): Effect.Effect<void, SyncError> =>
        walk(branchId, cursors.get(branchId), (entry, commandId) => {
          cursors.set(branchId, entry.seq)
          if (commandId === undefined) return
          record(new CommandReceipt({ branchId, commandId, status: "admitted", seq: entry.seq }))
        })

      /**
       * The sequence one command was admitted at, read from the branch's whole
       * durable history rather than from the ledger.
       *
       * The ledger is BOUNDED, so the receipt for a command admitted far
       * enough back has been evicted, and a forward replay from the ledger's
       * own cursor can never bring it back — the entry is below that cursor.
       * The durable log still holds it, and this is the read that says so.
       * Neither the cursor nor the ledger moves: this answers one question
       * about history and leaves the fast path exactly as it found it.
       */
      const admittedSeq = (
        branchId: BranchId,
        commandId: CommandId
      ): Effect.Effect<JournalEvent.Seq | undefined, SyncError> =>
        Effect.gen(function*() {
          let found: JournalEvent.Seq | undefined
          yield* walk(branchId, undefined, (entry, admitted) => {
            if (admitted === commandId) found = entry.seq
          })
          return found
        })

      const hydrate = (branchId: BranchId): Effect.Effect<void, SyncError> =>
        Effect.gen(function*() {
          if (hydrated.has(branchId)) return
          yield* replay(branchId)
          hydrated.add(branchId)
        })

      /**
       * The losing side of a cross-server admission race: the journal refused
       * this append because another writer already holds the command's producer
       * identity with different content — same `commandId`, different
       * participant or arguments. The original admission is durable, so
       * replaying the branch forward must surface it; a replay that does not is
       * a journal whose conflict report and entries disagree, and that failure
       * is reported honestly instead of being masked as a duplicate.
       *
       * Two reads, because the ledger is bounded and the answer must not be.
       * The forward replay picks up an admission another writer landed after
       * this process last looked. A command this process admitted itself and
       * has since evicted is BELOW that cursor, so only a read of the whole
       * history finds it — and without one, bounding the ledger turned an
       * ordinary duplicate into a report that the journal contradicts itself.
       */
      const lostRace = (
        submission: CommandSubmission,
        cause: Journal.JournalError
      ): Effect.Effect<CommandReceipt, SyncError> =>
        Effect.gen(function*() {
          yield* replay(submission.branchId)
          const known = receiptOf(submission.branchId, submission.commandId)
          if (known !== undefined) return duplicateOf(known)
          // A branch still under the ledger's capacity has never evicted
          // anything, and `replay` has just read this branch to its tail, so a
          // command missing from the ledger is missing from the journal too.
          // Reading the whole history to confirm that would let one small
          // request cost one full log scan.
          const mayHaveEvicted = (ledger.get(submission.branchId)?.size ?? 0) >= ledgerCapacity
          const seq = mayHaveEvicted
            ? yield* admittedSeq(submission.branchId, submission.commandId)
            : undefined
          if (seq === undefined) return yield* Effect.fail(journalFailure(cause))
          return new CommandReceipt({
            branchId: submission.branchId,
            commandId: submission.commandId,
            status: "duplicate",
            seq
          })
        })

      const admit = (request: SubmitRequest): Effect.Effect<CommandReceipt, SyncError> =>
        Effect.gen(function*() {
          const submission = request.submission
          yield* hydrate(submission.branchId)
          const known = receiptOf(submission.branchId, submission.commandId)
          if (known !== undefined) return duplicateOf(known)
          // Unfenced: the sync command journal is a multi-writer admission
          // log — participants own no branch run, and command admissions are
          // first-writer-wins on the command id.
          const receipt = yield* journal.emitDurableUnfenced(
            new JournalEvent.Input({
              runId: branchRunId(submission.branchId),
              sourceId: commandSourceId(submission.commandId),
              sourceSeq: commandSourceSeq,
              eventType: CommandEvent,
              payload: {
                branchId: submission.branchId,
                commandId: submission.commandId,
                participantId: submission.participantId,
                name: submission.name,
                args: submission.args,
                target: submission.target
              },
              meta: null
            })
          ).pipe(
            // A `Duplicate` receipt is another writer landing the identical
            // submission first: the journal deduplicated durably and returned
            // the canonical sequence the original append committed at.
            Effect.map((accepted) =>
              new CommandReceipt({
                branchId: submission.branchId,
                commandId: submission.commandId,
                status: accepted._tag === "Duplicate" ? "duplicate" : "admitted",
                seq: accepted.seq
              })
            ),
            Effect.catch((cause) =>
              cause.code === "idempotency_conflict"
                ? lostRace(submission, cause)
                : Effect.fail(journalFailure(cause))
            )
          )
          record(
            new CommandReceipt({
              branchId: submission.branchId,
              commandId: submission.commandId,
              status: "admitted",
              seq: receipt.seq
            })
          )
          return receipt
        })

      const submit = Effect.fn("BranchCommands.submit")(function*(request: SubmitRequest) {
        yield* Effect.annotateCurrentSpan({
          branchId: request.submission.branchId,
          commandId: request.submission.commandId,
          participantId: request.submission.participantId
        })
        yield* share.verify(request.capability, { branchId: request.submission.branchId, access: "write" })
        const bytes = SyncProtocol.encodedByteLength(request.submission)
        if (bytes > maxCommandBytes) {
          // Refused BEFORE the append: an oversized command must never reach
          // the journal, and therefore never reaches any follower.
          return yield* Effect.fail(
            new SyncError({
              code: "frame_too_large",
              message: `Encoded command submission of ${bytes} bytes exceeds the ${maxCommandBytes}-byte ceiling`
            })
          )
        }
        // The permit is taken AFTER authorization so an unauthorized caller
        // cannot serialize (and therefore stall) legitimate collaborators,
        // and it is this BRANCH's permit so a slow branch stalls only itself.
        return yield* permitFor(request.submission.branchId).withPermits(1)(admit(request))
      })

      return make({ submit })
    }
  )

const defaults = {
  maxCommandBytes: SyncProtocol.defaultMaxFrameBytes,
  ledgerCapacity: defaultLedgerCapacity
}

/**
 * Constructs the journal-backed branch command ledger under an explicit
 * policy.
 *
 * A submission whose encoded form exceeds the command ceiling is refused with
 * `frame_too_large` before anything is appended, so one oversized `args`
 * cannot enter the branch journal and poison every follower that replays it.
 *
 * Every option is validated as a positive safe integer at construction: the
 * TypeScript type says `number`, and `NaN` silently disabled the ceiling it
 * was compared against.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeLiveWith = (
  options: Options = {}
): Effect.Effect<Service, SyncError, Journal.Journal | BranchShare.BranchShare> =>
  Effect.flatMap(
    Effect.all({
      maxCommandBytes: positiveInt(
        "BranchCommands.Options.maxCommandBytes",
        options.maxCommandBytes,
        defaults.maxCommandBytes
      ),
      ledgerCapacity: positiveInt(
        "BranchCommands.Options.ledgerCapacity",
        options.ledgerCapacity,
        defaults.ledgerCapacity
      )
    }),
    makeWith
  )

/**
 * Constructs the journal-backed branch command ledger with default policy.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeLive: Effect.Effect<Service, never, Journal.Journal | BranchShare.BranchShare> = makeWith(defaults)

/**
 * Provides the journal-backed branch command ledger.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<BranchCommands, never, Journal.Journal | BranchShare.BranchShare> = Layer.effect(
  BranchCommands,
  makeLive
)

/**
 * Provides the journal-backed branch command ledger under an explicit policy.
 * Fails with `invalid_request` when an option is not a positive safe integer.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerWith = (
  options: Options
): Layer.Layer<BranchCommands, SyncError, Journal.Journal | BranchShare.BranchShare> =>
  Layer.effect(BranchCommands, makeLiveWith(options))

/**
 * Builds a submission, filling in the fields a plain command never sets.
 *
 * @category constructors
 * @since 0.1.0
 */
export const submission = (fields: {
  readonly branchId: BranchId
  readonly commandId: CommandId
  readonly participantId: CommandSubmission["participantId"]
  readonly name: string
  readonly args?: string
  readonly target?: string
}): CommandSubmission =>
  new CommandSubmission({
    branchId: fields.branchId,
    commandId: fields.commandId,
    participantId: fields.participantId,
    name: fields.name,
    args: fields.args ?? "",
    target: fields.target ?? ""
  })
