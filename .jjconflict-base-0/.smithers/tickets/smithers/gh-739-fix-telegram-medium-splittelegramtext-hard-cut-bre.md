# 🐛 fix(telegram): [medium] splitTelegramText hard-cut breaks MarkdownV2 escapes and surrogate pairs

GitHub: https://github.com/smithersai/smithers/issues/739

_via ultracode (Opus multi-agent) review_

## Summary
`splitTelegramText` hard-cuts at a raw UTF-16 code-unit index when no newline/space falls past the window midpoint, so a chunk boundary can bisect a MarkdownV2 backslash-escape or an emoji surrogate pair.

## Location
- `packages/telegram/src/index.js:226` — `const end = softCut > Math.floor(maxLength / 2) ? softCut : maxLength;` then `slice(0, end)` / `slice(end)` (lines 227-228).
- Non-retryable path: `isRetryableTelegramError` at `packages/telegram/src/index.js:71-74` (only 429/>=500 retry).

## Failure scenario
Documented usage is escape → split → send as MarkdownV2 (the `TELEGRAM_SAFE_CHUNK_LENGTH` comment, lines 3-5, calls out the headroom as being "for MarkdownV2 escaping"):
`sendTelegramTextChunks(client, { text: escapeTelegramMarkdownV2(longText), parseMode: "MarkdownV2", maxLength: 3800 })`.

Reproduced:
- `splitTelegramText(escapeTelegramMarkdownV2("x"+".".repeat(50)), {maxLength:10})` → chunk 0 = `x\.\.\.\.\` (lone trailing `\`), chunk 1 = `.\.\.\.\.\` (leading bare `.`). Sent as MarkdownV2, Telegram returns HTTP 400 "Bad Request: can't parse entities". 400 is not retryable (lines 71-74), so `call()` throws and the notification is dropped.
- `splitTelegramText("😀".repeat(20), {maxLength:5})` → chunk N ends with lone high surrogate `\ud83d`, chunk N+1 starts with lone low surrogate `\ude00`, delivering broken/replacement characters. `trimEnd`/`trimStart` don't help (neither backslash nor lone surrogates are whitespace).

The hard cut only triggers when the second half of the window (~1900 chars) has no whitespace — reachable for CJK text, long URLs, base64, code blocks, or emoji-dense messages.

## Why it matters
Long agent messages with emoji or MarkdownV2 escaping are the common Smithers→Telegram relay case. A boundary split turns a valid message into a hard, non-retryable 400 (dropped notification) or corrupted output. The failure is data-dependent, so it passes the current tests but breaks in production. Fix: back the cut off to a code-point boundary and never split immediately after an odd run of backslashes (or count the message in graphemes/entities).
