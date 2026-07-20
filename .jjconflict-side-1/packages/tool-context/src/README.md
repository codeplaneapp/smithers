# @smithers-orchestrator/tool-context — src

AsyncLocalStorage-backed ambient `ToolContext`
(runId/nodeId/iteration/attempt/rootDir/idempotencyKey/seq/durabilitySnapshot)
handed to in-process agent tools while a node attempt runs. Extracted into its
own package so both `engine` and `smithers` can depend on it without a cycle.

`index.js` just re-exports `toolContext.js`. The API:

- `runWithToolContext(ctx, fn)` — scope a context; survives awaits inside `fn`.
- `getToolContext()` — read the ambient context (or `undefined`).
- `getToolIdempotencyKey(ctx?)` — explicit `idempotencyKey` wins, else
  `smithers:<runId>:<nodeId>:<iteration>`, else `null`.
- `nextToolSeq(ctx)` — increments and returns `ctx.seq` (mutates the context).

Every `ToolContext` field is optional by design — helpers degrade gracefully
for partial or absent contexts. `src/index.d.ts` is generated-but-committed
(`tsup --dts-only`) — never hand-edit it.
