/**
 * @typedef {import('./agentTrace.ts').AgentFamily} AgentFamily
 * @typedef {import('./agentTrace.ts').CanonicalAgentTraceEventKind} CanonicalAgentTraceEventKind
 *
 * @typedef {"message" | "tool" | "pi" | "none"} PayloadKind
 *
 * @typedef {{
 *   kind: CanonicalAgentTraceEventKind;
 *   payloadKind: PayloadKind;
 *   expect?: CanonicalAgentTraceEventKind;
 * }} MappedStructuredEvent
 *
 * @typedef {{
 *   kind: CanonicalAgentTraceEventKind;
 *   payload: Record<string, unknown> | null;
 *   raw: unknown;
 *   rawType?: string;
 *   observed?: boolean;
 * }} NormalizedTraceEvent
 *
 * @typedef {{
 *   events: NormalizedTraceEvent[];
 *   expectedKinds?: CanonicalAgentTraceEventKind[];
 * }} NormalizedTraceBatch
 */

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function extractTextFromJsonValue(value) {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
        const text = value.map((item) => extractTextFromJsonValue(item) ?? "").join("");
        return text || undefined;
    }
    if (!value || typeof value !== "object") return undefined;
    const record = /** @type {Record<string, unknown>} */ (value);
    if (typeof record.text === "string") return record.text;
    if (typeof record.content === "string") return record.content;
    if (typeof record.output_text === "string") return record.output_text;
    if (Array.isArray(record.content)) {
        const text = record.content.map((part) => extractTextFromJsonValue(part) ?? "").join("");
        if (text) return text;
    }
    if (record.type === "text" && record.part) return extractTextFromJsonValue(record.part);
    for (const field of ["response", "message", "result", "output", "data", "item"]) {
        const text = extractTextFromJsonValue(record[field]);
        if (text) return text;
    }
    return undefined;
}

/** @type {Record<string, ReadonlyArray<ReadonlyArray<string>>>} */
const _usageFieldAliases = {
    inputTokens: [["inputTokens"], ["promptTokens"], ["prompt_tokens"], ["input_tokens"], ["input"], ["models", "gemini", "tokens", "input"]],
    outputTokens: [["outputTokens"], ["completionTokens"], ["completion_tokens"], ["output_tokens"], ["output"], ["models", "gemini", "tokens", "output"]],
    cacheReadTokens: [["cacheReadTokens"], ["cache_read_input_tokens"], ["cached_input_tokens"], ["cache_read_tokens"], ["inputTokenDetails", "cacheReadTokens"]],
    cacheWriteTokens: [["cacheWriteTokens"], ["cache_write_input_tokens"], ["cache_creation_input_tokens"], ["cache_write_tokens"], ["inputTokenDetails", "cacheWriteTokens"]],
    reasoningTokens: [["reasoningTokens"], ["reasoning_tokens"], ["outputTokenDetails", "reasoningTokens"]],
    totalTokens: [["totalTokens"], ["total_tokens"]],
};

/**
 * @param {unknown} value
 * @param {ReadonlyArray<string>} path
 * @returns {unknown}
 */
function _readUsagePath(value, path) {
    let current = value;
    for (const segment of path) {
        if (!current || typeof current !== "object") return undefined;
        current = /** @type {Record<string, unknown>} */ (current)[segment];
    }
    return current;
}

/**
 * @param {unknown} usage
 * @returns {Record<string, number> | null}
 */
function normalizeTokenUsage(usage) {
    if (!usage || typeof usage !== "object") return null;
    /** @type {Record<string, number>} */
    const normalized = {};
    for (const [field, aliases] of Object.entries(_usageFieldAliases)) {
        for (const path of aliases) {
            const value = _readUsagePath(usage, path);
            if (typeof value === "number") {
                normalized[field] = value;
                break;
            }
        }
    }
    return Object.values(normalized).some((v) => Number.isFinite(v) && v > 0) ? normalized : null;
}

/** @type {Record<string, MappedStructuredEvent>} */
const piSimpleEventMap = {
    session: { kind: "session.start", payloadKind: "pi" },
    agent_start: { kind: "session.start", payloadKind: "pi" },
    agent_end: { kind: "session.end", payloadKind: "pi" },
    turn_start: { kind: "turn.start", payloadKind: "pi", expect: "turn.end" },
    message_start: { kind: "message.start", payloadKind: "pi" },
    tool_execution_start: { kind: "tool.execution.start", payloadKind: "tool", expect: "tool.execution.end" },
    tool_execution_update: { kind: "tool.execution.update", payloadKind: "tool", expect: "tool.execution.end" },
    tool_execution_end: { kind: "tool.execution.end", payloadKind: "tool" },
    auto_compaction_start: { kind: "compaction.start", payloadKind: "pi" },
    auto_compaction_end: { kind: "compaction.end", payloadKind: "pi" },
    auto_retry_start: { kind: "retry.start", payloadKind: "pi" },
    auto_retry_end: { kind: "retry.end", payloadKind: "pi" },
};

