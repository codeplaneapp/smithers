# Durable human interaction tools

## Problem

Smithers already has durable human-in-the-loop primitives, but they are too
fragmented and too hidden:

- `src/components/HumanTask.ts` piggybacks on approval records and stores human
  JSON in the approval `note` field.
- `approve` and `deny` are the only general operator actions exposed today.
- PI already has a useful prototype for interactive requests through
  `extension_ui_request` methods like `select`, `confirm`, `input`, and `editor`,
  but that is PI-specific and not part of a Smithers-wide contract.
- There is no agent-facing tool layer for "ask a human", "confirm this action",
  "pick one option", or "provide structured JSON".

That means human interaction is durable in the engine, but not first-class in the
tooling layer.

## Proposal

Add a generalized durable human request subsystem and expose it through explicit
agent-facing tools:

- `human_ask`
- `human_confirm`
- `human_select`
- `human_request_json`

### Shared request model

Introduce a generalized request record instead of overloading approval notes:

```sql
CREATE TABLE _smithers_human_requests (
  request_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  iteration INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL,            -- ask | confirm | select | json
  status TEXT NOT NULL,          -- pending | answered | cancelled | expired
  prompt TEXT NOT NULL,
  schema_json TEXT,
  options_json TEXT,
  response_json TEXT,
  requested_at_ms INTEGER NOT NULL,
  answered_at_ms INTEGER,
  answered_by TEXT,
  timeout_at_ms INTEGER
);
```

`<HumanTask>` then becomes a convenience wrapper over `human_request_json`.

### Tool contract

```ts
await runtime.human.requestJson({
  prompt: "Enter deployment metadata",
  schema,
  timeoutMs: 10 * 60 * 1000,
});
```

Equivalent agent-facing MCP tools:

- `human_request_json({ runId, nodeId, prompt, schema, timeoutMs })`
- `human_confirm({ runId, nodeId, prompt, timeoutMs })`
- `human_select({ runId, nodeId, prompt, options, multi, timeoutMs })`
- `human_ask({ runId, nodeId, prompt, placeholder, timeoutMs })`

### UI and CLI flow

Add real operator commands:

- `smithers human inbox`
- `smithers human answer <request-id> --value ...`
- `smithers human cancel <request-id>`

The TUI and future IDE tools should surface the same inbox and answer flows.

### Compatibility strategy

Phase 1 can keep run status on `waiting-approval` for compatibility if needed.
Once the UI is ready, Smithers can add a dedicated `waiting-human` display state
without blocking the subsystem.

## Rollout phases

### Phase 1: Request persistence and CLI

- Add `_smithers_human_requests`.
- Implement CLI inbox/answer/cancel flows.
- Make `<HumanTask>` read from the new request table.

### Phase 2: Agent-facing tools and runtime API

- Add runtime helpers and MCP tools.
- Map PI UI requests onto the same generalized request/response pipeline.

### Phase 3: TUI and IDE integration

- Surface pending human requests in TUI v2.
- Allow IDE sessions to answer via the IDE tool namespace.

## Additional steps

1. Preserve `approve`/`deny` for approval gates; do not overload them to mean
   every human interaction forever.
2. Add schema validation at answer time for `human_request_json`.
3. Support retries and correction loops for invalid JSON answers.
4. Record exactly which agent and node asked the question.
5. Support cancellation, expiration, and resume-after-crash semantics.
6. Keep PI's `select`, `confirm`, `input`, and `editor` methods as adapter-level
   transports that feed the generalized Smithers request model.

## Verification requirements

### End-to-end tests

1. **`human_ask` round trip** - Create a text prompt, answer it, and assert the
   response is persisted and returned to the workflow.
2. **`human_confirm` round trip** - Request a confirmation and assert true/false
   is durable across process restarts.
3. **`human_select` with options** - Request a selection from a list and assert
   the chosen value is returned.
4. **`human_request_json` validation** - Invalid JSON answer is rejected with a
   clear validation error; a corrected answer succeeds.
5. **`HumanTask` migration path** - Existing `<HumanTask>` workflows still work
   when backed by the new request subsystem.
6. **Crash recovery** - Pending human requests survive process restart and remain
   answerable.
7. **CLI inbox** - `smithers human inbox` lists pending requests with prompt,
   kind, run, and age.

### Corner cases

8. **Timeout expiry** - Request expires cleanly and the workflow follows the
   configured timeout behavior.
9. **Cancellation** - Cancelled request cannot be answered later.
10. **Multiple concurrent requests** - Several requests across different runs stay
    isolated.
11. **Large JSON answer** - Accept up to a defined limit and reject above it with
    a clear error.

## Observability

### New events

- `HumanRequestCreated { requestId, runId, nodeId, kind, timestampMs }`
- `HumanRequestAnswered { requestId, answeredBy, timestampMs }`
- `HumanRequestValidationFailed { requestId, error, timestampMs }`
- `HumanRequestExpired { requestId, timestampMs }`

### New metrics

- `smithers.human.requests_total{kind}`
- `smithers.human.pending_requests`
- `smithers.human.answer_latency_ms`
- `smithers.human.validation_failures_total`
- `smithers.human.expired_total`

### Logging

- `Effect.withLogSpan("human:create-request")`
- `Effect.withLogSpan("human:answer-request")`
- Annotate with `{ requestId, runId, nodeId, kind }`

## Codebase context

### Smithers files

- `src/components/HumanTask.ts` - current wrapper over approvals and approval note
  JSON
- `src/engine/approvals.ts` - current durable approval resolution path
- `src/agents/BaseCliAgent.ts` - PI extension UI request handling already supports
  `select`, `confirm`, `input`, and `editor`
- `docs/components/human-task.mdx` - current user-facing behavior
- `docs/components/wait-for-event.mdx` - useful comparison for durable waiting and
  resume behavior

## Effect.ts architecture

Human request persistence, validation, and delivery should stay in Effect and
reuse existing transactional DB patterns. Only CLI and UI boundaries should leave
Effect.
