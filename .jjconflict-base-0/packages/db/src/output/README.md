# output/

Helpers for per-workflow output tables keyed by `(runId, nodeId, iteration)`.

- `getKeyColumns` / `buildKeyWhere` resolve the key columns of an output table
  (`iteration` is optional); `buildOutputRow` shapes a payload into a row
  (payload-only column vs spread schema); `stripAutoColumns` removes the
  auto-populated key fields.
- `validateOutput` (drizzle-zod insert schema) and `validateExistingOutput`
  (select schema) are a deliberate twin pair — same shape, different
  nullability rules; keep both.
- `selectOutputRowEffect.js` / `upsertOutputRowEffect.js` are the Effect-native
  read/write paths (SmithersError-typed, log-annotated); the upsert goes through
  `withSqliteWriteRetryEffect` via `../write-retry.js`.
- `describeSchemaShape` renders a schema as JSON Schema (or a `field: type` map
  fallback) for embedding in agent prompts; `getAgentOutputSchema` strips
  `runId`/`nodeId`/`iteration` from a table's insert schema.
