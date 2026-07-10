# 🐛 fix(integrations): abort GitHub fetches on Effect interruption

GitHub: https://github.com/smithersai/smithers/issues/926

Update packages/integrations/src/github/GitHubClient.js so fetch and response consumption honor Effect interruption, including pagination and retry paths. Add a delayed real-server test that interrupts the fiber and asserts prompt request cancellation or disconnect.
