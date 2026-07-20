# 🐛 electric-proxy: `electric.shape.forwarded` reports the process-wide forwardedBytes counter as the closing stream's byte count

GitHub: https://github.com/smithersai/smithers/issues/541

**What happens**
When a shape stream releases, the proxy emits `electric.shape.forwarded` with `forwardedBytes: metrics.snapshot().forwardedBytes` (`packages/electric-proxy/src/createSmithersElectricProxy.ts:714`). That counter is the global cumulative total — every stream's `wrapBody` pull increments it (createSmithersElectricProxy.ts:525).

**Why it's wrong / failure scenario**
With two concurrent shape streams, each stream's close event reports the sum of both streams' traffic; over a long-lived proxy the field is effectively "bytes since process start", which makes per-shape telemetry (and anything aggregating it) meaningless or double-counted.

**Expected**
Track a per-stream byte count inside `wrapBody` and report that in the event — or rename the field to make clear it is a process total.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
