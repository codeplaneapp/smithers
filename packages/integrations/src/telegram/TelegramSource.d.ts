import { MakeTelegramSourceOptions as MakeTelegramSourceOptions$1 } from './TelegramSourceTypes.js';
import { EventSource } from '../core/EventSourceTypes.js';
import { ExternalEvent } from '../core/ExternalEventTypes.js';
import 'effect';
import '../core/CursorStoreTypes.js';
import '@smithers-orchestrator/errors/SmithersError';
import './TelegramClientTypes.js';

/**
 * Correlation id for a Telegram chat: `chat:<chatId>`.
 * @param {number | string} chatId
 * @returns {string}
 */
declare function telegramChatCorrelationId(chatId: number | string): string;
/**
 * Correlation id for a forum-topic thread: `chat:<chatId>:thread:<threadId>`.
 * @param {number | string} chatId
 * @param {number | string} threadId
 * @returns {string}
 */
declare function telegramThreadCorrelationId(chatId: number | string, threadId: number | string): string;
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
 * @returns {import("../core/ExternalEventTypes.ts").ExternalEvent[]}
 */
declare function telegramUpdateToEvents(sourceId: string, update: Record<string, any>, receivedAtMs: number): ExternalEvent[];
/**
 * Build a Telegram EventSource: getUpdates long-polling (Bot API semantics —
 * offset = last update_id + 1, server-side `timeout` hold, `allowed_updates`
 * filter) on top of the core polling source. The offset is persisted via the
 * CursorStore only after every event derived from the getUpdates response is
 * delivered, so a restarted process safely re-polls an interrupted batch.
 * Non-allowed chats are dropped but still acknowledged after the remaining
 * batch delivers (offset advances).
 *
 * @param {MakeTelegramSourceOptions} options
 * @returns {import("../core/EventSourceTypes.ts").EventSource}
 */
declare function makeTelegramSource(options: MakeTelegramSourceOptions): EventSource;
declare const TELEGRAM_SERVICE: "telegram";
declare const TELEGRAM_MESSAGE_EVENT: string;
declare const TELEGRAM_EDITED_MESSAGE_EVENT: string;
declare const TELEGRAM_CALLBACK_QUERY_EVENT: string;
declare const TELEGRAM_WEB_APP_DATA_EVENT: string;
type MakeTelegramSourceOptions = MakeTelegramSourceOptions$1;

export { type MakeTelegramSourceOptions, TELEGRAM_CALLBACK_QUERY_EVENT, TELEGRAM_EDITED_MESSAGE_EVENT, TELEGRAM_MESSAGE_EVENT, TELEGRAM_SERVICE, TELEGRAM_WEB_APP_DATA_EVENT, makeTelegramSource, telegramChatCorrelationId, telegramThreadCorrelationId, telegramUpdateToEvents };
