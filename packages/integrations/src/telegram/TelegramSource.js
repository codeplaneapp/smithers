// @smithers-type-exports-begin
/** @typedef {import("./TelegramSource.ts").MakeTelegramSourceOptions} MakeTelegramSourceOptions */
// @smithers-type-exports-end

import { Effect, Schedule } from "effect";
import { logInfo } from "@smithers-orchestrator/observability/logging";
import { makePollingSource } from "../core/EventSource.js";
import { IntegrationError } from "../core/IntegrationError.js";
import { integrationEventName } from "../core/signalNames.js";
import { makeTelegramClient } from "./TelegramClient.js";

export const TELEGRAM_SERVICE = "telegram";
export const TELEGRAM_MESSAGE_EVENT = integrationEventName(TELEGRAM_SERVICE, "message");
export const TELEGRAM_EDITED_MESSAGE_EVENT = integrationEventName(TELEGRAM_SERVICE, "edited_message");
export const TELEGRAM_CALLBACK_QUERY_EVENT = integrationEventName(TELEGRAM_SERVICE, "callback_query");

const DEFAULT_ALLOWED_UPDATES = ["message", "edited_message", "callback_query"];
const DEFAULT_POLL_TIMEOUT_SECONDS = 25;

/**
 * Correlation id for a Telegram chat: `chat:<chatId>`.
 * @param {number | string} chatId
 * @returns {string}
 */
export function telegramChatCorrelationId(chatId) {
    return `chat:${chatId}`;
}

/**
 * Correlation id for a forum-topic thread: `chat:<chatId>:thread:<threadId>`.
 * @param {number | string} chatId
 * @param {number | string} threadId
 * @returns {string}
 */
export function telegramThreadCorrelationId(chatId, threadId) {
    return `chat:${chatId}:thread:${threadId}`;
}

/**
 * Map one getUpdates Update object to ExternalEvents.
 *
 * Dedupe soundness: `deliverEvents` dedupes on (sourceId, dedupeKey) BEFORE
 * matching runs, and one delivered event carries exactly ONE correlationId.
 * Topical messages therefore emit TWO events — chat-level correlation
 * (`chat:<id>`, dedupeKey `update:<update_id>`) and thread-level correlation
 * (`chat:<id>:thread:<tid>`, dedupeKey `update:<update_id>:thread`) — each
 * deduped independently, so a redelivered update can never double-signal
 * either wait while both chat- and thread-scoped listeners still wake.
 *
 * @param {string} sourceId
 * @param {Record<string, any>} update
 * @param {number} receivedAtMs
 * @returns {import("../core/ExternalEvent.ts").ExternalEvent[]}
 */
export function telegramUpdateToEvents(sourceId, update, receivedAtMs) {
    const updateId = update.update_id;
    /** @type {import("../core/ExternalEvent.ts").ExternalEvent[]} */
    const events = [];
    /**
   * @param {string} eventName
   * @param {Record<string, any>} message
   */
    const pushMessageEvents = (eventName, message) => {
        const chatId = message?.chat?.id;
        if (chatId == null) {
            return;
        }
        events.push({
            source: sourceId,
            eventName,
            correlationId: telegramChatCorrelationId(chatId),
            payload: message,
            dedupeKey: `update:${updateId}`,
            receivedAtMs,
        });
        if (message.is_topic_message && message.message_thread_id != null) {
            events.push({
                source: sourceId,
                eventName,
                correlationId: telegramThreadCorrelationId(chatId, message.message_thread_id),
                payload: message,
                dedupeKey: `update:${updateId}:thread`,
                receivedAtMs,
            });
        }
    };
    if (update.message) {
        pushMessageEvents(TELEGRAM_MESSAGE_EVENT, update.message);
    }
    else if (update.edited_message) {
        pushMessageEvents(TELEGRAM_EDITED_MESSAGE_EVENT, update.edited_message);
    }
    else if (update.callback_query) {
        const callbackQuery = update.callback_query;
        const chatId = callbackQuery?.message?.chat?.id;
        events.push({
            source: sourceId,
            eventName: TELEGRAM_CALLBACK_QUERY_EVENT,
            correlationId: chatId != null ? telegramChatCorrelationId(chatId) : null,
            payload: callbackQuery,
            dedupeKey: `update:${updateId}`,
            receivedAtMs,
        });
        const threadId = callbackQuery?.message?.message_thread_id;
        if (chatId != null && callbackQuery?.message?.is_topic_message && threadId != null) {
            events.push({
                source: sourceId,
                eventName: TELEGRAM_CALLBACK_QUERY_EVENT,
                correlationId: telegramThreadCorrelationId(chatId, threadId),
                payload: callbackQuery,
                dedupeKey: `update:${updateId}:thread`,
                receivedAtMs,
            });
        }
    }
    return events;
}

