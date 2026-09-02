/**
 * Finite memory maintenance Effects intended for explicit schedules.
 *
 * @since 0.1.0
 */
import * as Digest from "@smthrs/core/Digest"
import * as Effect from "effect/Effect"
import { MemoryError } from "./MemoryError.ts"
import { MemoryStore, type Message } from "./MemoryStore.ts"

/**
 * Result of one TTL garbage-collection pass.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface TtlGcResult {
  readonly deletedFacts: number
}

/**
 * Deletes facts whose TTL has elapsed.
 *
 * @category effects
 * @since 0.1.0
 * @slop
 */
export const ttlGc: Effect.Effect<TtlGcResult, MemoryError, MemoryStore> = Effect.service(MemoryStore).pipe(
  Effect.flatMap((store) => store.deleteExpiredFacts),
  Effect.map((deletedFacts) => ({ deletedFacts }))
)

/**
 * Configuration for one history token-limiter pass.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface TokenLimiterOptions {
  readonly maxTokens: number
  readonly charsPerToken?: number | undefined
}

/**
 * Result of one history token-limiter pass.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface TokenLimiterResult {
  readonly deletedMessages: number
}

/**
 * Deletes the oldest messages in every thread until the configured
 * approximate token budget is met.
 *
 * @category effects
 * @since 0.1.0
 * @slop
 */
export const limitHistory = (
  options: TokenLimiterOptions
): Effect.Effect<TokenLimiterResult, MemoryError, MemoryStore> =>
  Effect.gen(function*() {
    if (!Number.isFinite(options.maxTokens) || options.maxTokens < 0) {
      return yield* Effect.fail(
        new MemoryError({
          code: "invalid_argument",
          message: "maxTokens must be a non-negative finite number",
          path: ["maxTokens"]
        })
      )
    }
    const charsPerToken = options.charsPerToken ?? 4
    if (!Number.isFinite(charsPerToken) || charsPerToken <= 0) {
      return yield* Effect.fail(
        new MemoryError({
          code: "invalid_argument",
          message: "charsPerToken must be a positive finite number",
          path: ["charsPerToken"]
        })
      )
    }
    const store = yield* MemoryStore
    const threadIds = yield* store.listThreadIds
    const deleted = yield* Effect.forEach(
      threadIds,
      (threadId) =>
        Effect.gen(function*() {
          const messages = yield* store.listMessages({ threadId })
          let chars = messages.reduce((total, message) => total + message.text.length, 0)
          const budget = options.maxTokens * charsPerToken
          const ids: Array<string> = []
          for (const message of messages) {
            if (chars <= budget) {
              break
            }
            ids.push(message.id)
            chars -= message.text.length
          }
          return yield* store.deleteMessages({ threadId, ids })
        }),
      { concurrency: 1 }
    )
    return { deletedMessages: deleted.reduce((total, count) => total + count, 0) }
  })

/**
 * Input supplied to an injected summarizer.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface SummarizerInput {
  readonly threadId: string
  readonly messages: ReadonlyArray<Message>
  readonly rendered: string
}

/**
 * Injected summarizer Effect. Implementations may invoke a model flow, a test
 * fake, or another caller-owned summarization route.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Summarizer<E = never, R = never> {
  readonly summarize: (input: SummarizerInput) => Effect.Effect<string, E, R>
}

/**
 * Configuration for one compaction pass.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface CompactionOptions<E = never, R = never> {
  readonly summarizer: Summarizer<E, R>
  readonly threadId?: string | undefined
  readonly keepRecent?: number | undefined
  readonly makeSummaryId?: ((threadId: string, messages: ReadonlyArray<Message>) => string) | undefined
}

/**
 * Result of one compaction pass.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface CompactionResult {
  readonly compactedThreads: number
  readonly deletedMessages: number
}

const render = (messages: ReadonlyArray<Message>): string =>
  messages.map((message) => `${message.role}: ${message.text}`).join("\n")

/**
 * Summarizes old history and atomically replaces it with a summary.
 *
 * The summarizer runs before the write transaction. After it succeeds,
 * `MemoryStore.compactMessages` inserts the summary before deleting source
 * messages in one `Database.write`. Failure or fiber interruption before that
 * commit leaves the source messages intact.
 *
 * @category effects
 * @since 0.1.0
 * @slop
 */
export const compact = <E, R>(
  options: CompactionOptions<E, R>
): Effect.Effect<CompactionResult, E | MemoryError, R | MemoryStore> =>
  Effect.gen(function*() {
    const keepRecent = options.keepRecent ?? 2
    if (!Number.isSafeInteger(keepRecent) || keepRecent < 0) {
      return yield* Effect.fail(
        new MemoryError({
          code: "invalid_argument",
          message: "keepRecent must be a non-negative safe integer",
          path: ["keepRecent"]
        })
      )
    }
    const store = yield* MemoryStore
    const threadIds = options.threadId === undefined ? yield* store.listThreadIds : [options.threadId]
    let compactedThreads = 0
    let deletedMessages = 0
    for (const threadId of threadIds) {
      const messages = yield* store.listMessages({ threadId })
      if (messages.length <= keepRecent) {
        continue
      }
      const oldMessages = keepRecent === 0 ? messages : messages.slice(0, -keepRecent)
      if (oldMessages.length === 1 && oldMessages[0]!.role === "system") {
        continue
      }
      const summaryText = yield* options.summarizer.summarize({
        threadId,
        messages: oldMessages,
        rendered: render(oldMessages)
      })
      const summaryId = options.makeSummaryId?.(threadId, oldMessages) ??
        `summary-${Digest.digest(Digest.canonical({ threadId, messageIds: oldMessages.map((message) => message.id) }))}`
      const deleted = yield* store.compactMessages({
        threadId,
        summary: {
          threadId,
          id: summaryId,
          role: "system",
          text: summaryText,
          at: oldMessages[0]!.at
        },
        deleteIds: oldMessages.map((message) => message.id)
      })
      compactedThreads += 1
      deletedMessages += deleted
    }
    return { compactedThreads, deletedMessages }
  })
