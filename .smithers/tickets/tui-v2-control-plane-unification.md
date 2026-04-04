# Make the chat control plane real: TUI v2 and shared control-plane services

## Problem

Smithers' TUI story is internally inconsistent:

- `docs/guides/tui.mdx` and the TUI v2 product docs describe `smithers tui` as a
  chat-first control plane.
- The live `smithers tui` command in `src/cli/index.ts` still launches the legacy
  dashboard from `src/cli/tui/app.tsx`.
- TUI v2 exists in `src/cli/tui-v2/`, but it is not the default entrypoint.
- `src/cli/tui-v2/broker/SmithersService.ts` still shells out to
  `bun run src/cli/index.ts ask ...` and `bun run src/cli/index.ts up ...`.
- The CLI docs mention `smithers tui --attach` and `--broker-only`, but those
  options are not registered by the real command implementation.

The result is product drift and a fake service boundary. The broker is not yet a
shared control plane; it is a shell wrapper around the CLI.

## Proposal

Promote TUI v2 from design branch to the real control-plane path, and replace CLI
shell-outs with shared services.

### Shared service layer

Introduce a real `SmithersControlPlaneService` that owns:

- workflow discovery
- workflow launch
- agent turn start/stream
- run polling
- approvals
- event streaming
- persistence/reconnect hooks

This service should be callable from:

- `smithers ask`
- `smithers tui`
- the TUI broker
- future IDE integrations

It should not require spawning `bun run src/cli/index.ts ...` from within the
same process tree.

### TUI defaulting plan

Choose one of these paths and make the docs match immediately:

1. Flip `smithers tui` to v2 and keep `--legacy` as an escape hatch.
2. Add explicit `smithers tui --v2` first, document that as the supported path,
   and only flip the default once parity is good enough.

Do not keep shipping chat-first docs while the default command launches the old
dashboard.

### Broker lifecycle

If `--attach` and `--broker-only` are real product goals, implement a broker
transport and process model. If they are not shipping yet, remove them from docs.

## Rollout phases

### Phase 1: Shared control-plane services

- Extract launch/ask/run-monitoring logic into reusable services.
- Update TUI v2 broker to call those services directly.

### Phase 2: Honest CLI and docs

- Add `smithers tui --v2` or flip the default.
- Add `--legacy` only if needed.
- Make docs describe the actual entrypoint and flags.

### Phase 3: Broker transport

- Implement `--attach` and `--broker-only` for real, or delete those docs.
- Persist workspace state and reconnect behavior across broker restarts.

## Additional steps

1. Keep `SmithersService` as a thin adapter only if it delegates into real
   services; do not let it remain a shell runner.
2. Reuse the same run-launch contract from the semantic MCP layer.
3. Add a clear version gate in the TUI startup banner so operators know whether
   they are in legacy or v2 mode.
4. Move any remaining launch-time logic out of React components and into broker
   services.
5. Make the TUI docs derive from the actually shipped keymap and flags, not the
   product design docs alone.

## Verification requirements

### Integration and PTY tests

1. **TUI v2 launches through the real entrypoint** - `smithers tui --v2` or
   `smithers tui` starts the v2 shell, not the legacy dashboard.
2. **Workflow launch does not shell out** - Broker workflow launch path calls the
   shared service directly; test by stubbing the service and asserting no child
   process spawn happens.
3. **Assistant turn does not shell out** - Broker ask path uses the shared
   service directly.
4. **Legacy escape hatch works** - If `--legacy` exists, it still launches the
   old TUI cleanly.
5. **Docs parity** - CLI docs only mention TUI flags that the real command
   exposes.
6. **Reconnect** - Restart the broker/service and recover workspaces and linked
   runs from persisted state.
7. **Approvals flow in v2** - Pending approvals are visible and actionable in the
   v2 UI.

### Corner cases

8. **No database available** - TUI still opens and explains that no workspace DB
   was found.
9. **Detached run started elsewhere** - Broker discovers and renders it without
   restarting the TUI.
10. **Service error propagation** - Launch or ask failures surface as user-visible
    feed entries, not unhandled exceptions.

## Observability

### New events

- `TuiBrokerStarted { mode, timestampMs }`
- `TuiBrokerRecoveredWorkspace { workspaceCount, timestampMs }`
- `TuiControlPlaneCall { operation, latencyMs, timestampMs }`
- `TuiControlPlaneCallFailed { operation, error, timestampMs }`

### New metrics

- `smithers.tui.broker_start_total`
- `smithers.tui.workspace_restore_total`
- `smithers.tui.control_plane_call_ms{operation}`
- `smithers.tui.control_plane_call_failures_total{operation}`

### Logging

- `Effect.withLogSpan("tui:broker")`
- `Effect.withLogSpan("tui:control-plane-call")`
- Annotate with `{ operation, workspaceId, runId }`

## Codebase context

### Smithers files

- `src/cli/index.ts` - current `tui` command still launches the legacy app
- `src/cli/tui/app.tsx` - current dashboard-first UI
- `src/cli/tui-v2/index.ts` - v2 entrypoint that is not yet wired as default
- `src/cli/tui-v2/broker/SmithersService.ts` - currently shells out to `ask` and
  `up`
- `src/cli/tui-v2/broker/Broker.ts` - should depend on real services, not child
  processes
- `docs/guides/tui.mdx` - current product-facing chat-first docs
- `docs/guides/smithers-tui-v2-*.md` - product/design documents that should align
  with the shipped path

## Effect.ts architecture

The shared control-plane services should be Effect-based. Do not replace one kind
of shelling-out with a pile of ad hoc promises inside the broker.
