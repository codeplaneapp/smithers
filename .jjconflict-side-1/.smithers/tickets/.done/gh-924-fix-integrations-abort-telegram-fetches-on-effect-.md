# 🐛 fix(integrations): abort Telegram fetches on Effect interruption

GitHub: https://github.com/smithersai/smithers/issues/924

Update packages/integrations/src/telegram/TelegramClient.js so fetch and response consumption honor Effect interruption. Add a delayed real-server test that interrupts the fiber and asserts prompt request cancellation or disconnect.


> Closed by ticket-fleet sync: packages/integrations/src/telegram/TelegramClient.js links Effect interruption signals to a shared AbortController for both fetch and response.json() consumption. packages/integrations/tests/telegram-interrupt.test.js contains real Bun.serve delayed-server tests for mid-request and mid-body-read interruption, asserting cancellation within 2 seconds. The targeted test passed 2/2, and the full integrations suite passed 242/242 tests.
