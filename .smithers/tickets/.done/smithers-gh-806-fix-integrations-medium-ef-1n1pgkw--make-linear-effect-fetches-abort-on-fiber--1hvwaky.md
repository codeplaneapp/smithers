# Make Linear Effect fetches abort on fiber interruption

GitHub: https://github.com/smithersai/smithers/issues/1029

Parent: smithers/gh-806-fix-integrations-medium-effect-interruptio-0ei8mli.md

Context: packages/integrations/src/linear/LinearClient.js wraps fetch and response.json in Effect.tryPromise without forwarding Effect's interruption signal, allowing interrupted Linear requests to continue. Acceptance criteria: make fetch and response consumption interruptible; preserve retry and error behavior; add a delayed real-server test that interrupts the fiber and verifies prompt cancellation or disconnect.


> Closed by ticket-fleet sync: packages/integrations/src/linear/LinearClient.js now forwards Effect.tryPromise's interruption signal through a per-attempt AbortController to both fetch and response.json(). packages/integrations/tests/linear-client-interrupt.test.js uses real Bun.serve servers to verify prompt cancellation during request and response-body consumption. Retry and error behavior remain covered by linear-client.test.js and cover-linear.test.jsx. The targeted command ran 36 tests with 0 failures.
