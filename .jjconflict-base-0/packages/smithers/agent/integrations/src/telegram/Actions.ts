/**
 * The durable Telegram actions.
 *
 * {@link TelegramClient} is the host layer: it chunks a long message, converts
 * markdown to MarkdownV2 and falls back to plain text when Telegram rejects
 * the entities, and retries a 429. An `Action` is what makes a send a step of
 * a durable flow, so a restart replays the recorded message ids instead of
 * sending the text twice.
 *
 * @since 1.0.0
 */
import { Action, type FlowRuntime } from "@smthrs/flow"
import { Effect, type Layer, Schema } from "effect"
import { fromIntegrationError, IntegrationFailure } from "../core/ActionFailure.ts"
import { TelegramClient, toIntegrationError } from "./TelegramClient.ts"

/**
 * What {@link SendMessage} needs.
 *
 * `chatId` is a string because Telegram uses both numeric ids and `@channel`
 * usernames, and a numeric id exceeds the range JSON round-trips exactly.
 *
 * @category schemas
 * @since 1.0.0
 */
export const SendMessagePayload = Schema.Struct({
  chatId: Schema.String,
  text: Schema.String,
  parseMode: Schema.optional(Schema.Literals(["markdown", "MarkdownV2", "HTML", "none"])),
  messageThreadId: Schema.optional(Schema.Number),
  disableNotification: Schema.optional(Schema.Boolean)
})

/**
 * What Telegram accepted.
 *
 * One send can become several messages, so the ids are a list and
 * `usedPlainTextFallback` records whether any chunk lost its formatting.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Sent = Schema.Struct({
  chatId: Schema.String,
  messageIds: Schema.Array(Schema.Number),
  chunkCount: Schema.Number,
  usedPlainTextFallback: Schema.Boolean
})

/**
 * Sends a message to a chat.
 *
 * The tier is `irreversible`: the message is delivered and may already have
 * been read, so the engine must never retry this step on its own. The client
 * underneath retries only a 429, which Telegram refused rather than
 * delivered.
 *
 * A send is not atomic. Text over Telegram's 4096-character limit becomes
 * several `sendMessage` calls inside this one step, and a failure partway
 * through leaves the earlier chunks visible in the chat. The failure names
 * them, in `deliveredMessageIds` on the client error and in the message the
 * action journals, so an operator deciding whether to resend can see what the
 * reader already has.
 *
 * @category actions
 * @since 1.0.0
 */
export const SendMessage = Action.make("integrations/telegram/send-message", {
  payload: SendMessagePayload,
  success: Sent,
  error: IntegrationFailure,
  tier: "irreversible"
})

/**
 * Implements {@link SendMessage} over the client in context.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerSendMessage: Layer.Layer<
  Action.Requirement<"integrations/telegram/send-message">,
  never,
  TelegramClient | FlowRuntime.FlowRuntime
> = SendMessage.toLayer((payload) =>
  Effect.gen(function*() {
    const client = yield* TelegramClient
    const sent = yield* client.sendMessageSmart(payload.chatId, payload.text, {
      ...(payload.parseMode === undefined ? {} : { parseMode: payload.parseMode }),
      ...(payload.messageThreadId === undefined ? {} : { messageThreadId: payload.messageThreadId }),
      ...(payload.disableNotification === undefined ? {} : { disableNotification: payload.disableNotification })
    })
    return {
      chatId: sent.chatId,
      messageIds: sent.messageIds,
      chunkCount: sent.chunkCount,
      usedPlainTextFallback: sent.usedPlainTextFallback
    }
    // `TelegramApiError` is not an `IntegrationError`, so without this every
    // Telegram failure journaled as an unclassified non-retryable
    // `delivery-failed`: an exhausted rate limit was indistinguishable from a
    // chat that does not exist.
  }).pipe(Effect.mapError(toIntegrationError), Effect.mapError(fromIntegrationError))
)

/**
 * Every Telegram action's implementation, in one layer.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer: Layer.Layer<
  Action.Requirement<"integrations/telegram/send-message">,
  never,
  TelegramClient | FlowRuntime.FlowRuntime
> = layerSendMessage
