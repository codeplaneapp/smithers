import type { Schedule } from "effect";
import type { CursorStore } from "../core/CursorStoreTypes.ts";
import type { TelegramClientConfig } from "./TelegramClientTypes.ts";

/**
 * Options for `makeTelegramSource`: a getUpdates long-poll EventSource whose
 * offset cursor is persisted through a CursorStore so restarts never
 * re-deliver already-seen updates.
 */
export type MakeTelegramSourceOptions = TelegramClientConfig & {
  /** EventSource id (also the cursor key + dedupe scope). @default "telegram" */
  sourceId?: string;
  /** Durable cursor persistence; use `makeDbCursorStore(adapter)`. */
  cursorStore?: CursorStore;
  /**
   * Long-poll `timeout` parameter passed to getUpdates (seconds; the Bot API
   * holds the request open until updates arrive or the timeout fires).
   * @default 25
   */
  pollTimeoutSeconds?: number;
  /** Delay between poll turns (long-polling makes this mostly idle). @default Schedule.spaced("250 millis") */
  schedule?: Schedule.Schedule<unknown>;
  /** getUpdates `allowed_updates`. @default ["message", "edited_message", "callback_query"] */
  allowedUpdates?: string[];
  /**
   * When set, updates from chats not in this list are dropped (the offset
   * still advances so they are acknowledged, not re-polled).
   */
  allowedChatIds?: Array<number | string>;
};
