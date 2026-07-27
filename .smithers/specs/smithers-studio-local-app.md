# Smithers Studio: the open-source local app

Smithers Studio is the fully open-source local version of the Multi UI, built in this
repo as `apps/studio` (`@smithers-orchestrator/studio`). It is a desktop app: an
electrobun shell whose Bun main process hosts the entire backend locally and whose
webview runs the React frontend ported from `../multi`. It operates on local checkouts
of GitHub repos, runs agent work in sandboxes through the official Smithers sandbox
provider (Microsandbox), and has no jjhub/plue dependency of any kind.

Delivery order is fixed:

1. **Local-only version** (this spec). Everything runs on the user's machine.
2. Cloud support for the local version (later; out of scope here).
3. Web app (last; out of scope here).

React is the UI stack for every version. The GUI ships first; a TUI built on opentui
is developed in parallel on another branch and will reuse the logic layer, so the
GUI/TUI seam is a hard architectural requirement of this version even though only the
GUI ships from it.

## Hard requirements at boot

Studio refuses to run without both agent CLIs. The boot preflight uses
`detectAvailableAgents` from `@smithers-orchestrator/cli/agent-detection`:

- `claude` must be installed and usable (`hasBinary` and a credential signal).
- `codex` must be installed and usable.
- `git` must be on PATH (`vcsToolingStatus()` from `@smithers-orchestrator/vcs`).
- jj is NOT a user requirement: `packages/vcs` bundles per-platform jj binaries
  (`@smithers-orchestrator/jj-*`) resolved by `resolveJjBinary()`.

A failed preflight renders a full-screen diagnosis (which check failed, the exact
install/login command to fix it) and nothing else. There is no degraded anonymous
mode: unlike Multi, there is no cloud to be signed out of.

Microsandbox (`msb`) is required for sandboxed agent execution. When unavailable
(no hardware virtualization, msb not installed), Studio still boots and clearly
labels execution as "direct" (agents run as local processes in the jj workspace,
which is how Smithers runs everywhere today). Sandboxed execution is the default
whenever `msb doctor` passes.

## Architecture

Three layers, mirroring Multi's two-plane thesis (UI plane and Smithers plane) with
the Cloudflare Worker replaced by the electrobun main process.

### 1. Shell: electrobun

- electrobun pinned at `1.18.1` (the version Multi already pins; `bundleCEF: false`
  on all platforms, system webview).
- Main process (`src/main/`): starts services, opens one `BrowserWindow`
  (`views://main/index.html` packaged, Vite dev server URL in dev), and exposes a
  typed RPC bridge (`BrowserView.defineRPC`) for window control, native dialogs, and
  preflight status. Everything data-plane goes over local HTTP/WS, not the RPC
  bridge.
- The main process hosts `Bun.serve({ hostname: "127.0.0.1", port: 0 })` and serves
  the same-origin contract the Multi frontend already assumes:
  - `/v1/rpc` and WS streams: reverse proxy to the resolved workspace gateway.
  - `/workflows/*`, `/monitor*`, `/health`: proxied to the same gateway.
  - `/api/studio/*`: the local backend API (below).
  The webview points at this origin, so the frontend keeps Multi's "the origin is
  the credential boundary" shape with zero auth attached.
- Spike (PR 2, timeboxed): confirm WebSocket upgrade behavior under the electrobun
  runtime for the gateway WS proxy. Fallback: point the webview's gateway client
  directly at the gateway's own 127.0.0.1 port (CORS is local-only).

### 2. Local backend (services in the main process)

Replaces `src/worker.ts` (142 KB) and all of `src/smithersCloud/` (~60 modules).
Each service is a plain TypeScript module with one named export, colocated by
domain under `apps/studio/src/main/`:

- **preflight**: agent detection, vcs tooling status, msb doctor. Cached, re-probed
  on demand.
- **repos**: the registry of local checkouts. A repo is a path to a local git clone
  (colocated jj initialized on first open via bundled jj). Persisted in
  `~/.smithers/studio/repos.json`. Supplies the wire shapes Multi's repo surfaces
  expect (list, metadata, default branch). GitHub import is deleted: opening a repo
  means picking a local folder or `git clone` into a chosen directory.
