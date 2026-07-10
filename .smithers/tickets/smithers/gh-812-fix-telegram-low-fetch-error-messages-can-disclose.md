# 🔒 fix(telegram): [low] fetch error messages can disclose the bot token

GitHub: https://github.com/smithersai/smithers/issues/812

_via 2026-07 full-codebase audit_

## Summary

The standalone Telegram client embeds the bot token in the request URL and copies arbitrary fetch error messages into TelegramNetworkError without redaction.

## Where

- `packages/telegram/src/index.js:264 — token-bearing URL`
- `packages/telegram/src/index.js:88-94,274-276 — unsanitized error wrapping`

## Failure scenario / repro

An injected fetch implementation throws an error containing the URL it received. The public error message then includes the live token-bearing Telegram URL.

## Impact

Bot tokens can enter logs, traces, workflow failure rows, and user-facing diagnostics.

## Suggested fix

Redact the exact token and token-bearing URL before creating public errors. Preserve only sanitized structured diagnostics.

## Tests

- Use fetch that echoes its URL and assert the token appears nowhere in message, cause serialization, or details

## Dedupe notes

The Effect-native Telegram integration has a redaction path; this standalone package does not. #739 is unrelated.
