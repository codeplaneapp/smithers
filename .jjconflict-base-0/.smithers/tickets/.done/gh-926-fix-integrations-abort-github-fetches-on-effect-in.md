# 🐛 fix(integrations): abort GitHub fetches on Effect interruption

GitHub: https://github.com/smithersai/smithers/issues/926

Update packages/integrations/src/github/GitHubClient.js so fetch and response consumption honor Effect interruption, including pagination and retry paths. Add a delayed real-server test that interrupts the fiber and asserts prompt request cancellation or disconnect.


> Closed by ticket-fleet sync: packages/integrations/src/github/GitHubClient.js:143-163 wraps fetch and response.text() in Effect.tryPromise and forwards its interruption signal; retry and pagination paths use this through requestUrl at 201-222 and paginate at 227-247. packages/integrations/tests/github-interruption.test.js contains real delayed-server tests for interrupting both an in-flight request and stalled response-body consumption, asserting interrupted exits, prompt completion, and server-side disconnects. The integrations suite passed with 242 tests and 0 failures, and package typecheck passed. github-client.test.js:114-135 covers retries and pagination.
