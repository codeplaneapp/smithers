# 🐛 fix(integrations): abort Linear fetches on Effect interruption

GitHub: https://github.com/smithersai/smithers/issues/925

Update packages/integrations/src/linear/LinearClient.js so fetch and response consumption honor Effect interruption, including retry paths. Add a delayed real-server test that interrupts the fiber and asserts prompt request cancellation or disconnect.
