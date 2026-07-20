# Make Telegram retry backoff abortable

GitHub: https://github.com/smithersai/smithers/issues/928

Tie retry sleeps in packages/telegram/src/index.js to the request signal so aborting during exponential or Retry-After backoff rejects promptly and prevents another request. Add a focused retry-sleep cancellation test.
