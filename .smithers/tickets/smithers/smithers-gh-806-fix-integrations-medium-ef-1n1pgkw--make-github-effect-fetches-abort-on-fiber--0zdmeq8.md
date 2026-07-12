# Make GitHub Effect fetches abort on fiber interruption

GitHub: https://github.com/smithersai/smithers/issues/1030

Parent: smithers/gh-806-fix-integrations-medium-effect-interruptio-0ei8mli.md

Context: packages/integrations/src/github/GitHubClient.js performs fetch and response.text inside Effect.tryPromise without forwarding Effect's interruption signal, allowing interrupted GitHub requests to remain active. Acceptance criteria: make fetch and response consumption interruptible; preserve retry, pagination, schema, and error behavior; add a delayed real-server test that interrupts the fiber and verifies prompt cancellation or disconnect.
