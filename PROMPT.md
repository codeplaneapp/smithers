# Implement a minimal Smithers Monitor inside the Codex GUI

Work only in this checkout (`/Users/williamcory/smithers4`) on its own jj change/bookmark. Do not edit `/Users/williamcory/smithers`, `../multi`, or another checkout. Preserve the clean parent and inspect `jj st`/`jj diff` throughout.

## Objective

Extend the existing Smithers Codex plugin with a real MCP Apps UI that renders a minimal, live Smithers Monitor inside the ChatGPT desktop app's Codex surface. The user should be able to ask Codex to “show the Smithers monitor,” receive an inline monitor component, and expand it fullscreen without opening an external browser.

This is not the existing `.smithers/ui/<workflow>.tsx` system. It is one plugin-owned operator UI over all runs in the current workspace.

## Product decision

Build a native MCP Apps widget. Do not embed the gateway's `/monitor` page in a nested iframe and do not let the widget contact the local gateway directly.

The widget must use the MCP Apps bridge (`tools/call`) to invoke Smithers MCP tools. The MCP server remains the only component that reads the workspace database or reaches Smithers internals. This gives us one narrow transport through OpenAI Secure MCP Tunnel and prevents gateway URLs or bearer tokens from entering widget data, HTML, logs, or model-visible content.

Why:

- ChatGPT widgets already run in a sandboxed iframe and can request fullscreen.
- Nested iframes require `frameDomains` and face stricter plugin review.
- Secure MCP Tunnel forwards MCP traffic; it is not a general browser-to-localhost proxy.
- The current Monitor assumes same-origin `/v1/api/*`, SSE, RPC, and WebSocket routes. Loading it from the Apps sandbox would otherwise create CSP, CORS, HTTPS/mixed-content, dynamic-origin, and credential problems.

Official contracts to verify again before coding:

- Apps UI and MCP Apps bridge: https://developers.openai.com/apps-sdk/build/chatgpt-ui
- MCP server/resource/tool setup: https://developers.openai.com/apps-sdk/build/mcp-server
- Developer-mode connection: https://developers.openai.com/apps-sdk/deploy/connect-chatgpt
- Testing: https://developers.openai.com/apps-sdk/deploy/testing
- Secure MCP Tunnel: https://developers.openai.com/blog/connect-private-mcp-servers-to-openai-products
- Codex plugin/app packaging: current Codex manual sections “Build an app,” “Build plugins,” and “Plugin structure.”

Do not rely on remembered Apps SDK field names. Confirm the installed/current SDK API and the official docs before implementing resource metadata, MIME type, transport lifecycle, CSP, and `.app.json` wiring.

## Existing implementation to preserve

- `codex-plugin/` already packages the Smithers skill, SessionStart hook, and stdio MCP server. It has no `.app.json` and no `apps` manifest entry.
- `apps/cli/src/mcp/mcp-mode.js` serves semantic MCP tools over stdio.
- `apps/cli/src/mcp/semantic-server.js` registers the tool definitions from `semantic-tools.js`.
- Existing read tools already cover the MVP: `list_runs`, `get_run`, `get_run_events`, `get_node_detail`, and `list_pending_approvals`.
- `apps/cli/src/monitor-ui/monitor.tsx` is a large gateway-backed browser Monitor. `monitorModel.ts` and `monitorShell.tsx` contain reusable pure models/view pieces.
- `../multi` proves `/monitor?embed=1` can be framed by a trusted same-origin proxy, but that architecture is not suitable for the Apps sandbox. Treat it only as UX/reference evidence.

Keep stdio MCP behavior and the browser `/monitor` route backward compatible.

## MVP scope

The Codex widget should show:

1. Connection/loading/error state.
2. Recent runs with workflow, status, age, and live/running indication.
3. Search plus status/workflow filtering.
4. A selected run summary and its execution steps/tree from `get_run`.
5. Pending approvals, read-only in the first cut.
6. Incrementally loaded event history from `get_run_events`.
7. Selected-node detail from `get_node_detail`.
8. Manual refresh and bounded automatic refresh while the widget is visible.
9. A fullscreen button using feature-detected `window.openai.requestDisplayMode({ mode: "fullscreen" })`.

Deliberately exclude from the MVP:

- Launching, cancelling, retrying, approving, denying, rewinding, or other writes.
- Metrics, crons, memory, scores, diffs, browser viewer, PTY hijack, terminal, and per-workflow custom UIs.
- Direct REST, SSE, or WebSocket access from the widget.
- Nested iframes or broad CSP domains.
- A hosted Smithers control plane.

The UI should be recognizably Smithers Monitor, but smaller than the full browser Monitor. Reuse `smithers-orchestrator/ui`, pure helpers from `monitorModel.ts`, and suitable `monitorShell.tsx` components. Extract shared pure view/style pieces when doing so reduces duplication; do not make the Apps widget depend on gateway-react hooks.

## Architecture

### 1. Share the MCP server factory

Keep one semantic tool definition source. Refactor only enough for both stdio and Streamable HTTP transports to instantiate the same server safely.