/** @type {Record<string, MappedStructuredEvent>} */
const genericStructuredEventMap = {
    message_start: { kind: "message.start", payloadKind: "message" },
    assistant_message_start: { kind: "message.start", payloadKind: "message" },
    "response.started": { kind: "message.start", payloadKind: "message" },
    tool_call_start: { kind: "tool.execution.start", payloadKind: "tool", expect: "tool.execution.end" },
    tool_execution_start: { kind: "tool.execution.start", payloadKind: "tool", expect: "tool.execution.end" },
    "tool_call.started": { kind: "tool.execution.start", payloadKind: "tool", expect: "tool.execution.end" },
    tool_call_delta: { kind: "tool.execution.update", payloadKind: "tool", expect: "tool.execution.end" },
    tool_call_update: { kind: "tool.execution.update", payloadKind: "tool", expect: "tool.execution.end" },
    tool_execution_update: { kind: "tool.execution.update", payloadKind: "tool", expect: "tool.execution.end" },
    "tool_call.delta": { kind: "tool.execution.update", payloadKind: "tool", expect: "tool.execution.end" },
    tool_call_end: { kind: "tool.execution.end", payloadKind: "tool" },
    tool_execution_end: { kind: "tool.execution.end", payloadKind: "tool" },
    "tool_call.completed": { kind: "tool.execution.end", payloadKind: "tool" },
    tool_result: { kind: "tool.result", payloadKind: "tool" },
    "tool_result.completed": { kind: "tool.result", payloadKind: "tool" },
};

/**
 * @param {any} parsed
 * @returns {string | undefined}
 */
function extractGenericDeltaText(parsed) {
    const candidates = [
        parsed?.delta?.text,
        parsed?.delta,
        parsed?.text,
        parsed?.content_block?.text,
        parsed?.contentBlock?.text,
        parsed?.message?.text,
        parsed?.message?.content,
        parsed?.output_text,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate) return candidate;
    }
    return undefined;
}

/**
 * @param {any} parsed
 * @returns {string | undefined}
 */
function extractGenericMessageText(parsed) {
    return extractTextFromJsonValue(parsed?.message ?? parsed?.response ?? parsed?.item ?? parsed);
}

/**
 * @param {any} parsed
 * @returns {Record<string, unknown>}
 */
function extractGenericMessagePayload(parsed) {
    /** @type {Record<string, unknown>} */
    const payload = {};
    const role = parsed?.message?.role ?? parsed?.role ?? parsed?.response?.role;
    if (typeof role === "string") payload.role = role;
    const text = extractGenericMessageText(parsed);
    if (text) payload.text = text;
    if (parsed?.id) payload.id = parsed.id;
    return payload;
}

/**
 * @param {any} parsed
 * @returns {Record<string, unknown>}
 */
function extractGenericToolPayload(parsed) {
    const tool = parsed?.tool ?? parsed?.toolCall ?? parsed?.tool_call ?? parsed?.toolExecution ?? parsed;
    return {
        toolCallId: tool?.id ?? tool?.toolCallId ?? parsed?.id,
        toolName: tool?.name ?? tool?.toolName ?? parsed?.toolName,
        argsPreview: tool?.args ?? tool?.arguments ?? parsed?.args,
        resultPreview: tool?.result ?? parsed?.result,
        isError: Boolean(tool?.isError ?? parsed?.isError ?? parsed?.error),
    };
}

/**
 * @param {any} parsed
 * @returns {Record<string, unknown>}
 */
function extractPiPayload(parsed) {
    /** @type {Record<string, unknown>} */
    const payload = {};
    if (parsed?.message?.role) payload.role = parsed.message.role;
    const text = extractGenericMessageText(parsed?.message);
    if (text) payload.text = text;
    if (parsed?.id) payload.id = parsed.id;
    return payload;
}

/**
 * @param {any} parsed
 * @param {PayloadKind} payloadKind
 * @returns {Record<string, unknown> | null}
 */
function extractMappedPayload(parsed, payloadKind) {
    if (payloadKind === "message") return extractGenericMessagePayload(parsed);
    if (payloadKind === "tool") return extractGenericToolPayload(parsed);
    if (payloadKind === "pi") return extractPiPayload(parsed);
    return {};
}

/**
 * @param {CanonicalAgentTraceEventKind} kind
 * @param {Record<string, unknown> | null} payload
 * @param {unknown} raw
 * @param {string | undefined} rawType
 * @param {boolean} [observed]
 * @returns {NormalizedTraceEvent}
 */
function buildNormalizedEvent(kind, payload, raw, rawType, observed = false) {
    return { kind, payload, raw, rawType, observed };
}

