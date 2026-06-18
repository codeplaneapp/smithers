import { Effect } from "effect";
/** @typedef {import("./MemoryProcessor.ts").MemoryProcessor} MemoryProcessor */

const RECENT_MESSAGE_COUNT = 2;

/**
 * @param {import("./MemoryMessage.ts").MemoryMessage} message
 * @returns {string}
 */
function renderMessage(message) {
    let content = message.contentJson;
    try {
        const parsed = JSON.parse(message.contentJson);
        content = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
    }
    catch {
        // Preserve raw content when it is not JSON.
    }
    return `${message.role}: ${content}`;
}

/**
 * @param {unknown} result
 * @returns {string}
 */
function extractSummary(result) {
    if (typeof result === "string") {
        return result;
    }
    if (result && typeof result === "object") {
        if ("text" in result && typeof result.text === "string") {
            return result.text;
        }
        if ("output" in result && typeof result.output === "string") {
            return result.output;
        }
    }
    return JSON.stringify(result);
}

/**
 * @param {{ run: (prompt: string) => Promise<any> }} agent
 * @returns {MemoryProcessor}
 */
export function Summarizer(agent) {
    /**
   * @param {MemoryStore} store
   * @returns {Effect.Effect<void, SmithersError>}
   */
    function processEffect(store) {
        return Effect.gen(function* () {
            const threads = yield* store.listThreadsEffect();
            let summarized = 0;
            for (const thread of threads) {
                const messages = yield* store.listMessagesEffect(thread.threadId);
                if (messages.length <= RECENT_MESSAGE_COUNT) {
                    continue;
                }
                const oldMessages = messages.slice(0, -RECENT_MESSAGE_COUNT);
                const recentMessages = messages.slice(-RECENT_MESSAGE_COUNT);
                if (oldMessages.length === 1 && oldMessages[0].role === "system") {
                    continue;
                }
                const prompt = [
                    "Summarize these older conversation messages for future context.",
                    "Keep durable user preferences, decisions, facts, and unresolved tasks.",
                    "",
                    oldMessages.map(renderMessage).join("\n"),
                ].join("\n");
                const result = yield* Effect.tryPromise(() => agent.run(prompt));
                const summary = extractSummary(result);
                yield* store.deleteMessagesEffect(thread.threadId, oldMessages.map((message) => message.id));
                yield* store.saveMessageEffect({
                    id: `summary-${crypto.randomUUID()}`,
                    threadId: thread.threadId,
                    role: "system",
                    contentJson: JSON.stringify({ type: "summary", text: summary }),
                    createdAtMs: oldMessages[0].createdAtMs,
                });
                yield* Effect.logInfo(`Summarizer: compressed ${oldMessages.length} messages before ${recentMessages[0]?.id ?? "end"}`);
                summarized += 1;
            }
            yield* Effect.logInfo(`Summarizer: summarized ${summarized} threads`);
        }).pipe(Effect.annotateLogs({ processor: "Summarizer" }), Effect.withLogSpan("memory:processor:summarizer"));
    }
    return {
        name: "Summarizer",
        process: (store) => Effect.runPromise(processEffect(store)),
        processEffect,
    };
}
