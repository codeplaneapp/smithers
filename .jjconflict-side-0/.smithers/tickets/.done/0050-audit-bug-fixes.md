# Bug fixes — remaining

> Target repo: **smithers** (this repo)
> Source: GitHub issue [#303](https://github.com/smithersai/smithers/issues/303) · 2026-06-16 bulletproof audit
> Triaged 2026-06-18 against `main` (post-#442 merge train): **35 of 50 resolved, 15 still open**

## Context

Correctness bugs from the audit. 35 of 50 fixed by the #409–#442 wave; these 15 still reproduce in current code.

Each item below is still open in current `main`. Text is the original audit finding (severity + file:line). `remaining:` notes come from the 2026-06-18 verification pass. Check items off here as they land, and mirror the check-off on issue #303.

## Open items

- [x] **P2** answerHumanRequest argument order differs between SmithersDb and the (dead) InMemoryStorage — ``
  - _remaining:_ InMemoryStorage not removed (exported as InMemoryStorageLive); arg order still swapped vs SmithersDb. No fix commit. Dead code but the documented mismatch remains.
- [x] **P2** applyDelta validation is asymmetric: addNode/updateProps/updateTask accept malformed payloads and corrupt the tree — `packages/devtools/src/applyDelta.js:82-110`
  - _remaining:_ Asymmetric validation remains; addNode/updateProps/updateTask accept malformed payloads and cloneValue corrupts the tree.
- [x] **P2** snapshotSerializer maxEntries does not bound flat arrays/objects of scalars — `packages/devtools/src/snapshotSerializer.js:56-80`
  - _remaining:_ Flat arrays/objects of scalars are still unbounded by maxEntries (each scalar bypasses the cap).
- [x] **P2** applyDelta replaceRoot/addNode/removeNode/updateProps reject only by side effects, but updateProps with no props key sets node.props = undefined — `packages/devtools/src/applyDelta.js:96`
  - _remaining:_ updateProps with no props key still sets node.props=undefined.
- [x] **P2** builder fragment(_inputSchema) silently discards its input schema argument — `packages/engine/src/effect/builder.js:1201-1203`
  - _remaining:_ fragment() still silently discards its input schema argument.
- [x] **P2** useGatewayExtensionStream never clears `error` after a successful reconnect — `packages/gateway-react/src/useGatewayExtensionStream.ts:66-101`
  - _remaining:_ error state still not cleared after a successful reconnect.
- [x] **P2** deleteThread is non-transactional across two writes (partial-delete risk) — `packages/memory/src/store/MemoryStoreLive.js:200-211`
  - _remaining:_ Partial-delete risk remains (non-transactional).
- [x] **P2** Pre-loaded object specs without an `openapi` key (e.g. Swagger 2.0) throw a misleading parse error — `packages/openapi/src/loadSpecSync.js:16-27, packages/openapi/src/loadSpecEffect.js:18-21`
  - _remaining:_ Swagger 2.0 / no-openapi-key object still throws a misleading parse error.
- [x] **P2** reconciler.js has top-level side effects but package.json declares sideEffects:false — `packages/react-reconciler/src/reconciler.js:400-410`
  - _remaining:_ sideEffects:false still declared while reconciler.js has top-level side effects.
- [x] **P1** Deep subpath imports resolve types to index.d.ts and break for strict TS consumers (TS2305/TS2459) — `packages/sandbox/package.json:13-17 (exports "./*" types -> ./src/index.d.ts); packages/sandbox/src/sandboxPath.js; packages/sandbox/src/effect/sandbox-entity.js`
  - _remaining:_ Deep subpath types still all route to index.d.ts; strict TS consumers (TS2305/TS2459) still break.
- [x] **P2** Type-only subpath @smithers-orchestrator/sandbox/SandboxHandle also breaks external strict TS consumers (extends finding #1) — `packages/sandbox/src/SandboxHandle.ts; packages/sandbox/package.json:13-17; e2e/harness/stallSandbox.ts:2`
  - _remaining:_ Type-only subpath resolution still broken (same root cause as #40).
- [x] **P2** WorkflowSessionLive builds a single shared session — a latent correctness bug if ever consumed — ``
  - _remaining:_ Still a single shared session per layer build (Layer.sync memoizes one instance), not per-consumer. Latent — unconsumed.
- [x] **P2** diffSnapshots ignores outputTable changes in node-change detection — `packages/time-travel/src/diff.js:39-42`
  - _remaining:_ diffSnapshots still ignores outputTable changes in node-change detection.
- [x] **P2** readUsageCache does not validate cache version and accepts array `entries` — `packages/usage/src/usageCache.js:29-37`
  - _remaining:_ readUsageCache still does not validate cache version and accepts array entries.
- [x] **P2** Extension-stream reconnect backoff timer ignores the abort signal — `packages/gateway-react/src/useGatewayExtensionStream.ts:94`
  - _remaining:_ Reconnect backoff timer still ignores the abort signal.
