import { Effect } from "effect";
/** @typedef {import("./MemoryProcessor.ts").MemoryProcessor} MemoryProcessor */

/**
 * @param {number} maxTokens
 * @returns {MemoryProcessor}
 */
export function TokenLimiter(maxTokens) {
    // Rough approximation: 1 token ~= 4 characters
    const charBudget = maxTokens * 4;
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
        }).pipe(Effect.annotateLogs({ processor: "TokenLimiter", maxTokens }), Effect.withLogSpan("memory:processor:token-limiter"));
    }
    return {
        name: "TokenLimiter",
        process: (store) => Effect.runPromise(processEffect(store)),
        processEffect,
    };
}
