# `smithers ui` — CLI-to-GUI deep linking

## Revision Summary

- Reworked the ticket so it matches the current tab-state GUI instead of assuming a
  route-driven app already exists.
- Added a phased rollout: stable URL/query contract first, pretty routes later if a
  router is introduced.
- Clarified that server detection/startup must align with the actual GUI hosting
  mode, not a hypothetical standalone `smithers serve`.
- Added explicit GUI hydration work so incoming URLs can open the right tab, run,
  node, or approvals view.

## Problem

There's no way to jump from the CLI to the GUI for a specific run, node, or approval.
Operators copy-paste run IDs between terminal and browser manually. Nomad's `nomad ui`
command is a well-proven pattern for bridging CLI and browser workflows.

## Proposal

Add a `smithers ui` command that opens the GUI host and deep-links to a specific
object when possible:

```
smithers ui                      # open GUI dashboard
smithers ui run <run-id>         # open run detail page
smithers ui node <run-id>/<nid>  # open node detail
smithers ui approvals            # open approvals queue
```

### Behavior

1. Resolve the configured GUI host and probe its health endpoint
2. If no GUI/API host is running, either start the supported host mode or emit a
   clear actionable error until a dedicated host command exists
3. Open the constructed URL with the system browser (`open` on macOS, `xdg-open` on
   Linux)
4. Print the URL to stdout so it's copy-pastable in remote/SSH sessions

### Addressing

Phase 1 should use a contract the current GUI can actually hydrate, for example:
- `/?tab=runs`
- `/?tab=runs&runId=:runId`
- `/?tab=runs&runId=:runId&nodeId=:nodeId`
- `/?tab=approvals`

If the GUI later adopts a router, it can additionally support pretty routes:
- `/runs`
- `/runs/:runId`
- `/runs/:runId/nodes/:nodeId`
- `/approvals`

## Additional Steps

1. Decide what process actually hosts the GUI/API for browser use.
2. Add parsing of query parameters or hash state in the GUI shell so URLs can select
   a tab/run/node/approval on load.
3. Add approvals as a first-class selectable surface in the GUI.
4. Keep printing the URL even when auto-open is skipped or fails.
5. Detect headless/SSH sessions and suppress `open`/`xdg-open` there.
6. Document the stable deep-link contract so CLI and GUI stay in sync.

## Implementation notes

- Use `Bun.spawn(["open", url])` or equivalent cross-platform opener
- Probe server with a fetch to `/health` or the configured port before deciding to
  auto-start
- Current GUI note: `gui/src/ui/App.tsx` is tab-state driven today, so URL-to-state
  hydration needs to be added before route-style deep links work

## Verification requirements

### E2E tests

1. **`smithers ui` prints URL** — Run `smithers ui`. Assert stdout contains a URL
   matching `http://localhost:<port>/runs`. (Don't assert browser opens in CI —
   assert the URL is printed.)

2. **`smithers ui run <id>`** — Assert URL contains `/runs/<id>`.

3. **`smithers ui node <runId>/<nodeId>`** — Assert URL contains
   `/runs/<runId>/nodes/<nodeId>`.

4. **`smithers ui approvals`** — Assert URL contains `/approvals`.

5. **Server auto-start** — No server running. Run `smithers ui`. Assert server is
   started in background (probe `/health` succeeds after command). Assert URL is
   printed.

6. **Host already running** — Start the supported GUI/API host first. Run
   `smithers ui`. Assert it detects the existing host (no second host spawned) and
   prints the URL on the same port.

7. **Non-existent run** — `smithers ui run bad-id`. Should still print the URL (the
   GUI handles 404, not the CLI). No CLI error.

### Corner cases

8. **Custom port** — Start the supported GUI/API host on port 9999, then run
   `smithers ui`. Assert URL uses port 9999.

9. **Remote/SSH session** — When no display is available (`DISPLAY` unset on Linux,
   or SSH without forwarding), assert URL is printed but no `open` command is
   attempted. No error.

10. **Server port conflict** — Port is occupied by another process. `smithers ui`
    auto-start fails. Assert clear error: "Port <port> is in use".

## Observability

No new events or metrics needed — this is a lightweight CLI command.

### Logging
- `Effect.withLogSpan("cli:ui")`
- Annotate with `{ target, url, serverAutoStarted: boolean }`

## Codebase context

### Smithers files
- `src/cli/index.ts:1296-1313` — `up` command with detach logic. `ui` auto-start
  server uses the same `spawn(..., { detached: true })` pattern.
- `src/server/index.ts` — HTTP server entry point. `ui` command probes this.
- `gui/src/ui/App.tsx` — Current tab-state GUI shell. Add URL/query hydration here
  before assuming pretty routes.
