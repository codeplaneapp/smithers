# @smithers-orchestrator/observability — src

The concrete observability implementation: Effect-based metrics, logging, and
tracing services, OTLP layer wiring (`createSmithersObservabilityLayer`,
`createSmithersOtelLayer`, `createSmithersRuntimeLayer`), the agent-trace
pipeline (`detectAgentFamily`, `detectCaptureMode`, `_traceEventNormalizers`,
`_traceRedaction`, the `*ToOtelLogRecord` builders, `_sessionFileResolvers`),
and Prometheus text rendering.

Conventions: one export per file, with type-only `.ts` sidecars next to the
`.js` implementations. `package.json` exposes a `./*` wildcard onto `src/`, so
EVERY file here is an importable public subpath — `packages/engine` imports the
underscore modules directly (e.g. `observability/_traceEventNormalizers`). Do
not rename, move, or delete files. `_core*` modules hold shared implementations
behind the root shim files that `index.js` re-exports. The correlation context
is dual-tracked (AsyncLocalStorage for imperative reads, FiberRef for Effect
code) under `_coreCorrelation/`.

Entry points: `index.js` (main export), `metrics/index.js` (the `./metrics`
subpath), `createSmithersObservabilityLayer.js` (layer composition), and
`logging.js` (fire-and-forget logs with a pluggable runtime via
`setSmithersLogRunner`).

Gotchas: `index.d.ts`, `metrics/index.d.ts`, and the hash-suffixed `*-*.d.ts`
chunks are build artifacts of `tsup --dts-only` (the build script `rm`s them
first) — never edit them. `correlation.js`'s `updateCurrentCorrelationContext`
is a deliberately mutating legacy shim, distinct from the Effect version in
`_coreCorrelation/`.
