# 🧹 observability: _coreTracing.getCurrentSmithersTraceAnnotations shadows the public export with different semantics

GitHub: https://github.com/smithersai/smithers/issues/602

**What happens**
`apps/observability/src/_coreTracing.js:23-28` exports `getCurrentSmithersTraceAnnotations()` that derives `traceId`/`spanId` from the correlation context (`getCurrentCorrelationContext()`), while the public implementation `apps/observability/src/getCurrentSmithersTraceAnnotations.js` (exported by `index.js`, used by `src/logging.js`, `packages/server/src/smithersRuntime.js`, `apps/cli/src/smithersRuntime.js`) reads the live OTLP span from `smithersTraceSpanStorage`.

**Why it's wrong**
No in-repo code imports the `_coreTracing` variant (importers take `TracingService`, `TracingServiceLive`, `annotateSmithersTrace`, `withSmithersSpan`), but the package's `"./*"` wildcard export makes `observability/_coreTracing` importable — anyone who picks that path gets silently different trace annotations under an identical name.

**Expected behavior**
A single implementation, or a distinct name for the correlation-context variant (or drop it from `_coreTracing.js` since nothing uses it).

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