- **workspaces**: replaces plue workspace VMs. A workspace = a jj workspace of the
  repo (created with the `workspaceAdd` retry pattern from `packages/vcs`) plus an
  execution seat. Execution seat is either a Microsandbox microVM (via
  `createMicrosandboxSandboxProvider`, the checkout bind-mounted read-write into
  `/workspace`) or a direct local process when msb is unavailable. Lifecycle:
  create, list, suspend (stop VM, keep workspace), resume, destroy.
- **gateway**: replaces `fetchPerRepoGateway` (the one hard swap identified in the
  port audit). Resolves the per-repo gateway by starting or attaching
  `smithers gateway` for that repo's workspace directory, and returns
  `{ baseUrl, token }` to the proxy layer. One gateway per repo, reference-counted.
- **vcs**: jj status/log/diff/bookmarks over the bundled binary, serving Multi's
  vcs/changes wire shapes from the local checkout.
- **files**: file tree, read/write drafts. Same wire contract Multi's
  `filesSource.ts` dispatch seam expects; the `src/local/localFsSource.ts` adapter
  in Multi proves the shape holds for byte-identical local serving.
- **terminal**: PTY sessions over WS into the workspace (direct) or the microVM
  (sandboxed).
- **agents**: agent seat configuration (model ids from the SOTA registry), quota
  surface via the usage package.

### 3. Frontend: the Multi port

Ported from `../multi` `src/`, keeping the architecture identical. Multi already has
the two seams that make this port mechanical rather than inventive:

- The **plugin boundary** (`src/plugins/MultiPlugin.ts`): the core app is fully
  local by design; jjhub arrives as one plugin (`smithersCloudPlugin`) that local
  mode disables. Studio ships a `studioLocalPlugin` contributing the bridges that
  bind repos/vcs/files stores to the local backend, and no cloud plugin at all.
- The **files dispatch seam** (`src/files/filesSource.ts`): sources are
  interchangeable behind one interface; everything downstream is source-blind.

Port disposition (from the Multi audit):

| Disposition | Surfaces |
| --- | --- |
| Keep whole | `src/flows` (300 descriptors, `invoke.ts`, `backendDelegation.ts`), `src/flowchat` (xstate machine, timeline, time travel), `src/cards` (embed contract), `src/chat`, `packages/concierge`, `src/gateway`, `src/runs`, `src/sync`, `src/notifications`, all gateway-backed embeds (runs, gatewayRun, approvals, scores, evals, optimize, crons, prompts, tickets, agents, memory, docs, terminal, files, vcs) |
| Swap source | `src/smithersCloud/*` becomes the studio local client; `filesSource` points at the local backend; per-repo gateway resolution is local |
| Drop | GitHub OAuth/session, billing, byok, admin, branch locks, pair multiplayer plane, platform runs backend, push notifications DO, Electric shape proxies, GitHub import |
| Honor the kill list | SPEC §15.3 of Multi (no dock, no standalone login, no standalone diff/logs routes) |

State stays Zustand per feature folder plus xstate for flowchat. Gateway data flows
through `@smithers-orchestrator/gateway-client` / `gateway-react` exactly as Multi
does today (both repos already link these packages from this monorepo).

### The GUI/TUI seam

The parallel TUI effort treats the frontend as two stacks that meet at a boundary:

- **Logic modules** (stores, clients, flow descriptors, machines, selectors) import
  nothing from `react-dom`, the DOM, electrobun, or CSS. They are plain TypeScript
  plus React hooks that only use state/context/effects.
- **Surface components** (DOM markup, styling, Monaco/xterm/pierre adapters) live in
  clearly separated folders and are the only modules allowed to touch the DOM.
- Platform capabilities (open dialog, clipboard, notifications, window control) are
  injected through one `StudioPlatform` interface provided at bootstrap. The GUI
  implements it over the electrobun RPC bridge; the TUI will implement it over
  opentui.

The enforcement is mechanical: an arch guard test walks logic-module imports and
fails on any DOM/electrobun import (Multi has precedent arch guards in
`scripts/`).

## Repo layout

```
apps/studio/
  package.json            # @smithers-orchestrator/studio, private
  electrobun.config.ts
  src/main/               # bun main process: services, proxy, rpc bridge
  src/app/                # ported frontend (logic modules + surfaces)
  src/views/main/         # webview entry (index.html, boot)
  tests/                  # unit + arch guards
  e2e/                    # playwright against the dev server + real gateway
```

