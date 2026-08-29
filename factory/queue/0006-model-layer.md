---
status: queued
anchor: head
priority: p1
---

# The Model layer

Implement the model service specified in the "Model Layer" spec (decided
2026-07-28: hand-roll, "copy opencode's skeleton, transplant pi's scar
tissue"): a plain stateless Effect
service, assembled context in, token stream out, typed errors, exact control
of the wire request because the request is sealed-step key material.

- Architecture from `reference/opencode` `packages/llm`: Protocol × Endpoint
  × Auth × Framing routes, SSE state machines per protocol, injectable
  `RequestExecutor` with retry/backoff and secret redaction.
- Wire knowledge from the pi findings note (deferred tool loading, prompt
  cache discipline, aborted-call encoding), copied per the note's table.
- Type-surface sanity check against `reference/effect` `unstable/ai`; no
  dependency on it.
- This is the last engine dependency of the factory flow's agent phases
  (item 0003) besides lanes (item 0004): with Model and Jj lanes, the
  docs/implement/verify phases become Smithers-native.
- Vault cadence applies: reviewed piece; record deviations in the note.
