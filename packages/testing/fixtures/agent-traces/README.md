# Agent trace fixtures (v1)

Reusable **agent behaviors** for token-free core workflow scenarios.
A fixture is **not** a full scenario — scenarios compose one or more fixtures
into a real Smithers graph (see `tests/scenarios/core-workflows.test.jsx`).

These vectors are **plane-agnostic**: herdr, overview HUD, gateway seeds, and
engine unit tests all consume the same behaviors via `scriptedAgent`.

Cross-plane model: [Token-free visibility testing](../../../../docs/guides/token-free-visibility-testing.mdx).

Load: `loadAgentTraceVector(path)` or test helper `loadFixture("hello-ok")`.

| File | Id | Behavior |
|---|---|---|
| `hello-ok.v1.json` | `hello-ok` | Single success turn |
| `pipeline-implement.v1.json` | `pipeline-implement` | Stage with delay + stream |
| `pipeline-validate.v1.json` | `pipeline-validate` | Second stage success |
| `worker-ok.v1.json` | `worker-ok` | Happy parallel worker |
| `worker-fail.v1.json` | `worker-fail` | Hard fail (use with `retries={0}`) |
| `steer-producer.v1.json` | `steer-producer` | Upstream plan-style success |
| `steer-consumer.v1.json` | `steer-consumer` | `when.promptIncludes` steer branch + default |
| `retry-fail-then-ok.v1.json` | `retry-fail-then-ok` | `attempt:1` fail, `attempt:2` ok |
| `loop-body.v1.json` | `loop-body` | `iteration:0` then `iteration:1` done |
| `hang-timeout.v1.json` | `hang-timeout` | Hang → non-cancel timeout fail |
| `slow-stream.v1.json` | `slow-stream` | Multiple virtual delays + text chunks |
| `branch-then.v1.json` | `branch-then` | Then-path agent |
| `branch-else.v1.json` | `branch-else` | Else-path agent |
