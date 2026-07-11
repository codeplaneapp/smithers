# 🐛 fix(telegram): [medium] response-body aborts are retried and retry sleeps ignore cancellation

GitHub: https://github.com/smithersai/smithers/issues/809

_via 2026-07 full-codebase audit_

## Summary

The standalone Telegram client recognizes abort during initial fetch, but an abort from response.text() is wrapped as retryable TelegramNetworkError. Retry sleeps also ignore the request signal.

## Where

- `packages/telegram/src/index.js:258-308`

## Failure scenario / repro

Abort during body consumption: the client wraps AbortError, issues a second request, and may remain pending in an uninterruptible Retry-After sleep.

## Impact

Cancellation can send duplicate Telegram requests and leave a cancelled workflow blocked in backoff.

## Suggested fix

Recheck signal state/AbortError in every catch path, use an abortable sleep tied to the same signal, and cap server retry_after.

## Tests

- Abort during initial fetch, body consumption, and retry sleep
- Assert no second request and prompt rejection in all cases

## Dedupe notes

#739 covers Markdown splitting, not request cancellation.
