# IDE-specific tool namespace via `smithers-ctl`

## Problem

Smithers needs IDE-specific agent tools, but they should not be mixed into the
general orchestrator tool namespace.

The session contract already documents a native macOS IDE surface in `AGENTS.md`
through the `smithers-ctl` CLI:

- `smithers-ctl open`
- `smithers-ctl terminal`
- `smithers-ctl diff show`
- `smithers-ctl overlay`
- `smithers-ctl webview open`

There is also at least one existing call site in `src/cli/tui/components/RunDetailView.tsx`
that shells out to `smithers-ctl terminal`.

But there is no dedicated Smithers MCP namespace for IDE actions, no capability
check, and no contract test around the `smithers-ctl` bridge.

This checkout also does not currently contain `apps/desktop/`, so the work must
be contract-first and CLI-bridge-first rather than SwiftUI-code-first.

## Proposal

Expose a separate IDE tool namespace, backed by `smithers-ctl`, and keep it
separate from orchestrator tools.

### Namespace

Either a dedicated server name `smithers-ide` or a strict prefix:

- `smithers_ide_open_file`
- `smithers_ide_open_diff`
- `smithers_ide_show_overlay`
- `smithers_ide_run_terminal`
- `smithers_ide_ask_user`
- `smithers_ide_open_webview`

Do not mix these into the default orchestrator tool list.

### Tool mappings

```txt
open_file     -> smithers-ctl open <path> [+line[:col]]
open_diff     -> smithers-ctl diff show --content ...
show_overlay  -> smithers-ctl overlay --type ...
run_terminal  -> smithers-ctl terminal run <cmd>
ask_user      -> smithers-ctl overlay / future native prompt bridge
open_webview  -> smithers-ctl webview open <url>
```

### Availability detection

The IDE namespace should only register when:

- `smithers-ctl` is present
- the session is actually running inside a compatible IDE environment

Non-IDE shells should not expose dead tools.

### Dependency on human tools

`smithers_ide_ask_user` should integrate with the generalized human interaction
subsystem once that exists, but it can start as a thin transport shim.

## Rollout phases

### Phase 1: Contract tests and wrapper service

- Add a `SmithersIdeService` that shells out to `smithers-ctl`.
- Add fake-binary integration tests for every mapped command.

### Phase 2: IDE MCP namespace

- Register the IDE tool namespace when `smithers-ctl` is available.
- Keep it isolated from the orchestrator MCP surface.

### Phase 3: Human-tool integration

- Wire `ask_user` into the generalized human request flow.
- Surface richer answer types once native IDE support exists.

## Additional steps

1. Define structured return shapes for every `smithers-ctl` wrapper, including
   tab IDs, overlay IDs, and exit statuses.
2. Add timeouts and clear error mapping for missing binaries or failed commands.
3. Decide whether `run_terminal` should support a TTY/interactive mode or only
   fire-and-forget launches.
4. Add a capability probe command so `smithers ask` or TUI can decide whether IDE
   tools should be included.
5. Keep any future desktop-app-specific implementation behind the CLI contract so
   this repo does not have to vendor the macOS app just to test the bridge.

## Verification requirements

### Unit and integration tests

1. **Open file mapping** - Fake `smithers-ctl` receives the expected `open`
   arguments for path and line/column.
2. **Open diff mapping** - Wrapper passes unified diff content correctly.
3. **Overlay mapping** - Wrapper returns parsed overlay ID/result.
4. **Run terminal mapping** - Wrapper launches terminal commands with the correct
   cwd and command string.
5. **Webview mapping** - Wrapper returns the created tab ID.
6. **Namespace isolation** - IDE tools do not appear in the general orchestrator
   MCP surface when IDE mode is unavailable.
7. **Capability detection** - Missing `smithers-ctl` yields a clean unavailable
   status, not a crash.

### Corner cases

8. **Bad path or malformed diff** - Wrapper returns a structured error.
9. **IDE tool timeout** - Hung `smithers-ctl` invocations are killed and reported.
10. **Non-IDE shell** - Orchestrator tools remain available even when the IDE
    namespace is absent.

## Observability

### New events

- `IdeToolCalled { toolName, timestampMs }`
- `IdeToolFailed { toolName, error, timestampMs }`
- `IdeToolUnavailable { reason, timestampMs }`

### New metrics

- `smithers.ide.calls_total{tool}`
- `smithers.ide.failures_total{tool}`
- `smithers.ide.latency_ms{tool}`
- `smithers.ide.unavailable_total`

### Logging

- `Effect.withLogSpan("ide:tool-call")`
- Annotate with `{ toolName, available, cwd }`

## Codebase context

### Smithers files

- `AGENTS.md` - current `smithers-ctl` command contract
- `src/cli/tui/components/RunDetailView.tsx` - existing `smithers-ctl terminal`
  shell-out
- future MCP namespace registration should live alongside the existing CLI/MCP
  bootstrap layer

## Effect.ts architecture

The IDE wrapper service should be Effect-based and should encapsulate child
process spawning, timeout handling, and result parsing. Only the outer CLI/MCP
boundary should leave Effect.
