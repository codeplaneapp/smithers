export const RUN_STARTED_BY_HARNESS_MAX_CODE_POINTS = 64;
export const RUN_STARTED_BY_SESSION_ID_MAX_CODE_POINTS = 256;
export const RUN_STARTED_BY_PROMPT_MAX_CODE_POINTS = 8_192;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {string} value @returns {number} */
function codePointLength(value) {
    return Array.from(value).length;
}

/**
 * Clamp a startedBy prompt to its persisted budget, surrogate-pair safe.
 * Transports call this BEFORE generic frame string bounds so an over-long
 * prompt truncates (the documented behavior) instead of rejecting the frame.
 *
 * @param {string} prompt
 * @returns {string}
 */
export function clampRunStartedByPrompt(prompt) {
    if (codePointLength(prompt) <= RUN_STARTED_BY_PROMPT_MAX_CODE_POINTS) {
        return prompt;
    }
    return `${Array.from(prompt).slice(0, RUN_STARTED_BY_PROMPT_MAX_CODE_POINTS - 1).join("")}…`;
}

/**
 * Normalize optional harness provenance at public ingress and before durable
 * persistence. Unknown object keys are intentionally ignored for direct JS
 * callers; public schemas reject them before this helper runs.
 *
 * @param {unknown} value
 * @returns {import("./RunStartedBy.ts").RunStartedBy | undefined}
 */
export function normalizeRunStartedBy(value) {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!isRecord(value)) {
        throw new TypeError("startedBy must be an object");
    }
    const rawHarness = value.harness;
    const rawSessionId = value.sessionId;
    const rawPrompt = value.prompt;
    if (rawHarness !== undefined && typeof rawHarness !== "string") {
        throw new TypeError("startedBy.harness must be a string");
    }
    if (rawSessionId !== undefined && typeof rawSessionId !== "string") {
        throw new TypeError("startedBy.sessionId must be a string");
    }
    if (rawPrompt !== undefined && typeof rawPrompt !== "string") {
        throw new TypeError("startedBy.prompt must be a string");
    }

    const harness = typeof rawHarness === "string" ? rawHarness.trim() : undefined;
    const sessionId = typeof rawSessionId === "string" ? rawSessionId.trim() : undefined;
    if (harness && codePointLength(harness) > RUN_STARTED_BY_HARNESS_MAX_CODE_POINTS) {
        throw new RangeError(`startedBy.harness must be at most ${RUN_STARTED_BY_HARNESS_MAX_CODE_POINTS} Unicode code points`);
    }
    if (sessionId && codePointLength(sessionId) > RUN_STARTED_BY_SESSION_ID_MAX_CODE_POINTS) {
        throw new RangeError(`startedBy.sessionId must be at most ${RUN_STARTED_BY_SESSION_ID_MAX_CODE_POINTS} Unicode code points`);
    }

    let prompt = rawPrompt === "" ? undefined : rawPrompt;
    if (prompt) {
        prompt = clampRunStartedByPrompt(prompt);
    }
    const result = {
        ...(harness ? { harness } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(value.detected === true && (harness || sessionId) ? { detected: true } : {}),
    };
    return Object.keys(result).length > 0 ? result : undefined;
}
