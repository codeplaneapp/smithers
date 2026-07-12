# Make Telegram Effect fetches abort on fiber interruption

GitHub: https://github.com/smithersai/smithers/issues/1028

Parent: smithers/gh-806-fix-integrations-medium-effect-interruptio-0ei8mli.md

Context: packages/integrations/src/telegram/TelegramClient.js wraps Telegram fetch and response consumption in Effect.tryPromise without using Effect's interruption signal, so interrupting a waiting fiber can leave the HTTP request active. Acceptance criteria: pass the interrupt signal to the Telegram fetch and ensure response consumption is cancelled with the request; preserve existing error redaction, retries, and fallback behavior; add a delayed real-server test that interrupts the fiber and verifies prompt request cancellation or disconnect.