New workspace package checklist applies (learned the hard way): add the
`docs/reference/package-configuration.mdx` row, regenerate llms bundles, add the
ui-arch baseline entries for style-prop components, and refresh BOTH lockfiles
(`pnpm-lock.yaml` and `bun.lock`) in the same commit that edits any manifest.

## The PR stack (initial plan)

The stacked-ship workflow builds Studio as an ordered stack of PRs. Each PR is one
jj change, one reviewable story, one HTML artifact. The planner agent refines this
list against the current tree before lane one starts; slugs are stable identifiers.

1. `studio-scaffold`: `apps/studio` workspace package; electrobun 1.18.1 config;
   React webview boots to a shell screen; dev scripts (`pnpm -C apps/studio dev`);
   preflight service + full-screen preflight UI (claude/codex/git checks with exact
   remediation commands); workspace-package checklist items.
2. `studio-backend-core`: main-process `Bun.serve` origin; `/api/studio/health`;
   gateway service (start/attach per-repo `smithers gateway`, reference counting);
   `/v1/rpc` + WS proxy; the WS spike result documented in-code.
3. `studio-repos-vcs`: repos registry + local checkout open flow; colocated jj init
   via bundled binary; vcs service (status/log/diff/bookmarks wire shapes); repo
   picker UI replacing GitHub import.
4. `studio-core-port`: flows + flowchat + cards + chat shell + concierge wiring
   ported from Multi with the studioLocalPlugin seam; command palette; home screen.
   Logic/surface folder split + arch guard test land here.
5. `studio-runs-surfaces`: runs list, gateway run inspector, approvals queue, run
   event logs, scores/evals/crons/prompts/tickets/memory embeds over gateway-react.
6. `studio-files-embed`: files tree + editor + diff surfaces over the files
   service; vcs changes embed over the vcs service.
7. `studio-workspaces-exec`: workspace service + Microsandbox seat (bind-mounted
   checkout, direct fallback); workspace lifecycle UI; agent work launches through
   the workspace gateway into the seat.
8. `studio-terminal`: PTY service + xterm embed (workspace and microVM seats).
9. `studio-artifacts`: run walkthrough artifacts in-app: reuse the stacked-ship
   artifact renderer (`.smithers/lib/stackArtifact.tsx`) to render run/diff stories
   from the gateway; artifact browser surface.
10. `studio-packaging`: `electrobun build` canary/stable channels; macOS
    codesign/notarize wiring behind env vars; app icons; update.json channel stub;
    README with install + build docs.

Each PR lands with tests (bar below) and its own HTML review artifact. PRs later in
the stack may be re-planned as reviews land; the stack is rebased aggressively and
history stays clean (one change per PR at all times).

## Testing bar

- Product code and e2e tests use real backends: a real gateway, real jj repos in
  temp dirs, real agent CLIs where the machine has them (guarded by
  `describe.skipIf` exactly like the existing real-CLI suites). No route mocks.
- Every service module gets unit tests over a hermetic temp filesystem.
- Arch guard: logic modules import no DOM/electrobun.
- e2e: boot the dev-server app headless (Chromium via playwright), preflight-pass
  path and preflight-fail path, open a temp repo, see runs list from a seeded real
  gateway run.
- Per-PR scoped gates run in the stacked-ship hygiene step; the full suite runs at
  final assembly.

## Risks and open spikes

- WKWebView feature deltas and CSP behavior are undocumented in electrobun; test
  Monaco/xterm/pierre early on macOS (PR 4/6/8 carry explicit smoke checks).
- WebSocket upgrade under the electrobun runtime: spike in PR 2 with the direct
  gateway-port fallback.
- Microsandbox requires hardware virtualization; the direct seat is the documented
  fallback and the UI labels the mode honestly.
- electrobun Windows/Linux signing is undocumented; packaging PR ships macOS
  signing only and tracks the rest.
- The concierge in Multi calls OpenAI server-side; Studio routes concierge turns
  through the installed CLIs (codex exec / claude --print) via the gateway instead.
  Latency is acceptable for a v1 local app; revisit with local models later.
