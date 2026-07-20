# ⚡ agents: [high] launchDiagnostics blocks the event loop via synchronous spawn

GitHub: https://github.com/smithersai/smithers/issues/677

_via ultracode (Opus multi-agent) review_

**Summary:** `launchDiagnostics()`, invoked fire-and-forget on every agent generate/stream, synchronously runs all its `spawnSync` probes on the shared Node event loop before returning its promise — freezing all concurrency for up to the summed spawnSync timeouts.

**Mechanism (async-until-first-await):**
- `packages/agents/src/diagnostics/getDiagnosticStrategy.js:32` (`spawnSync("which", ...)`), `:75` (`spawnSync("claude", ["auth","status"], {timeout: 15_000})`), `:149` (keychain `security ...` `{timeout: 5_000}`), `:563` (`gcloud ...` `{timeout: 3_000}`) — each is the check's first effectful statement with no preceding `await`, so the async body blocks synchronously through it.
- `packages/agents/src/diagnostics/runDiagnostics.js:46` — `strategy.checks.map((check) => runCheck(check, ctx))` is evaluated as the `Promise.all` argument **before** the `await`.
- `runDiagnostics.js:20` — `runCheck` evaluates `check.run(ctx)` synchronously as the `Promise.race` argument, before its `await`.
- `packages/agents/src/diagnostics/launchDiagnostics.js:21` — `run(strategy, ctx)` invokes the async `runDiagnostics` synchronously, so the "launch" blocks before it returns.
- `packages/agents/src/BaseCliAgent/BaseCliAgent.js:1006` (also `PiAgent.js:445`) — called unconditionally, treated as background work.

**Failure scenario:** A `claude` agent in subscription mode (`ANTHROPIC_API_KEY` unset) calls `generate()`. At `BaseCliAgent.js:1006`, before the real agent command is even spawned, the event loop freezes synchronously running `spawnSync("which", ...)`, then `spawnSync("claude", ["auth","status"], {timeout: 15_000})` (up to 15s), then the 5s keychain probe. The 5s `Promise.race` timeout at `runDiagnostics.js:22` is a `setTimeout` that cannot fire while the loop is blocked, so it provides no protection. Every concurrent fiber (schedulers, gateway RPC, other agents, heartbeats) stalls for the summed duration on each call.

**Why it matters:** The fire-and-forget "launch" design (overlap diagnostics with the agent run) is defeated — the launch itself blocks. In a durable multi-run control plane a synchronous `spawnSync` on the shared event loop serializes all concurrency and can freeze the process for many seconds per invocation, causing missed timeouts/heartbeats and apparent hangs. Fix: use async `spawn`/`execFile` (or defer off the hot path) so the per-check `Promise.race` timeout can actually interrupt a stuck probe.
