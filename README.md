# Burns

Burns is a workspace-first local control plane for authoring, running, and operating Smithers workflows.

This repository is a Bun monorepo with:

- `apps/web`: React + Vite frontend
- `apps/daemon`: local Bun HTTP daemon
- `apps/desktop`: ElectroBun desktop shell package
- `apps/cli`: CLI runtime and distribution path
- `packages/shared`: shared Zod schemas and domain types
- `packages/client`: typed API client used by the frontend
- `packages/config`: placeholder package for shared tooling config

## Current implementation status

Implemented today:

- Workspace registry with SQLite persistence
- First-run onboarding flow that captures Burns defaults before the first workspace is created
- Workspace onboarding flows for create, clone, and add-local-repo
- Workflow storage under `.smithers/workflows/<workflow-id>`
- Workflow list and detail views, including per-workflow file tree browsing and source preview
- AI-assisted workflow generation and prompt-driven editing via installed local agent CLIs
- Launch-field inference from workflow source for run forms
- Editable settings UI with reset-to-defaults, advanced Smithers auth/rootDir controls, and onboarding completion tracking
- Web UI for workspace overview, workflows, runs, approvals, inbox, and settings
- Smithers-backed run lifecycle APIs (`start` / `list` / `detail` / `resume` / `cancel`)
- Run event persistence in SQLite plus SSE proxy streaming with reconnect via `afterSeq`
- Approval decision APIs (`approve` / `deny`) wired from UI
- Managed per-workspace Smithers server lifecycle (startup, crash restart, graceful shutdown)
- Workspace server control APIs (`start` / `restart` / `stop` / `status`)
- Desktop shell that attaches to an existing daemon or spawns one in-process
- CLI runtime that can start the daemon and serve built web assets

## Prerequisites

- Bun `1.2.19`
- Git CLI
- Optional for AI workflow generation/editing: at least one supported agent CLI installed on `PATH`
  - `claude`
  - `codex`
  - `gemini`
  - `pi`

## Quick start

```bash
bun install
```

Start daemon:

```bash
bun run dev:daemon
```

Start web app in a second terminal:

```bash
bun run dev:web
```

Open `http://localhost:5173`.

The web app defaults to `http://localhost:7332` for API calls. Override with:

```bash
VITE_BURNS_API_URL=http://localhost:7332 bun run dev:web
```

Desktop/CLI runtime contract can also inject:

```ts
window.__BURNS_RUNTIME_CONFIG__ = {
  burnsApiUrl: "http://localhost:7332",
  runtimeMode: "desktop" // or "cli"
}
```

Other entry points:

```bash
bun run desktop:dev
bun run cli:start
```

## Workspace scripts

- `bun run dev:web`: run Vite dev server
- `bun run dev:daemon`: run daemon with watch mode
- `bun run build:web`: build frontend
- `bun run desktop:dev`: run ElectroBun desktop app
- `bun run desktop:build:canary`: build desktop canary artifacts
- `bun run desktop:build:stable`: build desktop stable artifacts
- `bun run desktop:build:artifact`: build desktop archive into `dist/desktop` (channel/version via env)
- `bun run cli:build:artifact`: build CLI archive into `dist/cli` (channel/version via env)
- `bun run smoke:desktop-runtime`: desktop runtime smoke (daemon lifecycle + runtime config contract)
- `bun run smoke:cli-runtime`: CLI runtime smoke (daemon + static web serving)
- `bun run smoke:release`: run both smoke checks
- `bun run cli:start`: run CLI daemon + web startup flow
- `bun run cli:daemon`: run CLI daemon-only flow
- `bun run cli:web`: serve built web assets from CLI
- `bun run typecheck`: typecheck shared, client, web, daemon, cli, and desktop packages

Desktop dev mode env options:

- `BURNS_DESKTOP_DEV_SOURCE=views|vite` (`views` default)
- `BURNS_DESKTOP_DEV_VITE_URL=http://localhost:5173`
- `BURNS_DESKTOP_FORCE_API_URL=http://localhost:7332` (debug override)

