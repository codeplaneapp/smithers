/**
 * Advisory memory context source for an agent's opening context.
 *
 * Values returned by {@link declaredText} are accepted as
 * `Agent.Options.memory`. The source fetches primers and recall once per
 * `(lineageId, iteration)`, holds the rendered snapshot for retries, fences it,
 * caps it, and degrades to no text after a two-second timeout or typed failure.
 *
 * ## What "once per `(lineageId, iteration)`" actually promises
 *
 * It is a memo held in the process that built the {@link Source}, and nothing
 * more. It is not durable, and this module cannot make it so: a durable
 * boundary needs an engine handle to record through, `read` is handed only
 * `MemoryStore` and `Recall`, and `@smthrs/memory` does not depend on the
 * harness that owns `EngineLike.record`.
 *
 * So the honest statement of the guarantee is:
 *
 * - **Within one process, against one {@link Source} value**, two reads of one
 *   `(lineageId, iteration)` return the same text, and the store is asked once.
 *   That is what makes a step's in-process retries stable.
 * - **Across a crash, a park, or any other process boundary**, they do not. The
 *   next process builds a new memo, refetches live memory, and renders whatever
 *   memory holds NOW — or `""`, if that fetch overruns its two-second budget.
 *   Memory is durable, mutable, shared state, so the second answer is routinely
 *   a different one.
 *
 * The consequence is worth stating plainly, because it is the reason to record
 * this value rather than re-derive it. Memory text goes into an agent's OPENING
 * context, so a resumed run whose snapshot came back different has a different
 * frame-zero prefix, which re-keys every sealed model step under it: the run
 * replays nothing, re-buys every model call it had already paid for, and forks
 * away from the attempt whose irreversible effects it has already performed.
 *
 * **A host that wants that guarantee must record this value itself**, at the
 * point where it has the run's own journal — the same treatment
 * `@smthrs/harness`'s `CellTurn` gives its workspace measurements and its
 * steering drains — and hand the RECORDED text to `Agent.Options.memory`. What
 * this module offers is the fetch, the rendering, and the fence; the durability
 * of the result belongs to whoever owns the run.
 *
 * @see docs/specs/Concepts/Memory.md
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as MemoryStore from "./MemoryStore.ts"
import * as Recall from "./Recall.ts"

/**
 * Source input and retry identity.
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
 * context builds (`packages/agent/src/Agent.ts`, `opening()`), passed in as
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

const digest = (text: string): string => {
  let hash = 2166136261
  for (const byte of encoder.encode(text)) {
    hash ^= byte
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

const truncateBytes = (text: string, maxBytes: number): string => {
  if (encoder.encode(text).byteLength <= maxBytes) return text
  const characters = [...text]
  let low = 0
  let high = characters.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (encoder.encode(characters.slice(0, middle).join("")).byteLength <= maxBytes) low = middle
    else high = middle - 1
  }
  return characters.slice(0, low).join("")
}

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
    const primers = yield* Effect.all(
      primerBanks.map((namespace) =>
        store.listNotes({ namespace: Recall.namespaceForBank(namespace), status: "accepted" })
      ),
      { concurrency: "unbounded" }
    )
    const recalled = yield* recall.recall(input)
    return render(
      primers.flatMap((rows, index) =>
        rows.map((row) => ({
          bank: primerBanks[index] ?? "",
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
 * The memo lives in this value's own closure, so it is scoped to this value and
 * to the process holding it. Two sources memoize separately, and a source built
 * by the next process memoizes nothing this one fetched. See the module
 * docblock for what that does and does not promise a resumed run.
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
  const snapshots = new Map<string, Effect.Effect<string, never, MemoryStore.MemoryStore | Recall.Recall>>()
  return {
    read: (input) => {
      const key = `${input.lineageId}\u0000${input.iteration}`
      const existing = snapshots.get(key)
      if (existing !== undefined) {
        snapshots.delete(key)
        snapshots.set(key, existing)
        return existing
      }
      const current = Effect.runSync(Effect.cached(Effect.suspend(() => fetch(input))))
      snapshots.set(key, current)
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
