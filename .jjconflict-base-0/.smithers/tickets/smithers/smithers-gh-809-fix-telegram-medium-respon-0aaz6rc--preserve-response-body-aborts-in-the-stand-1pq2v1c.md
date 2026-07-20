# Preserve response-body aborts in the standalone Telegram client

GitHub: https://github.com/smithersai/smithers/issues/1074

Parent: smithers/gh-809-fix-telegram-medium-response-body-aborts-a-1v84pm5.md

Context: The standalone Telegram client preserves aborts thrown by fetch, but wraps AbortError failures from response.text() as retryable TelegramNetworkError values, which can issue duplicate requests.

Acceptance criteria:
- Propagate an AbortError or an already-aborted request without wrapping it as retryable network failure.
- Do not issue a second fetch when response body consumption is aborted.
- Add tests covering response.text() rejection, request-attempt count, and prompt rejection.
