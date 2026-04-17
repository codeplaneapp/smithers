import { extractTextFromJsonValue } from "./extractTextFromJsonValue.js";
/**
 * @typedef {{ push: (chunk: string) => void; flush: (finalText?: string) => void; }} AgentStdoutTextEmitter
 */
/**
 * @typedef {{ outputFormat?: string; onText?: (text: string) => void; }} AgentStdoutTextEmitterOptions
 */

/**
 * @param {unknown} messages
 * @returns {unknown | undefined}
 */
function extractLastAssistantMessage(messages) {
    if (!Array.isArray(messages))
        return undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message && typeof message === "object"
            && /** @type {Record<string, unknown>} */ (message).role === "assistant") {
            return message;
        }
    }
    return undefined;
}
/**
 * @param {unknown} parsed
 * @param {{ sawDeltaSinceBoundary: boolean }} state
 * @returns {string[]}
 */
function extractCliStreamTextChunks(parsed, state) {
    /** @type {string[]} */
    const chunks = [];
    /**
   * @param {string | undefined} text
   */
    const emitDelta = (text) => {
        if (!text)
            return;
        state.sawDeltaSinceBoundary = true;
        chunks.push(text);
    };
    /**
   * @param {string | undefined} text
   */
    const emitFinal = (text) => {
        if (text && !state.sawDeltaSinceBoundary) {
            chunks.push(text);
        }
        state.sawDeltaSinceBoundary = false;
    };
    if (!parsed || typeof parsed !== "object") {
        return chunks;
    }
    const record = /** @type {Record<string, unknown>} */ (parsed);
    const type = typeof record.type === "string" ? record.type : "";
    const upperType = type.toUpperCase();
    const delta = /** @type {Record<string, unknown> | undefined} */ (
        record.delta && typeof record.delta === "object" ? record.delta : undefined
    );
    if (type === "content_block_delta" && delta?.type === "text_delta") {
        emitDelta(typeof delta.text === "string" ? delta.text : undefined);
    }
    if (type === "message_update") {
        const assistantEvent = /** @type {Record<string, unknown> | undefined} */ (
            record.assistantMessageEvent && typeof record.assistantMessageEvent === "object"
                ? record.assistantMessageEvent
                : undefined
        );
        if (assistantEvent?.type === "text_delta" &&
            typeof assistantEvent.delta === "string") {
            emitDelta(assistantEvent.delta);
        }
    }
    if (/delta/i.test(type) && type !== "content_block_delta" && type !== "message_update") {
        if (typeof record.delta === "string") {
            emitDelta(record.delta);
        }
        else if (typeof delta?.text === "string") {
            emitDelta(delta.text);
        }
        else if (typeof record.text === "string") {
            emitDelta(record.text);
        }
    }
    if (type === "message" && record.role === "assistant") {
        emitFinal(extractTextFromJsonValue(record.content ?? record.message ?? record));
    }
    if (upperType === "MESSAGE" && record.role === "assistant") {
        if (record.delta === true && typeof record.content === "string") {
            emitDelta(record.content);
        }
        else {
            emitFinal(extractTextFromJsonValue(record.content ?? record.message ?? record));
        }
    }
    if (record.role === "assistant" && typeof record.content === "string") {
        emitFinal(record.content);
    }
    const message = /** @type {Record<string, unknown> | undefined} */ (
        record.message && typeof record.message === "object" ? record.message : undefined
    );
    if (type === "assistant" && message?.role === "assistant") {
        emitFinal(extractTextFromJsonValue(message));
    }
    if (type === "result") {
        emitFinal(extractTextFromJsonValue(record.result ?? record.response ?? record.output ?? record));
    }
    if (type === "turn_end" && message?.role === "assistant") {
        emitFinal(extractTextFromJsonValue(message));
    }
    if (type === "message_end" && message?.role === "assistant") {
        emitFinal(extractTextFromJsonValue(message));
    }
    if (type === "agent_end") {
        emitFinal(extractTextFromJsonValue(extractLastAssistantMessage(record.messages)));
    }
    if (type === "message_stop" ||
        type === "turn.completed" ||
        type === "turn_end" ||
        type === "message_end" ||
        type === "agent_end" ||
        type === "result") {
        state.sawDeltaSinceBoundary = false;
    }
    return chunks;
}
/**
 * @param {AgentStdoutTextEmitterOptions} options
 * @returns {AgentStdoutTextEmitter}
 */
export function createAgentStdoutTextEmitter(options) {
    const { outputFormat, onText } = options;
    let buffer = "";
    let emittedAnyText = false;
    const state = { sawDeltaSinceBoundary: false };
    /**
   * @param {string | undefined} text
   */
    const emitText = (text) => {
        if (!onText || !text)
            return;
        emittedAnyText = true;
        onText(text);
    };
    /**
   * @param {string} line
   */
    const processLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed)
            return;
        let parsed;
        try {
            parsed = JSON.parse(trimmed);
        }
        catch {
            return;
        }
        for (const chunk of extractCliStreamTextChunks(parsed, state)) {
            emitText(chunk);
        }
    };
    return {
        /**
     * @param {string} chunk
     */
        push(chunk) {
            if (!onText || !chunk)
                return;
            if (!outputFormat || outputFormat === "text") {
                emitText(chunk);
                return;
            }
            buffer += chunk;
            let newlineIndex = buffer.indexOf("\n");
            while (newlineIndex >= 0) {
                const line = buffer.slice(0, newlineIndex);
                processLine(line);
                buffer = buffer.slice(newlineIndex + 1);
                newlineIndex = buffer.indexOf("\n");
            }
        },
        /**
     * @param {string} [finalText]
     */
        flush(finalText) {
            if (!onText)
                return;
            if (outputFormat && outputFormat !== "text" && buffer.trim()) {
                processLine(buffer);
            }
            buffer = "";
            if (!emittedAnyText && finalText) {
                emitText(finalText);
            }
        },
    };
}