- `gui/src/ui/api/transport.ts` — GUI API transport; the server port is configured
  here.

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

- **`effect`** core — `Effect.gen`, `Effect.tryPromise`, `Effect.acquireRelease`, `Effect.annotateLogs`, `Effect.withLogSpan`

No `@effect/workflow` or `@effect/cluster` needed — this is a lightweight CLI command using Effect core.

### Key mapping

Server health probe should be `Effect.tryPromise`. Server auto-start should use `Effect.acquireRelease`. URL construction is pure (no Effect needed). Browser open is a boundary (`Effect.tryPromise(spawn("open", url))`):

```typescript
import { Effect } from "effect"

// Server health probe
const probeServerHealth = (port: number): Effect.Effect<boolean, never> =>
  Effect.tryPromise(() =>
    fetch(`http://localhost:${port}/health`)
  ).pipe(
    Effect.map((res) => res.ok),
    Effect.orElseSucceed(() => false)
  )

// Server auto-start with acquireRelease
const ensureServerRunning = (port: number) =>
  Effect.gen(function*() {
    const isHealthy = yield* probeServerHealth(port)
    if (isHealthy) {
      yield* Effect.logInfo("Server already running")
      return { autoStarted: false }
    }

    // Auto-start the server
    yield* Effect.acquireRelease(
      // Acquire: spawn server process
      Effect.tryPromise(() =>
        Bun.spawn(["bun", cliPath, "serve", "--port", String(port)], {
          detached: true,
          stdio: ["ignore", "ignore", "ignore"],
        })
      ),
      // Release: no-op (server keeps running detached)
      () => Effect.void
    )

    // Wait for server to become healthy
    yield* Effect.retry(
      probeServerHealth(port).pipe(
        Effect.filterOrFail((healthy) => healthy, () => "not ready")
      ),
      Schedule.spaced("500 millis").pipe(Schedule.compose(Schedule.recurs(10)))
    )

    return { autoStarted: true }
  })

// URL construction (pure — no Effect needed)
const buildUrl = (port: number, target: DeepLinkTarget): string => {
  const base = `http://localhost:${port}`
  switch (target._tag) {
    case "Dashboard": return `${base}/?tab=runs`
    case "Run": return `${base}/?tab=runs&runId=${target.runId}`
    case "Node": return `${base}/?tab=runs&runId=${target.runId}&nodeId=${target.nodeId}`
    case "Approvals": return `${base}/?tab=approvals`
  }
}

// Browser open (boundary — Effect.tryPromise wrapping spawn)
const openInBrowser = (url: string): Effect.Effect<void, never> =>
  Effect.tryPromise(() => {
    const cmd = process.platform === "darwin" ? "open" : "xdg-open"
    return Bun.spawn([cmd, url])
  }).pipe(
    Effect.catchAll(() =>
      Effect.logWarning("Could not open browser (headless/SSH session?)")
    )
  )
```

### Full command pipeline

```typescript
const uiCommand = (target: DeepLinkTarget, port: number) =>
  Effect.gen(function*() {
    yield* Effect.annotateLogs({ target: target._tag })
    yield* Effect.withLogSpan("cli:ui")(
      Effect.gen(function*() {
        const { autoStarted } = yield* ensureServerRunning(port)
        yield* Effect.annotateLogs({ serverAutoStarted: autoStarted })

        const url = buildUrl(port, target)

        // Always print URL (for SSH/headless sessions)
        yield* Effect.sync(() => console.log(url))

        // Try to open browser (boundary)
        yield* openInBrowser(url)
      })
    )
  })
```

### Effect patterns to apply

- `Effect.tryPromise` for server health probe (`fetch`) and browser open (`spawn`)
- `Effect.acquireRelease` for server auto-start lifecycle management
- `Effect.retry` with `Schedule` for waiting until the server is healthy after auto-start
- `Effect.filterOrFail` for health check assertions
- Pure URL construction (no Effect wrapping needed)
- `Effect.catchAll` for graceful browser-open failure in headless/SSH sessions

### Smithers Effect patterns to follow

- `src/effect/runtime.ts` — Use the custom runtime layer for command execution
- `src/effect/child-process.ts` — `spawnCaptureEffect()` for process spawning; reference for the browser open implementation
- `src/effect/logging.ts` — Annotate with `{ target, url, serverAutoStarted }`
- `src/effect/interop.ts` — Use `fromPromise()` pattern for bridging `fetch` and `spawn`

### Reference files

- No `@effect/workflow` or `@effect/cluster` reference needed for this ticket
- Follow the patterns in `src/effect/runtime.ts` for Effect execution context
- Follow the patterns in `src/effect/child-process.ts` for process spawning via Effect