/**
 * Extract the chat id an update belongs to (for allowed-chat gating).
 * @param {Record<string, any>} update
 * @returns {number | string | null}
 */
function updateChatId(update) {
    return (update.message?.chat?.id ??
        update.edited_message?.chat?.id ??
        update.callback_query?.message?.chat?.id ??
        null);
}

/**
 * Build a Telegram EventSource: getUpdates long-polling (Bot API semantics —
 * offset = last update_id + 1, server-side `timeout` hold, `allowed_updates`
 * filter) on top of the core polling source, with the offset persisted via
 * the CursorStore so a restarted process resumes without re-delivering.
 * Non-allowed chats are dropped but still acknowledged (offset advances).
 *
 * @param {MakeTelegramSourceOptions} options
 * @returns {import("../core/EventSource.ts").EventSource}
 */
export function makeTelegramSource(options) {
    const { sourceId = TELEGRAM_SERVICE, cursorStore, pollTimeoutSeconds = DEFAULT_POLL_TIMEOUT_SECONDS, schedule = Schedule.spaced("250 millis"), allowedUpdates = DEFAULT_ALLOWED_UPDATES, allowedChatIds, ...clientConfig } = options;
    const client = makeTelegramClient(clientConfig);
    const allowedChats = allowedChatIds
        ? new Set(allowedChatIds.map((id) => String(id)))
        : null;
    return makePollingSource({
        id: sourceId,
        cursorStore,
        schedule,
        poll: (cursor) => Effect.gen(function* () {
            /** @type {Record<string, unknown>} */
            const params = {
                timeout: pollTimeoutSeconds,
                allowed_updates: allowedUpdates,
            };
            const offset = cursor != null ? Number(cursor) : Number.NaN;
            if (Number.isFinite(offset)) {
                params.offset = offset;
            }
            const result = yield* client.call("getUpdates", params).pipe(Effect.mapError((cause) => new IntegrationError("poll-failed", `Telegram getUpdates failed for source "${sourceId}".`, { sourceId }, { cause })));
            const updates = Array.isArray(result) ? result : [];
            const receivedAtMs = Date.now();
            /** @type {import("../core/ExternalEvent.ts").ExternalEvent[]} */
            const events = [];
            let maxUpdateId = null;
            for (const update of updates) {
                const updateId = update?.update_id;
                if (typeof updateId !== "number") {
                    continue;
                }
                maxUpdateId = maxUpdateId == null ? updateId : Math.max(maxUpdateId, updateId);
                const chatId = updateChatId(update);
                if (allowedChats && chatId != null && !allowedChats.has(String(chatId))) {
                    logInfo("telegram update dropped (chat not allowed)", { sourceId, updateId, chatId: String(chatId) }, "integrations:telegram");
                    continue;
                }
                events.push(...telegramUpdateToEvents(sourceId, update, receivedAtMs));
            }
            return {
                events,
                // Bot API long-poll semantics: confirm processed updates by
                // polling with offset = highest update_id + 1.
                ...(maxUpdateId != null ? { cursor: String(maxUpdateId + 1) } : {}),
            };
        }),
    });
}
