# Cap Telegram server-provided retry_after delays

GitHub: https://github.com/smithersai/smithers/issues/929

Bound parameters.retry_after before converting it to a retry delay in packages/telegram/src/index.js, preventing an unreasonably large server value from blocking cancellation or execution. Add a test asserting the configured cap.
