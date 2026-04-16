# Add Per-Node Output RPC with Schema Hints

> Quality bar: spec §9. Every tier required.

## Context

Spec: `.smithers/specs/live-run-devtools-ui.md` §2.2 "Output tab" and §4.2.

The gui's Output tab renders a task's structured JSON output in schema
order with display hints (enum values, optional flags). This RPC returns
the row and a serializable schema descriptor.

## Scope

### `getNodeOutput(runId, nodeId, iteration) → NodeOutputResponse`

```ts
type NodeOutputResponse = {
  status: "produced" | "pending" | "failed";
  row: Record<string, unknown> | null;
  schema: OutputSchemaDescriptor | null;
  partial?: Record<string, unknown> | null;  // only when status === "failed"
};

type OutputSchemaDescriptor = {
  fields: Array<{
    name: string;
    type: "string" | "number" | "boolean" | "object" | "array" | "null" | "unknown";
    optional: boolean;
    nullable: boolean;
    description?: string;
    enum?: readonly unknown[];
  }>;
};
```

On call:

1. Validate inputs.
2. Resolve `_smithers_nodes.outputTable` for (runId, nodeId).
3. Fetch row via `selectOutputRow(db, table, { runId, nodeId, iteration })`.
4. Extract schema via `getAgentOutputSchema(table)` → descriptor.
5. If no row and task failed: load partial from
   `_smithers_attempts.heartbeatDataJson` of latest attempt.
6. Return typed response.

### Error codes

- `InvalidRunId`, `InvalidNodeId`, `InvalidIteration`.
- `RunNotFound`, `NodeNotFound`, `IterationNotFound`.
- `NodeHasNoOutput` — node is not a Task or has no outputTable.
- `SchemaConversionError` — Zod schema uses an unsupported construct; we
  return a partial descriptor + log warning but do not fail the call.
- `MalformedOutputRow` — DB row is not parseable JSON.

## Files (expected)

- `packages/db/src/output-schema-descriptor.ts` (new)
- `packages/server/src/gatewayRoutes/getNodeOutput.ts` (new)
- `packages/server/src/gateway.ts` (register)
- `packages/protocol/src/outputs.ts` (new wire types)
- `packages/protocol/src/errors.ts` (extend)
- `packages/db/tests/outputSchemaDescriptor.test.ts` (new)
- `packages/server/tests/getNodeOutput.test.ts` (new)
- `packages/server/tests/getNodeOutput.integration.test.ts` (new)

## Testing & Validation

### Unit tests — schema descriptor

Every case is a Zod schema → expected descriptor:

- `z.object({ a: z.string() })` → 1 field, string, not optional/nullable.
- `z.object({ a: z.string().optional() })` → optional true.
- `z.object({ a: z.string().nullable() })` → nullable true.
- `z.object({ a: z.string().describe("help") })` → description set.
- `z.object({ a: z.enum(["x", "y"]) })` → enum = ["x","y"], type = "string".
- `z.object({ a: z.number().int().min(0).max(100) })` → type "number"
  (bounds not preserved in v1, OK — note in doc).
- `z.object({ a: z.array(z.string()) })` → type "array".
- `z.object({ a: z.object({ b: z.string() }) })` → type "object" (nested
  not expanded in v1).
- `z.object({ a: z.union([z.string(), z.number()]) })` → type "unknown"
  + log warn.
- `z.object({})` → empty fields array.
- 100-field object → all fields present in declared order.
- `z.record(z.string(), z.any())` → type "object" + description.

### Unit tests — handler

- status "produced" when row exists.
- status "pending" when task queued but not started.
- status "pending" when task running but no output yet.
- status "failed" when `_smithers_attempts.errorJson` set and row null.
- status "failed" + partial populated when heartbeatDataJson present.
- Iteration > max iteration → `IterationNotFound`.
- Node has no outputTable → `NodeHasNoOutput`.
- Malformed row JSON → `MalformedOutputRow` + log error.

### Input-boundary tests

| Case                              | Expected                          |
|-----------------------------------|-----------------------------------|
| runId / nodeId / iteration invalid| typed `Invalid*` errors           |
| iteration = 0, task not started   | status "pending", schema present  |
| row with 1 MB string field        | returned intact                   |
| row with 10,000-element array     | returned intact                   |
| row with 100 fields               | all fields in response            |
| row with deeply nested (20 levels)| returned; no flattening           |
| row with unicode / emoji          | round-trips                       |
| row with null values              | nulls preserved                   |
| row payload > 10 MB               | returned; log warn if > 1 MB      |
| row payload > 100 MB              | `PayloadTooLarge`                 |

### Integration tests

- Finished task writes output via real engine. RPC returns matching
  row + schema.
- Running task before output → pending.
- Failed task with partial heartbeat data → failed + partial returned.
- Task with custom Zod schema using describe() → description in
  descriptor.

### Performance tests

- Call with cached row < 20ms p95.
- Call with 1 MB row < 50ms p95.
- Call with 10 MB row < 200ms p95.
- Schema descriptor generation for 100-field schema < 5ms.

## Observability

### Logs

- `info` per call: `{ runId, nodeId, iteration, status, rowBytes, durationMs }`.
- `warn` on SchemaConversionError with the construct that failed
  (no actual prop content).
- `error` on MalformedOutputRow, DB error.

### Metrics

- Counter: `smithers_node_output_request_total{status}`.
- Histogram: `smithers_node_output_bytes`.
- Histogram: `smithers_node_output_duration_ms`.
- Counter: `smithers_node_output_schema_conversion_error_total`.

### Traces

- Span `devtools.getNodeOutput` with attrs `runId`, `nodeId`,
  `iteration`, `status`, `bytes`.
- Span `db.outputs.select`.
- Span `devtools.buildSchemaDescriptor`.

## Security

- Gateway auth.
- Input validation per §9.5.
- No output content in any log above `debug`.
- Cross-run node access → rejected.

## Acceptance

- [ ] All unit cases above pass.
- [ ] All boundary cases return documented response.
- [ ] Integration tests drive real tasks.
- [ ] Performance budgets met.
- [ ] Error codes emitted correctly.
- [ ] Logs/metrics/traces emitted; no output content leaked.
- [ ] Protocol doc updated.

## Blocks

- smithers/0014 (CLI)
- gui/0077 (Output tab)
