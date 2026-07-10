# 🐛 fix(integrations): abort Telegram fetches on Effect interruption

GitHub: https://github.com/smithersai/smithers/issues/924

Update packages/integrations/src/telegram/TelegramClient.js so fetch and response consumption honor Effect interruption. Add a delayed real-server test that interrupts the fiber and asserts prompt request cancellation or disconnect.
