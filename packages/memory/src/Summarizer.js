import { Effect } from "effect";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
/** @typedef {import("./MemoryProcessor.ts").MemoryProcessor} MemoryProcessor */
/** @typedef {import("./store/MemoryStore.ts").MemoryStore} MemoryStore */
/** @typedef {import("@smithers-orchestrator/errors/SmithersError").SmithersError} SmithersError */

// Newest N messages stay verbatim; everything older is folded into the summary.
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
  } catch {
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
        const result = yield* Effect.tryPromise({
          try: () => agent.run(prompt),
          catch: (cause) => toSmithersError(cause, "memory summarizer agent.run"),
        });
        const summary = extractSummary(result);
        // Save the summary BEFORE deleting the old messages so there is no
        // data-loss window: if the summary write fails the originals are
        // still present (recoverable), and if the delete fails afterwards
        // the originals plus the summary coexist (harmless — the next run
        // re-summarizes and deletes them). The state where the old
        // messages are gone and no summary exists is never reachable.
        yield* store.saveMessageEffect({
          id: `summary-${crypto.randomUUID()}`,
          threadId: thread.threadId,
          role: "system",
          contentJson: JSON.stringify({ type: "summary", text: summary }),
          createdAtMs: oldMessages[0].createdAtMs,
        });
        yield* store.deleteMessagesEffect(
          thread.threadId,
          oldMessages.map((message) => message.id),
        );
        yield* Effect.logInfo(
          `Summarizer: compressed ${oldMessages.length} messages before ${recentMessages[0]?.id ?? "end"}`,
        );
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