Additional app-level scripts:

- `apps/web`: `bun run typecheck`, `bun run lint`, `bun run preview`
- `apps/daemon`: `bun run start`, `bun run typecheck`, `bun run test`, `bun run test:raw`
- `apps/cli`: `bun run start`, `bun run build:artifact`, `bun run typecheck`, `bun run test`
- `apps/desktop`: `bun run build`, `bun run build:canary`, `bun run typecheck`, `bun run test`

## Testing

- `bun run typecheck`: monorepo typecheck
- `cd apps/web && bun run lint`: web linting and React Compiler rules
- `cd apps/daemon && bun run test`: daemon route/service/integration tests in isolated workspaces
- `cd apps/cli && bun run test`: CLI argument and path resolution tests
- `cd apps/desktop && bun run test`: desktop runtime and config contract tests
- `bun run smoke:release`: desktop + CLI runtime smoke coverage

## Desktop + CLI release scaffolding

Desktop and CLI artifact assembly is script-driven. Release automation is wired through the shell scripts in `scripts/release`.

- Run an optional release build step:
  - `bash scripts/release/run-build-step.sh --label "desktop build" --command "<desktop-build-command>"`
  - `bash scripts/release/run-build-step.sh --label "cli build" --command "<cli-build-command>"`
- Generate contract-compliant artifact names:
  - `bash scripts/release/artifact-name.sh --channel canary --component desktop --version 0.0.0-canary.1+abc12345 --target-os darwin --target-arch arm64 --extension zip`
- Collect and rename artifacts:
  - `bash scripts/release/collect-artifacts.sh --channel canary --version 0.0.0-canary.1+abc12345 --target-os darwin --target-arch arm64 --desktop-pattern "dist/desktop/*" --cli-pattern "dist/cli/*" --output-dir release-artifacts`
- Draft release notes:
  - `bash scripts/release/create-release-notes.sh --channel canary --version 0.0.0-canary.1+abc12345 --commit <sha>`

## Runtime data locations

The daemon stores local state under `BURNS_DATA_ROOT` when that env var is set. Otherwise the default data root is `apps/daemon/.data`:

- SQLite DB: `<data-root>/burns.sqlite`
- Managed workspace root: `<data-root>/workspaces`

Each managed workspace stores workflows at:

```txt
<workspace-path>/.smithers/workflows/<workflow-id>/
```

Primary workflow entrypoints are resolved from:

```txt
<workspace-path>/.smithers/workflows/<workflow-id>/workflow.tsx
<workspace-path>/.smithers/workflows/<workflow-id>/workflow.ts
```

Each managed workspace also stores Smithers runtime state at:

```txt
<workspace-path>/.smithers/state/smithers.db
```

Optional Smithers lifecycle env vars:

- `BURNS_SMITHERS_MANAGED_MODE=0` to disable daemon-managed per-workspace Smithers processes
- `BURNS_SMITHERS_PORT_BASE=7440` to change the first managed Smithers port
- `BURNS_SMITHERS_MAX_WORKSPACE_INSTANCES=1000` to change the managed port scan range
- `BURNS_SMITHERS_ALLOW_NETWORK=1` to run managed Smithers servers with network access enabled

## Documentation index

- [Documentation Index](./docs/README.md)
- [Codebase Layout](./docs/codebase-layout.md)
- [Daemon API Reference](./docs/daemon-api-reference.md)
- [ElectroBun Release Plan](./docs/electrobun-release-plan.md)
- [Release Automation Reference](./docs/release-automation.md)
- [Release Runbook (Canary + Stable)](./docs/release-runbook.md)
- [Release Checklist](./docs/release-checklist.md)
- [Workspace + Runtime Handoff (Next Agent)](./docs/next-agent-workspace-gaps.md)
- [Product Spec (target state)](./docs/burns-spec.md)

## Notes

- The app-level READMEs under `apps/cli` and `apps/desktop` cover package-specific runtime behavior.
- The product spec describes target behavior; current implementation details are captured in the docs above.
