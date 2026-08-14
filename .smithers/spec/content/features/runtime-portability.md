# Runtime portability and browser execution

> **Status:** Fixed | **Priority:** P1 | **Owner:** smithers-maintainers | **Group:** Platform & delivery | **Tier:** Platform

Run the portable Smithers driver, scheduler, renderer, dependency model, schema validation, and in-process tasks in browsers or custom hosts through an explicit RuntimeAdapter capability contract.

## What you can do

Embed real Smithers workflow execution in a browser or non-Node host while unavailable filesystem and process capabilities fail explicitly.

## Capabilities

### Browser facade

`smthrs/browser` exports workflow definition, runtime construction, reusable and one-shot runners, and browser-safe primitives.

### RuntimeAdapter

Clock, storage, UUID, task execution, filesystem, subprocess, worktree, and sandbox are explicit host seams.

### Fail-closed capabilities

The default browser runtime throws typed errors for filesystem, subprocess, worktree, and sandbox operations.

### Conformance proof

Node and browser proofs exercise unique runs, durable save semantics, dependency outputs, engine-owned schema rejection, and capability errors.

## Endpoints and commands

- `API createBrowserSmithers` ([docs](docs/runtime/browser.mdx))
- `API runBrowserWorkflow` ([docs](docs/runtime/browser.mdx))
- `API createBrowserRuntime` ([docs](docs/runtime/browser.mdx))
- `API RuntimeAdapter` ([docs](docs/runtime/browser.mdx))

## Related docs

- [Browser runtime](docs/runtime/browser.mdx)
- [Package exports](docs/reference/package-configuration.mdx)

## Test cases

- `packages/engine/tests/browser.test.jsx`
- `packages/driver/tests/browser-runtime.test.js`
- `packages/driver/tests/runtime-adapter-threading.test.js`
- `packages/testing/tests/runtimeConformance.test.ts`
- `e2e/browser/run-browser.mjs`

## Observability

- RuntimeCapabilityError records the runtime name, capability, and attempted operation for unavailable host services.
- BrowserSmithers exposes persisted run state and output snapshots through its selected RuntimeStorage adapter.

## Debugging

- Catch RuntimeCapabilityError and inspect capability and operation when portable code reaches a Node-only boundary.
- Inject deterministic clock, storage, UUID, or executeTask adapters to reproduce host-specific failures.

## Architecture

- `packages/driver` defines RuntimeAdapter and the default browser and Node runtime implementations.
- `packages/engine/src/browser.js` composes the production driver, scheduler, renderer, graph extractor, and browser-safe component exports.
- `packages/smithers/src/browser.js` is the browser-safe public facade and deliberately avoids the Node barrel.

## Fixes and diffs

- 2026-07-18 feature and docs audit: added browser and RuntimeAdapter portability as a first-class platform feature with a dedicated Mintlify page; 22 focused browser, adapter-threading, and conformance tests passed.
- `packages/driver`
- `packages/engine`
- `packages/smithers/src/browser.js`
- `packages/testing/src/runtimeConformance.ts`
- `docs/runtime/browser.mdx`
