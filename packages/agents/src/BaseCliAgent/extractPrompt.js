import { extractTextFromJsonValue } from "./extractTextFromJsonValue.js";
/** @typedef {import("ai").ModelMessage} ModelMessage */
/**
 * @typedef {{ prompt: string; systemFromMessages?: string; }} PromptParts
 */

/**
 * @param {unknown} content
 * @returns {string}
 */
function contentToText(content) {
    if (typeof content === "string")
        return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => {
            if (typeof part === "string")
                return part;
            if (part && typeof part === "object") {
                const partRecord = /** @type {Record<string, unknown>} */ (part);
                if (typeof partRecord.text === "string")
                    return partRecord.text;
                if (typeof partRecord.content === "string")
                    return partRecord.content;
            }
            return "";
        })
            .join("");
    }
    if (content == null)
        return "";
    return String(content);
}
/**
 * @param {ReadonlyArray<ModelMessage>} messages
 * @returns {PromptParts}
 */
function messagesToPrompt(messages) {
    /** @type {string[]} */
    const systemParts = [];
    /** @type {string[]} */
    const promptParts = [];
    for (const msg of messages) {
        const text = contentToText(msg.content);
        if (!text)
            continue;
        const role = msg.role;
        if (role === "system") {
            systemParts.push(text);
            continue;
        }
        if (role) {
            promptParts.push(`${String(role).toUpperCase()}: ${text}`);
        }
        else {
            promptParts.push(text);
        }
    }
    return {
        prompt: promptParts.join("\n\n"),
        systemFromMessages: systemParts.length
            ? systemParts.join("\n\n")
            : undefined,
    };
}
/**
 * @param {unknown} options
 * @returns {PromptParts}
 */
export function extractPrompt(options) {
    if (!options || typeof options !== "object")
        return { prompt: "" };
    const opts = /** @type {Record<string, unknown>} */ (options);
    if ("prompt" in opts) {
        const promptInput = opts.prompt;
        if (typeof promptInput === "string") {
            return { prompt: promptInput };
        }
        if (Array.isArray(promptInput)) {
            return messagesToPrompt(/** @type {ModelMessage[]} */ (promptInput));
        }
        return { prompt: "" };
    }
    if (Array.isArray(opts.messages)) {
        return messagesToPrompt(/** @type {ModelMessage[]} */ (opts.messages));
    }
    return { prompt: "" };
}
