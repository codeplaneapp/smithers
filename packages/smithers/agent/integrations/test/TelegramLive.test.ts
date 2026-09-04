/**
 * Real-backend contract test for the Telegram adapter.
 *
 * Runs against api.telegram.org with the token in `TELEGRAM_BOT_TOKEN`.
 * Read-only: `getMe` and one `getUpdates` long poll with a zero timeout, which
 * confirms nothing and so cannot consume anybody's updates. Skipped, with the
 * credential named, when the token is absent.
 *
 * Telegram is not an rc.0 release-smoke integration; GitHub and Linear are.
 * This suite exists so the Bot API contract is still checked when a token is
 * available.
 */
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { make as makeSource } from "../src/telegram/Source.ts"
import { make } from "../src/telegram/TelegramClient.ts"

const chatId = process.env["TELEGRAM_CHAT_ID"]
const botToken = process.env["TELEGRAM_BOT_TOKEN"] ?? process.env["SMITHERS_TELEGRAM_BOT_TOKEN"]

// Skipped without a credential: set TELEGRAM_BOT_TOKEN (or
// SMITHERS_TELEGRAM_BOT_TOKEN) to a BotFather token to run it.
describe.skipIf(botToken === undefined)("Telegram live contract (TELEGRAM_BOT_TOKEN)", () => {
  // Built lazily: `describe` bodies run even when the suite is skipped, and
  // the constructor refuses an absent token.
  const client = () => make({ botToken: botToken as string })

  it("authenticates and identifies the bot", async () => {
    const me = await Effect.runPromise(client().call("getMe")) as { is_bot?: unknown; username?: unknown }
    expect(me.is_bot).toBe(true)
    expect(typeof me.username).toBe("string")
  }, 30_000)

  it.skipIf(chatId === undefined)("long-polls without confirming any update (TELEGRAM_CHAT_ID)", async () => {
    // `pollTimeoutSeconds: 0` returns immediately, and passing no offset
    // confirms nothing, so a running bot keeps its backlog.
    const batch = await Effect.runPromise(
      makeSource({ client: client(), allowedChatIds: [chatId as string], pollTimeoutSeconds: 0 }).poll(null)
    )
    expect(Array.isArray(batch.events)).toBe(true)
  }, 30_000)

  it("reports an unknown method with the API's own error code, and no token", async () => {
    const failure = await Effect.runPromise(Effect.flip(client().call("thisMethodDoesNotExist")))
    expect(failure.code).toBe("TELEGRAM_API_ERROR")
    if (botToken !== undefined) {
      expect(failure.message).not.toContain(botToken)
      expect(JSON.stringify(failure.details)).not.toContain(botToken)
    }
  }, 30_000)
})
