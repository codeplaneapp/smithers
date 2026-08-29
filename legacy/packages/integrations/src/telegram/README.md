# telegram/

The Telegram Bot API surface:

- `TelegramClient.js` — fetch-based client service: 429 retry with capped
  `retry_after`, `sendMessageSmart` (chunking + MarkdownV2 conversion with a
  plain-text fallback), document upload, bot token always redacted from
  errors (`redactBotToken`).
- `TelegramSource.js` — `getUpdates` long-poll EventSource built on
  `makePollingSource`, offset persisted through the CursorStore, chat/thread
  correlation fan-out.
- `config.js` — explicit config → `configureTelegram` registry →
  `SMITHERS_TELEGRAM_BOT_TOKEN` env fallback.
- `chunk.js` / `markdown.js` — 4096-char boundary-aware chunking; standard
  markdown → MarkdownV2 conversion via NUL sentinels.
- `approval.js` — inline-keyboard approval building blocks: callback_data
  codec (64-byte cap), keyboard builders, press → decision mapping.
- `initData.js` — Mini App initData verification, HMAC and Ed25519 paths,
  Web Crypto only (runs in Node/Bun and Cloudflare Workers).
- `schemas.js` — zod payload schemas for updates and outbound results.
- `components/` — listener/outbound workflow components (see its README).

Dedupe invariant (TelegramSource): each delivered event carries exactly one
correlationId, so a message in a forum topic emits separately-deduped
chat-level and thread-level events (dedupeKey `update:<id>` vs
`update:<id>:thread`).

Trust notes: never trust `initDataUnsafe`; approval callback_data carries no
trust-sensitive state — any chat member can press a button, so re-authorize
by user id where it matters.
