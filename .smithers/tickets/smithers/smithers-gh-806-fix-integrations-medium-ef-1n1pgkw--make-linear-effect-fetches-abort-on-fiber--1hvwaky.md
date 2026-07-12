# Make Linear Effect fetches abort on fiber interruption

GitHub: https://github.com/smithersai/smithers/issues/1029

Parent: smithers/gh-806-fix-integrations-medium-effect-interruptio-0ei8mli.md

Context: packages/integrations/src/linear/LinearClient.js wraps fetch and response.json in Effect.tryPromise without forwarding Effect's interruption signal, allowing interrupted Linear requests to continue. Acceptance criteria: make fetch and response consumption interruptible; preserve retry and error behavior; add a delayed real-server test that interrupts the fiber and verifies prompt cancellation or disconnect.
