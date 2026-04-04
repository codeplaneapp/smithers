# Enrich `smithers node` with deep inspectability

## Revision Summary

- Added a compact-first output strategy so large retry chains stay readable by
  default.
- Clarified that token usage and cost come from events/derived data, not a single
  dedicated table.
- Added implementation work for iteration selection, truncation, and stable `--json`
  output.
- Added a phased rollout so the enriched human view can ship before every optional
  expansion flag.

## Problem

The `smithers node <id> -r <runId>` command returns raw DB fields (state,
lastAttempt, iteration). It doesn't show the information operators actually need
when debugging a specific node: tool calls, token usage, retry chain with errors,
validated vs raw output, cost, and duration.

The data already exists across `_smithers_attempts`, `_smithers_tool_calls`,
`_smithers_cache`, `_smithers_events`, and `_smithers_scorers` — it just isn't
aggregated into the node detail view.

## Proposal

Enrich the `smithers node` output to include per-node:

```
$ smithers node review-step -r abc123

Node: review-step (iteration 0)
Status: finished
Duration: 4.2s
Attempts: 3 (2 failed, 1 succeeded)

Attempt 1 — failed (1.1s)
  Error: SchemaValidationError: output.confidence must be number

Attempt 2 — failed (0.8s)
  Error: SchemaValidationError: output.confidence must be >= 0

Attempt 3 — finished (2.3s)
  Tokens: 1,204 in / 312 out ($0.0043)
  Tool calls:
    web-search (0.9s) → 3 results
    read-file (0.1s) → ok
  Output (validated): { confidence: 0.87, summary: "..." }

Scorer: quality-check → 0.91
```

### Data to aggregate

- **Attempts** — from `_smithers_attempts` (state, timing, error)
- **Tool calls** — from `_smithers_tool_calls` (name, input summary, output summary,
  duration, status)
- **Token usage** — from `TokenUsageReported` events
- **Validated output** — from `_smithers_cache` (payloadJson)
- **Schema errors** — from attempt error details
- **Scorer results** — from `_smithers_scorers`
- **Duration** — computed from attempt start/finish timestamps

### Flags

- `--json` — full structured output
- `--attempts` — show all attempts expanded (default: show latest, summarize prior)
- `--tools` — expand tool call inputs/outputs

## Additional Steps

1. Add an aggregation helper that joins attempts, tool calls, scorer rows, cache, and
   token-usage events for one node/iteration.
2. Keep the default human view compact: latest attempt expanded, older attempts
   summarized unless `--attempts` is set.
3. Derive duration and cost from timestamps and token usage rather than assuming they
   already exist as stored columns.
4. Add `--iteration` resolution rules for looped nodes and a clear default of
   "latest iteration".
5. Define a stable `--json` schema so scripts can rely on field names.
6. Truncate large tool/output payloads in human mode while keeping full payloads in
   JSON mode.
7. Preserve backwards compatibility for callers that currently use `smithers node`
   as a thin DB dump by making enrichment additive.

## Verification requirements

### E2E tests

1. **Basic enriched output** — Run a workflow with a single task. Run
   `smithers node <nodeId> -r <runId>`. Assert output includes: node ID, status,
   duration, attempt count.

2. **Retry chain** — Task fails twice then succeeds (3 attempts). Assert output shows
   all 3 attempts with individual errors for attempts 1-2 and success for attempt 3.

3. **Tool calls shown** — Task invokes 2 tools (e.g., web-search, read-file). Assert
   tool names, durations, and status appear in output.

4. **Token usage** — Task with an agent that reports tokens. Assert "Tokens: X in / Y
   out" line in output.

5. **Scorer results** — Task with a scorer attached. Assert scorer name and score
   appear in output.

6. **Validated output** — Task with Zod schema output. Assert validated output JSON is
   shown.

7. **--json output** — `smithers node <id> -r <runId> --json`. Assert valid JSON with
   fields: `node`, `attempts[]`, `toolCalls[]`, `tokenUsage`, `scorers[]`, `output`.

8. **--attempts flag** — Assert all attempts are expanded (including tool calls per
   attempt) when flag is set.

9. **--tools flag** — Assert tool call inputs and outputs are expanded (not just name
   and duration).

10. **Node with no attempts** — Node in "pending" state. Assert output shows
    "Status: pending, 0 attempts" without error.

### Corner cases

11. **Node with 50 attempts** — Assert output doesn't explode. Default view shows
    latest attempt, summarizes prior 49 as "49 prior attempts (47 failed, 2 cancelled)".

12. **Tool call with large output** — Tool output is 100KB. In non-JSON mode, truncate
    to first 1KB with "... (truncated, use --json for full output)".

13. **Non-existent node** — `smithers node bad-node -r <runId>`. Assert
    "Node not found" error.

14. **Node across iterations** — Node inside a Loop with 5 iterations. Default shows
    latest iteration. `--iteration 2` shows iteration 2 specifically.

### Size limits

15. **Max tool output display**: 1KB in human mode, unlimited in `--json`.
16. **Max validated output display**: 10KB in human mode, unlimited in `--json`.

## Observability

No new events or metrics needed — this enriches a read-only CLI command using
existing data.

### Logging
- `Effect.withLogSpan("cli:node-detail")`
- Annotate with `{ runId, nodeId, iteration, attemptCount, toolCallCount }`

## Codebase context

### Smithers files
- `src/cli/index.ts:2697-2730` — Existing `node` command. This is the code to
  enrich. Currently returns raw `adapter.getNode()` result.
