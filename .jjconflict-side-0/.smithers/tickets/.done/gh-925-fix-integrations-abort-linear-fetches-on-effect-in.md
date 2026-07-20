# 🐛 fix(integrations): abort Linear fetches on Effect interruption

GitHub: https://github.com/smithersai/smithers/issues/925

Update packages/integrations/src/linear/LinearClient.js so fetch and response consumption honor Effect interruption, including retry paths. Add a delayed real-server test that interrupts the fiber and asserts prompt request cancellation or disconnect.


> Closed by ticket-fleet sync: packages/integrations/src/linear/LinearClient.js:149-190 forwards Effect interruption to AbortController for fetch and response.json(), including retry attempts, while retry delays use Effect.sleep. Real-server interruption coverage is in packages/integrations/tests/linear-client-interrupt.test.js:37-97 for stalled requests and partial response bodies. Retry behavior is covered in linear-client.test.js:96-101. Full package verification passed: 242 tests, 0 failures.
