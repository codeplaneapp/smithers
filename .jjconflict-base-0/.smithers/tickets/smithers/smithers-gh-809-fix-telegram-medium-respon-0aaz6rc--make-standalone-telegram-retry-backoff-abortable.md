# Make standalone Telegram retry backoff abortable

GitHub: https://github.com/smithersai/smithers/issues/1075

Parent: smithers/gh-809-fix-telegram-medium-response-body-aborts-a-1v84pm5.md

Context: Retry backoff currently uses a plain timer and does not observe the request signal, so a cancelled request can remain pending until the retry delay ends.

Acceptance criteria:
- Tie retry sleep to the same AbortSignal passed to the Telegram call.
- Reject promptly when the signal aborts during retry sleep.
- Do not issue another request after cancellation.
- Add tests covering cancellation during retry sleep and confirming no additional fetch.