- `src/db/adapter.ts` — `getNode()`, `listAttempts()` (or equivalent): query methods
  needed. May need to add `listAttemptsByNode(runId, nodeId, iteration)`.
- `src/db/internal-schema.ts:55-70` — `_smithers_attempts` table: has `state`,
  `startedAtMs`, `finishedAtMs`, `responseText`, `metaJson`.
- `src/db/internal-schema.ts:75-95` — `_smithers_tool_calls` table: has `seq`, `name`,
  `inputJson`, `outputJson`, `startedAtMs`, `finishedAtMs`, `status`.
- `src/SmithersEvent.ts` — `TokenUsageReported` event: has `inputTokens`,
  `outputTokens`, `model`, `agent`. Query from `_smithers_events` filtered by nodeId.
- `src/db/internal-schema.ts` — `_smithers_scorers` table (or in `src/scorers/schema.ts`):
  scorer results per node.
- `src/cli/index.ts:1937-2028` — `inspect` command: reference for how to aggregate
  multiple DB queries into structured CLI output with CTA commands.

## Effect.ts architecture

### Boundary rule

All internal code MUST stay in Effect. Never call `runPromise()` or `runSync()` inside
internal modules. The only places allowed to break out of Effect into promises are:

- **CLI command handlers** — the outermost `run(c)` function in `src/cli/index.ts`
- **HTTP route handlers** — the outermost handler in `src/server/index.ts`
- **JSX component boundaries** — React/Solid components that call into Effect services
- **Test entry points** — `Effect.runPromise` in test files

Everything else — DB queries, engine logic, transport calls, validation, metrics,
logging — must compose as `Effect<A, E, R>` and flow through the Effect pipeline.
Do not wrap Effect code in `runPromise()` to get a Promise, then re-wrap that Promise
in `Effect.tryPromise()`. Keep the Effect chain unbroken.

**Rule:** ALL internal code must use Effect.ts. Only user-facing API boundaries (JSX components, React GUI) are exempt.

### Packages

- **`effect`** core — `Effect.gen`, `Effect.all`, `Effect.map`, `Effect.annotateLogs`, `Effect.withLogSpan`

No `@effect/workflow` or `@effect/cluster` needed — this is a read-only aggregation pipeline using Effect core.

### Key mapping

The multi-table aggregation (attempts + tool calls + events + scorers + cache) should be an Effect pipeline using `Effect.all` for parallel queries, then `Effect.map` to combine results:

```typescript
import { Effect } from "effect"

// Parallel query aggregation for node detail
const aggregateNodeDetail = (params: {
  runId: string
  nodeId: string
  iteration?: number
}): Effect.Effect<EnrichedNodeDetail, NodeDetailError> =>
  Effect.gen(function*() {
    yield* Effect.annotateLogs({ runId: params.runId, nodeId: params.nodeId })
    yield* Effect.withLogSpan("cli:node-detail")(
      Effect.gen(function*() {
        // Parallel queries for all data sources
        const [node, attempts, toolCalls, tokenEvents, scorers, cache] =
          yield* Effect.all([
            queryNode(params.runId, params.nodeId, params.iteration),
            queryAttemptsByNode(params.runId, params.nodeId, params.iteration),
            queryToolCallsByNode(params.runId, params.nodeId, params.iteration),
            queryTokenUsageEvents(params.runId, params.nodeId),
            queryScorers(params.runId, params.nodeId, params.iteration),
            queryCachedOutput(params.runId, params.nodeId, params.iteration),
          ])

        yield* Effect.annotateLogs({
          iteration: params.iteration,
          attemptCount: attempts.length,
          toolCallCount: toolCalls.length,
        })

        // Combine results into enriched view
        return yield* Effect.map(
          Effect.succeed({ node, attempts, toolCalls, tokenEvents, scorers, cache }),
          (data) => ({
            node: data.node,
            status: data.node.state,
            duration: computeDuration(data.attempts),
            attempts: data.attempts.map((a) => ({
              ...a,
              toolCalls: data.toolCalls.filter((tc) => tc.attemptId === a.id),
              tokenUsage: computeTokenUsage(data.tokenEvents, a.id),
            })),
            scorers: data.scorers,
            validatedOutput: data.cache?.payloadJson ?? null,
            totalCost: computeCost(data.tokenEvents),
          })
        )
      })
    )
  })
```

### Effect patterns to apply

- `Effect.all([...queries])` for parallel data fetching (attempts + tool calls + events + scorers + cache in one shot)
- `Effect.map` to transform and combine the parallel query results into the enriched `EnrichedNodeDetail` structure
- `Effect.withLogSpan("cli:node-detail")` wrapping the entire aggregation
- `Effect.annotateLogs({ runId, nodeId, iteration, attemptCount, toolCallCount })` for observability
- Pure computation after the queries — no DB writes, no side effects

### Smithers Effect patterns to follow

- `src/effect/runtime.ts` — Use the custom runtime layer for query execution
- `src/effect/logging.ts` — Annotate with `{ runId, nodeId, iteration, attemptCount, toolCallCount }`
- `src/effect/interop.ts` — Use `fromPromise()` to bridge existing adapter query methods into Effect
- Follow the existing `Effect.gen` + `Effect.annotateLogs` + `Effect.withLogSpan` patterns used throughout the engine

### Reference files

- No `@effect/workflow` or `@effect/cluster` reference needed for this ticket
- Follow the patterns in `src/effect/runtime.ts` for Effect execution context
- Follow the patterns in `src/db/adapter.ts` for the query methods (`getNode()`, `listAttempts()`, etc.) to wrap in Effect