/**
 * @param {any} parsed
 * @param {string} rawType
 * @param {MappedStructuredEvent} mapped
 * @returns {NormalizedTraceBatch}
 */
function normalizeMappedEvent(parsed, rawType, mapped) {
    return {
        events: [buildNormalizedEvent(mapped.kind, extractMappedPayload(parsed, mapped.payloadKind), parsed, rawType)],
        expectedKinds: mapped.expect ? [mapped.expect] : undefined,
    };
}

/**
 * @param {any} parsed
 * @param {string} rawType
 * @returns {NormalizedTraceBatch | null}
 */
function normalizeClaudeStructuredEvent(parsed, rawType) {
    if (rawType === "assistant") {
        const text = extractGenericMessageText(parsed?.message ?? parsed);
        const events = text
            ? [buildNormalizedEvent("message.update", extractGenericMessagePayload(parsed?.message ?? parsed), parsed, rawType)]
            : [buildNormalizedEvent("stdout", { eventType: rawType }, parsed, rawType, true)];
        const usage = normalizeTokenUsage(parsed?.message?.usage);
        if (usage) events.push(buildNormalizedEvent("usage", usage, parsed, rawType));
        return { events };
    }
    if (rawType === "result") {
        /** @type {NormalizedTraceEvent[]} */
        const events = [];
        const usage = normalizeTokenUsage(parsed?.usage);
        if (usage) events.push(buildNormalizedEvent("usage", usage, parsed, rawType));
        const text = extractGenericMessageText(parsed);
        if (text) {
            events.push(buildNormalizedEvent("assistant.message.final", { text }, parsed, rawType));
        }
        return events.length > 0 ? { events } : null;
    }
    return null;
}

/**
 * @param {any} parsed
 * @param {string} rawType
 * @returns {NormalizedTraceBatch | null}
 */
function normalizeGeminiStructuredEvent(parsed, rawType) {
    if (rawType === "message") {
        const text = extractGenericMessageText(parsed);
        if (parsed?.role === "assistant" && typeof text === "string" && text) {
            return {
                events: [
                    buildNormalizedEvent(parsed?.delta ? "assistant.text.delta" : "assistant.message.final", { text }, parsed, rawType),
                ],
            };
        }
    }
    if (rawType === "result" && parsed?.stats) {
        const usage = normalizeTokenUsage(parsed.stats);
        return usage ? { events: [buildNormalizedEvent("usage", usage, parsed, rawType)] } : null;
    }
    return null;
}

/**
 * @param {any} parsed
 * @param {string} rawType
 * @returns {NormalizedTraceBatch | null}
 */
function normalizeCodexStructuredEvent(parsed, rawType) {
    if (rawType === "thread.started") {
        return { events: [buildNormalizedEvent("stdout", { eventType: rawType }, parsed, rawType, true)] };
    }
    if (rawType === "turn.started") {
        return { events: [buildNormalizedEvent("turn.start", {}, parsed, rawType)], expectedKinds: ["turn.end"] };
    }
    if (rawType === "item.completed" && parsed?.item?.type === "agent_message") {
        const text = extractGenericMessageText(parsed.item);
        if (typeof text === "string" && text) {
            return { events: [buildNormalizedEvent("assistant.message.final", { text }, parsed, rawType)] };
        }
    }
    if (rawType === "turn.completed") {
        /** @type {NormalizedTraceEvent[]} */
        const events = [];
        const usage = normalizeTokenUsage(parsed?.usage);
        if (usage) events.push(buildNormalizedEvent("usage", usage, parsed, rawType));
        events.push(buildNormalizedEvent("turn.end", {}, parsed, rawType));
        const text = extractGenericMessageText(parsed);
        if (text) {
            events.push(buildNormalizedEvent("assistant.message.final", { text }, parsed, rawType));
        }
        return { events };
    }
    return null;
}

/**
 * @param {any} parsed
 * @param {string} rawType
 * @returns {NormalizedTraceBatch | null}
 */