Add Apps UI registration behind an explicit option so the normal stdio MCP surface does not gain a confusing render-only tool. The Apps-enabled server registers:

- A model-visible, read-only render tool named `show_monitor` (final name may change only if current metadata guidance strongly favors another name).
- A versioned resource URI such as `ui://smithers/monitor-v1.html` with `text/html;profile=mcp-app` (use the SDK constant if available).
- Both standard `_meta.ui.resourceUri` and ChatGPT compatibility metadata required by the current docs.

`show_monitor` accepts an optional `runId`. Its `structuredContent` must remain small and model-readable. Never return the DB path, filesystem paths, gateway URL, gateway bearer, environment values, or large event payloads in `_meta` merely for convenience.

The widget should call the existing read-only semantic tools directly through `tools/call`. Do not add a parallel REST API. Add one app-only aggregate tool only if measured request overhead makes the existing composition unusable; if added, implement it from shared query functions rather than duplicating run-state logic.

### 2. Add a loopback Streamable HTTP MCP command

Add a focused CLI entrypoint, preferably `smithers mcp serve`, that serves the Apps-enabled semantic MCP server at `/mcp` using the SDK's supported Streamable HTTP server transport.

Requirements:

- Default bind: `127.0.0.1`, never `0.0.0.0`.
- Stable documented default port, with `--port 0` available for tests.
- Print the actual local `/mcp` URL as structured CLI output.
- Apply request body, header, connection, and session bounds.
- Correctly create/close transports and reject malformed or stale session IDs.
- Clean shutdown on SIGINT/SIGTERM with no orphan listener.
- Refuse a non-loopback bind unless an explicit auth token is configured; do not invent permissive CORS defaults.
- Keep `bunx smithers-orchestrator --mcp` stdio behavior byte-for-byte compatible.

Use `@modelcontextprotocol/sdk`'s current transport. Add `@modelcontextprotocol/ext-apps` only if the current official server/UI helpers materially reduce protocol mistakes. Any dependency change must update `apps/cli/package.json`, `pnpm-lock.yaml`, and `bun.lock` together.

### 3. Build the widget as a shipped asset

Create a small React entry under a clearly owned location such as `apps/cli/src/codex-app/` or `apps/cli/src/mcp-app/`. Keep server registration, bridge client, pure state model, and React view separate.

The widget must:

- Initialize the standard MCP Apps bridge and listen for tool input/result lifecycle notifications.
- Treat absent initial tool input as normal.
- Use app-initiated `tools/call` for read tools.
- Fetch the run list first, select the requested run when present, then fetch selected-run detail/events/approvals.
- Load events incrementally with `afterSeq`; cap retained rows and payload rendering.
- Poll only while `document.visibilityState === "visible"`; stop timers on unmount; use one in-flight refresh at a time; back off after failures.
- Escape/render all tool data as untrusted input.
- Feature-detect ChatGPT-only APIs and remain usable inline when fullscreen is unavailable.
- Show a useful stale/error state without infinite retry loops.
- Inline or package its JS/CSS so the resource needs no external resource domains. Prefer an empty network CSP because data flows through `tools/call`.

Extend `apps/cli/scripts/build-ui.mjs` (or introduce one narrowly integrated sibling build step) so prepack deterministically emits the widget asset into the already published `ui-dist/` directory. Use a versioned resource/bundle name for cache invalidation. Add a drift test proving the packaged asset is generated and included.

Do not build the widget dynamically on every MCP request.

### 4. Plugin packaging

After the local HTTP server and widget pass automated tests:

1. Start `smithers mcp serve` in this checkout.
2. Connect it using OpenAI Secure MCP Tunnel. Use ngrok/Cloudflare Tunnel only as a development fallback and never document a public unauthenticated bind as the preferred path.
3. Create a ChatGPT developer-mode app pointing at the tunneled `/mcp` endpoint.
4. Record the generated `plugin_asdk_app...`/`asdk_app...` identifier.
5. Add `codex-plugin/.app.json` with that real identifier and add `"apps": "./.app.json"` to `codex-plugin/.codex-plugin/plugin.json`.
6. Verify the local marketplace installs the plugin and resolves both its app and its existing stdio MCP server.

The app ID is an external-state gate. Do not commit a fake ID. If an actual developer app cannot be created in the implementation environment, finish all code/tests, add a clearly named `.app.json.example`, document the exact remaining manual step, and leave the manifest internally valid rather than pointing at a placeholder.

Update the plugin description: Codex GUI users get the minimal embedded Monitor; CLI/IDE or unsupported surfaces retain MCP tools and the existing external-browser UI fallback. Do not claim all Codex surfaces render the widget until tested.

## Implementation sequence

### Phase A — protocol spike

1. Confirm current official metadata/MIME/transport requirements.
2. Add a minimal Apps-enabled MCP server/resource and `show_monitor` returning a static “Smithers Monitor” component.
3. Serve it through real loopback Streamable HTTP.
4. Validate resource listing and tool invocation with MCP Inspector.
5. Validate the static component in ChatGPT developer mode and the desktop Codex surface, including fullscreen.

