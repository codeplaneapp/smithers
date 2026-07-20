# Make GitHub Effect fetches abort on fiber interruption

GitHub: https://github.com/smithersai/smithers/issues/1030

Parent: smithers/gh-806-fix-integrations-medium-effect-interruptio-0ei8mli.md

Context: packages/integrations/src/github/GitHubClient.js performs fetch and response.text inside Effect.tryPromise without forwarding Effect's interruption signal, allowing interrupted GitHub requests to remain active. Acceptance criteria: make fetch and response consumption interruptible; preserve retry, pagination, schema, and error behavior; add a delayed real-server test that interrupts the fiber and verifies prompt cancellation or disconnect.


> Closed by ticket-fleet sync: Implemented in packages/integrations/src/github/GitHubClient.js:143-163: Effect.tryPromise forwards its interruption signal to fetch, and response.text() runs within the same interruptible promise. packages/integrations/tests/github-interruption.test.js:19-105 uses real delayed Bun.serve endpoints to verify prompt interruption during fetch and response-body consumption; the tests passed. Existing retry, pagination, error, and schema coverage is in packages/integrations/tests/github-client.test.js and packages/integrations/tests/cover-github.test.jsx. Targeted run passed all 22 tests with 0 failures.