function normalizePiStructuredEvent(parsed, rawType) {
    const simple = piSimpleEventMap[rawType];
    if (simple) return normalizeMappedEvent(parsed, rawType, simple);
    if (rawType === "turn_end") {
        /** @type {NormalizedTraceEvent[]} */
        const events = [buildNormalizedEvent("turn.end", extractPiPayload(parsed), parsed, rawType)];
        const text = extractGenericMessageText(parsed?.message);
        if (text) {
            events.push(buildNormalizedEvent("assistant.message.final", { text }, parsed?.message, rawType));
        }
        const usage = normalizeTokenUsage(parsed?.message?.usage);
        if (usage) events.push(buildNormalizedEvent("usage", usage, parsed.message.usage, "usage"));
        return { events };
    }
    if (rawType === "message_end") {
        /** @type {NormalizedTraceEvent[]} */
        const events = [buildNormalizedEvent("message.end", extractPiPayload(parsed), parsed, rawType)];
        const text = extractGenericMessageText(parsed?.message);
        if (parsed?.message?.role === "assistant" && text) {
            events.push(buildNormalizedEvent("assistant.message.final", { text }, parsed?.message, rawType));
        }
        return { events };
    }
    if (rawType === "message_update") {
        const evt = parsed?.assistantMessageEvent;
        if (evt?.type === "text_delta" && typeof evt.delta === "string") {
            return { events: [buildNormalizedEvent("assistant.text.delta", { text: evt.delta }, parsed, evt.type)] };
        }
        if ((evt?.type === "thinking_delta" || evt?.type === "reasoning_delta") && typeof evt.delta === "string") {
            return { events: [buildNormalizedEvent("assistant.thinking.delta", { text: evt.delta }, parsed, evt.type)] };
        }
        return { events: [buildNormalizedEvent("message.update", extractPiPayload(parsed), parsed, rawType)] };
    }
    return { events: [buildNormalizedEvent("stdout", { eventType: rawType }, parsed, rawType, true)] };
}

/**
 * @param {any} parsed
 * @param {string} rawType
 * @returns {NormalizedTraceBatch | null}
 */
function normalizeSharedStructuredEvent(parsed, rawType) {
    const mapped = genericStructuredEventMap[rawType];
    if (mapped) return normalizeMappedEvent(parsed, rawType, mapped);
    if ([
        "message_delta",
        "assistant_message.delta",
        "assistant_message_delta",
        "response.output_text.delta",
        "content_block_delta",
    ].includes(rawType)) {
        const text = extractGenericDeltaText(parsed);
        if (typeof text === "string" && text) {
            return { events: [buildNormalizedEvent("assistant.text.delta", { text }, parsed, rawType)] };
        }
    }
    if ([
        "thinking_delta",
        "reasoning_delta",
        "response.reasoning.delta",
    ].includes(rawType)) {
        const text = extractGenericDeltaText(parsed);
        if (typeof text === "string" && text) {
            return { events: [buildNormalizedEvent("assistant.thinking.delta", { text }, parsed, rawType)] };
        }
    }
    if ([
        "message_end",
        "assistant_message_end",
        "response.completed",
        "message_stop",
    ].includes(rawType)) {
        /** @type {NormalizedTraceEvent[]} */
        const events = [buildNormalizedEvent("message.end", extractGenericMessagePayload(parsed), parsed, rawType)];
        const text = extractGenericMessageText(parsed);
        if (text) {
            events.push(buildNormalizedEvent("assistant.message.final", { text }, parsed, rawType));
        }
        const usage = normalizeTokenUsage(parsed?.usage);
        if (usage) events.push(buildNormalizedEvent("usage", usage, parsed, rawType));
        return { events };
    }
    return null;
}

/**
 * @param {AgentFamily} agentFamily
 * @param {any} parsed
 * @param {string} rawType
 * @returns {NormalizedTraceBatch}
 */
export function normalizeStructuredEventForFamily(agentFamily, parsed, rawType) {
    if (agentFamily === "pi") {
        return normalizePiStructuredEvent(parsed, rawType) ?? {
            events: [buildNormalizedEvent("stdout", { eventType: rawType }, parsed, rawType, true)],
        };
    }
    if (agentFamily === "claude-code") {
        const normalized = normalizeClaudeStructuredEvent(parsed, rawType);
        if (normalized) return normalized;
    }
    if (agentFamily === "gemini" || agentFamily === "antigravity") {
        const normalized = normalizeGeminiStructuredEvent(parsed, rawType);
        if (normalized) return normalized;
    }
    if (agentFamily === "codex") {
        const normalized = normalizeCodexStructuredEvent(parsed, rawType);
        if (normalized) return normalized;
    }
    const shared = normalizeSharedStructuredEvent(parsed, rawType);
    if (shared) return shared;
    return { events: [buildNormalizedEvent("stdout", { eventType: rawType }, parsed, rawType, true)] };
}

/**
 * @param {AgentFamily} agentFamily
 * @param {any} parsed
 * @returns {{ sessionId?: string; threadId?: string }}
 */
export function extractProviderSessionCorrelation(agentFamily, parsed) {
    if (agentFamily === "codex") {
        const threadId = typeof parsed?.thread_id === "string" ? parsed.thread_id : undefined;
        return { threadId };
    }
    const sessionId = typeof parsed?.session_id === "string"
        ? parsed.session_id
        : typeof parsed?.sessionId === "string"
            ? parsed.sessionId
            : agentFamily === "pi" && typeof parsed?.id === "string"
                ? parsed.id
                : undefined;
    return { sessionId };
}
