import { Effect } from "effect";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
/** @typedef {import("./MemoryProcessor.ts").MemoryProcessor} MemoryProcessor */
/** @typedef {import("./store/MemoryStore.ts").MemoryStore} MemoryStore */
/** @typedef {import("@smithers-orchestrator/errors/SmithersError").SmithersError} SmithersError */

// Rough approximation: 1 token ~= 4 characters of message JSON.
const CHARS_PER_TOKEN = 4;

/**
 * @param {number} maxTokens
 * @returns {MemoryProcessor}
 */
export function TokenLimiter(maxTokens) {
  if (!Number.isFinite(maxTokens) || maxTokens < 0) {
    throw new SmithersError("INVALID_INPUT", "TokenLimiter maxTokens must be a non-negative finite number.", {
      maxTokens,
    });
  }
  const charBudget = maxTokens * CHARS_PER_TOKEN;
  /**
   * @param {MemoryStore} store
   * @returns {Effect.Effect<void, SmithersError>}
   */
  function processEffect(store) {
    return Effect.gen(function* () {
      const threads = yield* store.listThreadsEffect();
      let deleted = 0;
      for (const thread of threads) {
        const messages = yield* store.listMessagesEffect(thread.threadId);
        let charCount = messages.reduce((total, message) => total + message.contentJson.length, 0);
        const deleteIds = [];
        for (const message of messages) {
          if (charCount <= charBudget) {
            break;
          }
          deleteIds.push(message.id);
          charCount -= message.contentJson.length;
        }
        deleted += yield* store.deleteMessagesEffect(thread.threadId, deleteIds);
      }
      yield* Effect.logInfo(`TokenLimiter: deleted ${deleted} messages to enforce ${maxTokens} token budget`);
    }).pipe(
      Effect.annotateLogs({ processor: "TokenLimiter", maxTokens }),
      Effect.withLogSpan("memory:processor:token-limiter"),
    );
  }
  return {
    name: "TokenLimiter",
    process: (store) => Effect.runPromise(processEffect(store)),
    processEffect,
  };
}
