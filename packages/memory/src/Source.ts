/**
 * Advisory memory context source for an agent's opening context.
 *
 * Values returned by {@link declaredText} are accepted as
 * `Agent.Options.memory`. The source fetches primers and recall once per
 * `(lineageId, iteration)`, freezes the
 * rendered snapshot for retries, fences it, caps it, and degrades to no text
 * after a two-second timeout or typed failure.
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
