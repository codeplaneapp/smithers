# _coreCorrelation/

The correlation-context core: a per-run/node/attempt context (`{ runId,
nodeId, iteration, attempt, workflowName, parentRunId, traceId, spanId }`)
tracked on TWO stores at once — an AsyncLocalStorage
(`_correlationStorage.js`) for synchronous, non-Effect readers (the imperative
logger) and a FiberRef (`correlationContextFiberRef.js`) for Effect code.

How the pieces fit: `mergeCorrelationContext.js` normalizes patches and
requires a `runId` for a context to exist; `withCorrelationContext.js` bridges
a patch onto BOTH stores; `getCurrentCorrelationContextEffect.js` prefers the
FiberRef and falls back to the ALS; `CorrelationContextLive.js` packages the
whole thing as an Effect service; `index.js` is the barrel that
`../correlation.js` re-exports from.

Gotcha: run effects wrapped by `withCorrelationContext` with `runPromise` or
`runFork`, never `runSync` — its acquire step calls
`AsyncLocalStorage.enterWith()`, which under `runSync` leaks the context into
the caller's synchronous async-context (documented in
`withCorrelationContext.js`).
