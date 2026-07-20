# Preserve cancellation during Telegram response-body consumption

GitHub: https://github.com/smithersai/smithers/issues/927

Update packages/telegram/src/index.js so AbortSignal.aborted and AbortError from response.text() are propagated as cancellation instead of wrapped in TelegramNetworkError and retried. Add tests proving abort during initial fetch and response.text() rejects without a second request.
