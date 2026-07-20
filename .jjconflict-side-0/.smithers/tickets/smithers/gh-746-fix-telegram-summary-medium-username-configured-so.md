# 🐛 fix(telegram-summary): [medium] username-configured source chat drops every message

GitHub: https://github.com/smithersai/smithers/issues/746

_via ultracode (Opus multi-agent) review_

## Summary
When `TELEGRAM_SUMMARY_SOURCE_CHAT_ID` is set to a `@username` (a documented option, README:31), `messageMatchesChat` never matches and every message is silently filtered out.

## References
- `apps/telegram-summary/src/service.ts:151-157` — `chatIdFromMessage` returns `String(chat.id)` whenever `chat.id` is present; the `@${chat.username}` fallback only fires when `chat.id` is absent (never true for real messages).
- `apps/telegram-summary/src/service.ts:181-184` — `messageMatchesChat` compares only `message.chatId` (always numeric) against `wanted` / `wanted.replace(/^@/,"")` / `@${wanted}`.
- `apps/telegram-summary/src/service.ts:297-298` — filtered messages are the only ones inserted.
- `apps/telegram-summary/README.md:31` — documents the field as "Group chat id **or username**".

## Failure scenario
Operator sets `TELEGRAM_SUMMARY_SOURCE_CHAT_ID=@mygroup`. A message arrives with `chat={id:-1001234567890, username:'mygroup'}`. `chatIdFromMessage` returns `"-1001234567890"`. `messageMatchesChat("-1001234567890","@mygroup")` evaluates `"-1001234567890" === "@mygroup"` (false), `=== "mygroup"` (false), `=== "@@mygroup"` (false) → false. The message is dropped and never inserted. `storedMessages` stays 0 and every daily digest is empty forever, with no error surfaced.

## Why it matters
A documented, supported configuration turns the bot into a silent no-op: zero stored messages, zero digests, no warning. `MessageRecord` carries no `username` field, so the mismatch cannot be recovered at match time. Fix by storing/comparing `chat.username` on the record, or by resolving the configured username to a numeric id at ingest.
