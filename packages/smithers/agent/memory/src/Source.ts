/**
 * Advisory memory context source for an agent's opening context.
 *
 * Values returned by {@link declaredText} are accepted as
 * `Agent.Options.memory`. The source fetches primers and recall once per
 * `(lineageId, iteration)`, freezes the rendered snapshot for retries, fences
 * it, caps it, and degrades to no text after a two-second timeout or typed
 * failure.
 *
 * ## What "once per `(lineageId, iteration)`" actually promises
 *
 * Every source has an in-process memo. With no
 * {@link SnapshotRecorder.SnapshotRecorder} in the Effect context, that is the
 * whole guarantee: two reads through one source return the same text, while a
 * second source refetches live memory. This is the documented default for
 * compositions that use `@smthrs/memory` alone.
 *
 * When a recorder is present, the first fetch for an identity goes through its
 * boundary. A second source, including one built by a resumed process, receives
 * that recorded text instead of refetching memory. The production adapter is
 * `@smthrs/agent/MemorySnapshotRecorder.layer`; it implements this package's
 * port through `@smthrs/harness` `EngineLike.record`. The dependency therefore
 * points from agent to memory and harness, while memory imports neither.
 *
 * The consequence is worth stating plainly, because it is the reason to record
 * this value rather than re-derive it. Memory text goes into an agent's OPENING
 * context, so a resumed run whose snapshot came back different has a different
 * frame-zero prefix. That re-keys every sealed model step under it, causing the
 * run to re-execute model calls it already paid for. Composing the agent adapter
 * closes that replay gap; omitting it deliberately keeps the process-local
 * fallback.
 *
 * @see https://smithers.sh/docs/reference/api/memory
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { resolveBanks } from "./internal/Bank.ts"
import { canonicalJson, digest, truncateBytes } from "./internal/Text.ts"
import * as MemoryStore from "./MemoryStore.ts"
import * as Recall from "./Recall.ts"
import * as SnapshotRecorder from "./SnapshotRecorder.ts"

/**
 * Source input and retry identity.
 *
 * `lineageId` and `iteration` alone select the frozen snapshot. Banks, query,
 * tag groups, primer banks, and both budgets are honored only by the first
 * read for that identity; later differences are warned and ignored.
 * `maxTokens` caps recalled rows in conservative UTF-8 bytes, while
 * `maxBytes` caps the complete fenced snapshot rendered here.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Input extends Recall.Input {
  readonly lineageId: string
  readonly iteration: number
  readonly primerBanks?: ReadonlyArray<string>
  readonly maxBytes?: number
}

/**
 * A memory source value consumed by the host that builds an agent's opening
 * context.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Source {
  readonly read: (input: Input) => Effect.Effect<string, never, MemoryStore.MemoryStore | Recall.Recall>
}

/**
 * Exact declared-text shape consumed by the memory segment an agent's opening
 * context builds (`packages/smithers/agent/src/Agent.ts`, `opening()`), passed in as
 * `Agent.Options.memory`.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface DeclaredText {
  readonly text: string
  readonly digest: string
}

const encoder = new TextEncoder()
const openingFence = "<flows_memory_context>"
const closingFence = "</flows_memory_context>"

const render = (
  primers: ReadonlyArray<{ readonly bank: string; readonly text: string }>,
  recalled: Recall.Output,
  maxBytes: number
): string => {
  const lines = [
    ...primers.map((primer) => `[primer:${primer.bank}] ${primer.text}`),
    ...recalled.map((result) => `[${result.bank}/${result.key}] ${result.text}`)
  ]
  if (lines.length === 0) return ""
  const shell = `${openingFence}\n\n${closingFence}`
  if (encoder.encode(shell).byteLength > maxBytes) return ""
  const available = maxBytes - encoder.encode(shell).byteLength
  const body = truncateBytes(lines.join("\n"), available)
  return `${openingFence}\n${body}\n${closingFence}`
}

const fetch = (input: Input): Effect.Effect<string, never, MemoryStore.MemoryStore | Recall.Recall> =>
  Effect.gen(function*() {
    const store = yield* MemoryStore.MemoryStore
    const recall = yield* Recall.Recall
    const primerBanks = input.primerBanks ?? input.banks
    const resolvedPrimerBanks = yield* resolveBanks(primerBanks)
    const primers = yield* Effect.all(
      resolvedPrimerBanks.map(({ namespace }) => store.listNotes({ namespace, status: "accepted" })),
      { concurrency: 4 }
    )
    const recalled = yield* recall.recall(input)
    return render(
      primers.flatMap((rows, index) =>
        rows.map((row) => ({
          bank: resolvedPrimerBanks[index]?.bank ?? "",
          text: row.text
        }))
      ),
      recalled,
      Math.max(0, Math.floor(input.maxBytes ?? 16 * 1024))
    )
  }).pipe(
    Effect.timeout("2 seconds"),
    Effect.catch((cause) => Effect.logDebug(`memory source degraded: ${String(cause)}`).pipe(Effect.as("")))
  )

/**
 * Constructs a memoizing memory source.
 *
 * The closure memo is always present. When
 * {@link SnapshotRecorder.SnapshotRecorder} is absent, it is the process-local
 * default. When a recorder is composed, the memoized fetch first asks that
 * recorder for the durable value of the same `(lineageId, iteration)`
 * identity.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (options: { readonly capacity?: number | undefined } = {}): Source => {
  const capacity = options.capacity ?? 1_024
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new TypeError("memory source capacity must be a positive safe integer")
  }
  const snapshots = new Map<string, {
    readonly effect: Effect.Effect<string, never, MemoryStore.MemoryStore | Recall.Recall>
    readonly fields: Readonly<Record<string, string>>
  }>()
  const fields = (input: Input): Readonly<Record<string, string>> => ({
    banks: canonicalJson(input.banks),
    query: canonicalJson(input.query),
    tagGroups: canonicalJson(input.tagGroups),
    maxTokens: canonicalJson(input.maxTokens),
    budget: canonicalJson(input.budget),
    primerBanks: canonicalJson(input.primerBanks),
    maxBytes: canonicalJson(input.maxBytes)
  })
  return {
    read: (input) => {
      const key = `${input.lineageId}\u0000${input.iteration}`
      const existing = snapshots.get(key)
      if (existing !== undefined) {
        snapshots.delete(key)
        snapshots.set(key, existing)
        const currentFields = fields(input)
        const changed = Object.keys(existing.fields).filter((field) => existing.fields[field] !== currentFields[field])
        return changed.length === 0
          ? existing.effect
          : Effect.logWarning(
            `memory source ignored changed fields for frozen snapshot ${key}: ${changed.join(", ")}`
          ).pipe(Effect.andThen(existing.effect))
      }
      const identity: SnapshotRecorder.Identity = {
        lineageId: input.lineageId,
        iteration: input.iteration
      }
      const current = Effect.runSync(
        Effect.cached(
          Effect.suspend(() =>
            Effect.flatMap(
              Effect.serviceOption(SnapshotRecorder.SnapshotRecorder),
              Option.match({
                onNone: () => fetch(input),
                onSome: (recorder) => recorder.record(identity, fetch(input))
              })
            )
          )
        )
      )
      snapshots.set(key, { effect: current, fields: fields(input) })
      while (snapshots.size > capacity) snapshots.delete(snapshots.keys().next().value!)
      return current
    }
  }
}

/**
 * The default source value.
 *
 * @category instances
 * @since 0.1.0
 * @slop
 */
export const source = make()

/**
 * Converts a source snapshot into the exact {@link DeclaredText} shape
 * `Agent.Options.memory` accepts.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const declaredText = (
  memorySource: Source,
  input: Input
): Effect.Effect<DeclaredText, never, MemoryStore.MemoryStore | Recall.Recall> =>
  memorySource.read(input).pipe(Effect.map((text) => ({ text, digest: digest(text) })))

/**
 * The UTF-8 byte length of `text`, the unit every memory budget is
 * stated in.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const byteLength = (text: string): number => encoder.encode(text).byteLength

/**
 * Truncates `text` to a byte budget without splitting a code point.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const truncate = truncateBytes
