# 🐛 fix(integrations): [medium] Effect interruption does not abort Telegram, Linear, or GitHub fetches

GitHub: https://github.com/smithersai/smithers/issues/806

_via 2026-07 full-codebase audit_

## Summary

The Effect-native Telegram, Linear, and GitHub clients wrap fetch with Effect.tryPromise but do not accept or forward Effect's interruption signal.

## Where

- `packages/integrations/src/telegram/TelegramClient.js:122-133`
- `packages/integrations/src/linear/LinearClient.js:150-172`
- `packages/integrations/src/github/GitHubClient.js:141-160`

## Failure scenario / repro

Interrupt a fiber waiting on a server that never completes. The fiber stops waiting, but the underlying fetch receives no signal and remains active.

## Impact

Shutdown, cancellation, and timeout paths leak sockets and allow remote side effects to continue after workflow interruption.

## Suggested fix

Use the interruptible Effect.tryPromise form and pass its signal into fetch and response consumption.

## Tests

- Use a delayed real server for each client, interrupt the fiber, and assert prompt disconnect/cancellation

## Dedupe notes

#692 concerns queue-drain shutdown ordering, not outbound fetch interruption.


> Closed by ticket-fleet sync: Implemented in TelegramClient.js:143-161, LinearClient.js:160-189, and GitHubClient.js:143-163. Each forwards Effect interruption to fetch and response consumption. Real delayed-server tests cover both request and body-read interruption: telegram-interrupt.test.js, linear-client-interrupt.test.js, and github-interruption.test.js. Targeted run passed all 6 tests with 0 failures.
