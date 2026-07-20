# Cap server-provided Telegram retry_after delays

GitHub: https://github.com/smithersai/smithers/issues/1076

Parent: smithers/gh-809-fix-telegram-medium-response-body-aborts-a-1v84pm5.md

Context: telegramDelayMs currently honors any finite positive Telegram parameters.retry_after value without an upper bound, allowing a server response to block retries for an unbounded duration.

Acceptance criteria:
- Define and document a finite maximum retry_after delay for the standalone client.
- Clamp larger server-provided retry_after values to that maximum while preserving normal retry_after behavior.
- Add tests for values below, at, and above the cap.