Treat Phase A as a hard feasibility gate. If the widget renders in ChatGPT but not in the Codex surface, capture the exact product/version/account behavior and do not disguise a ChatGPT-only integration as Codex support.

### Phase B — minimal live monitor

1. Implement the bridge client and bounded refresh state machine.
2. Compose existing semantic read tools into the MVP views.
3. Reuse/extract Smithers Monitor view primitives and styles.
4. Add requested-run selection, incremental events, node selection, filters, visibility-aware polling, and fullscreen.
5. Ensure no direct network access or secret-bearing output exists.

### Phase C — packaging and distribution wiring

1. Integrate deterministic widget build/prepack output.
2. Add the real `.app.json` binding when available.
3. Update marketplace/plugin validation tests.
4. Update Codex plugin README, Codex integration docs, MCP server docs, CLI generated reference, changelog, and generated `llms` bundles as required by repository checks.

### Phase D — real validation

1. Run MCP Inspector against the real HTTP server.
2. Run a real Smithers workflow and watch its state change inside the widget.
3. Kill/restart the MCP HTTP server and verify recovery is bounded and understandable.
4. Test two workspaces separately and prove the server reads only the cwd-selected workspace.
5. Install the plugin from this checkout's marketplace into the current ChatGPT desktop app/Codex GUI and capture the exact tested versions and screenshots/log evidence outside generated product assets.

## Tests

Follow the repository invariant: product and E2E behavior uses real backends, not mocked behavior.

Add at least:

- Unit tests for Apps tool/resource descriptors, annotations, resource URI, MIME type, small/model-safe output, and no secret fields.
- Unit tests for bridge refresh state: initial load, requested run, incremental `afterSeq`, event cap, failure backoff, hidden-tab pause, unmount cleanup, stale response suppression.
- Real HTTP MCP integration tests using an MCP client against an actual loopback listener: initialize, list tools/resources, call `show_monitor`, fetch the resource, call the existing run tools, session cleanup, malformed requests, and shutdown.
- A real DB test proving two MCP calls observe a run-state transition.
- A Playwright E2E host harness that loads the actual returned MCP App HTML and routes `tools/call` to the actual MCP server. It must verify run list, selection, execution detail, incremental event update, error UI, and fullscreen feature detection. The harness may emulate the host bridge, but it must not mock Smithers data or handlers.
- Regression tests proving stdio MCP tool inventory/behavior is unchanged and the existing `/monitor` route still renders.
- Plugin manifest/marketplace tests covering `.app.json` when the real app binding exists.
- Package-content/drift tests proving the built widget ships in the npm artifact.

Run the narrow suites first, then:

```sh
pnpm -C apps/cli test
pnpm -C apps/cli typecheck
pnpm typecheck
pnpm lint
pnpm docs:llms          # after docs changes
pnpm test
```

If dependencies change, also verify frozen installs or the repository's lockfile consistency checks for both package managers.

## Security requirements

- Never expose a gateway bearer or DB path to the widget/model.
- Never place auth material in query strings, resource URIs, `structuredContent`, HTML, or logs.
- Bind locally by default and fail closed for remote binds.
- Use read-only annotations for every MVP tool; do not smuggle writes through a read tool.
- Keep tool results bounded. Cap run count, event count, payload depth/size, and polling frequency.
- Validate `runId`, `nodeId`, pagination, and event cursor inputs through schemas.
- Do not use wildcard CSP domains, wildcard `postMessage` targets where the protocol provides a validated channel, or nested frames.
- Do not make Secure MCP Tunnel a general gateway/REST tunnel. Only the MCP server is exposed.
- Preserve workspace isolation: the HTTP server's workspace is fixed at startup and cannot be switched by widget input.

## Acceptance criteria

The work is complete only when:

- In the current ChatGPT desktop app's Codex GUI, “show the Smithers monitor” invokes `show_monitor` and renders the widget inline.
- The same widget can enter fullscreen through the host API.
- It displays real recent runs, selected-run execution state, approvals, events, and node detail from this checkout.
- A live run update appears without reopening the component.
- The browser does not open as part of this flow.
- Browser devtools/network evidence shows the widget does not call the local gateway and receives no gateway token.
- The local MCP server is reachable through Secure MCP Tunnel (or a documented temporary development tunnel), while binding only to loopback.
- Existing Codex plugin skill/hook/stdio MCP behavior and the standalone `/monitor` UI remain working.
- Automated tests and repository gates pass.
- Docs state the tested surface honestly and explain the fallback on surfaces without Apps rendering.

## Deferred follow-ups

Do not expand scope during the MVP. Record follow-up tickets for:

- Approval/cancel/retry actions with correct ChatGPT confirmation semantics.
- MCP notifications or another push mechanism to replace polling.
- More full-Monitor panels.
- Published-plugin review and stable app metadata snapshots.
- Mobile layout and non-Codex ChatGPT surfaces.
- A hosted/team gateway architecture, if desired later.

Finish with a concise implementation report: architecture delivered, files/packages changed, exact real-GUI validation performed, security evidence, tests run, remaining external app-review/tunnel constraints, and `jj diff --stat`.
