# Run any smithers script on plue infra

> Working spec for the `run-on-plue` feature. Authored 2026-07-01.
> Builds on `.smithers/specs/cloud-execution-engineering.md` (Part 5: Freestyle
> Provider) — this spec specializes it to plue as the infra control plane.

## Goal

A smithers workflow (`run-on-plue`) that takes **any smithers workflow script**
(a `.tsx` file) and executes it on **plue infrastructure** (the smithers-cloud
product at `/Users/williamcory/plue`), using:

- the **plue CLI** (Go, `plue/cmd/smithers` + `internal/smitherscli`) as the
  control-plane client — extracted/published to npm so anyone can install it,
- the smithers **Sandbox feature** (`packages/sandbox` `SandboxProvider` +
  `<Sandbox>` component) as the integration seam,
- with **both `claude` (Claude Code) and `codex` CLIs working** inside the
  remote VM (the explicitly-called-out hard part).

A separate **implementation workflow** (`implement-plue-runner`) builds the
feature (per the task directive: the builder script must be a different
smithers script than the runner script).

## Ground truth (verified by direct reading)

### plue (/Users/williamcory/plue)
- Go monorepo; product is "Smithers — jj-native code hosting" (GitHub-like:
  repos, issues, stacks, workspaces, agents). Server: `cmd/server`, listens
  `:4000`, routes under `/api`.
- **Workspaces** = Freestyle VMs (`api.freestyle.sh`), repo-bound:
  `POST /api/repos/{owner}/{repo}/workspaces`, SSH via
  `GET .../workspaces/{id}/ssh`. Server env `SMITHERS_FREESTYLE_API_KEY`,
  `SMITHERS_FREESTYLE_AGENT_SNAPSHOT_ID` (agent snapshot: bun 1.3.9, jj, git,
  `/opt/smithers/runner-workflow` with smithers-orchestrator@^0.9.1).
  Fresh snapshot created 2026-07-01: `sh-tg7lue1t2l0fv7z5uiwp`.
- Workspace VMs stage: cloned repo (GitRepos), a **Claude bootstrap script**
  (`buildWorkspaceClaudeBootstrapScript`,
  `internal/services/workspace_provisioning.go`), and the smithers CLI binary
  (gzip+b64). **No codex bootstrap exists.**
- CLI (`internal/smitherscli`): `auth login` (token), `repo create`,
  `workspace create|list|view|ssh|delete`, `agent`, `api` (raw). Config:
  `~/Library/Application Support/smithers/config.toon` (darwin) or
  `$XDG_CONFIG_HOME/smithers/config.toon`. Default API
  `https://api.smithers.sh` (NOT deployed — Vercel 404); local dev is
  docker-compose (`scripts/dev.sh`): postgres/migrate/seed/repo-host/api/ssh +
  cloudflared tunnel so Freestyle VMs can call back. Seeded dev token:
  `smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef` (user `alice`).
- CLI has Claude Code auth plumbing already: `getClaudeAuthEnv`,
  `loadClaudeOAuthAccessTokenFromKeychain` (macOS keychain),
  `buildClaudeAuthSeedRemoteScript` (`commands_workspace.go`).
- npm wrapper exists at `packages/npm-cli` (`@smithers/cli`, bin `smithers`,
  postinstall downloads Go release binaries from `dl.jjhub.tech`); **not
  published** (npm 404). `scripts/extract-cli-repo.ts` is STALE (targets a
  removed Rust `cli/` dir) — do not trust it; the live CLI is Go.
- `cmd/smithers-agent` (guest-side agent runner) is **codex-only**
  (`--provider codex --transport http` hardcoded).
- `cmd/fake-sandbox` is an in-memory Freestyle API emulator returning canned
  exec output — a mock; NOT acceptable for e2e verification.

### smithers (/Users/williamcory/smithers4)
- `packages/sandbox`: `SandboxProvider = { id, run(request), cleanup? }`.
  `request`: `{ runId, sandboxId, input, rootDir, requestBundlePath,
  resultBundlePath, workflow, executeChildWorkflow, allowNetwork,
  maxOutputBytes, toolTimeoutMs, egress, config, signal, heartbeat }`.
  Result: `{ bundlePath }` OR inline `{ status: finished|failed|cancelled,
  output, outputs?, runId?, remoteRunId?, workspaceId?, diffBundle?, patches?,
  artifacts? }`. `registerSandboxProvider(provider)` for string ids; or pass
  the provider object straight to `<Sandbox provider={...}>`.
- The child workflow crosses the provider boundary as a LIVE object — a remote
  provider must ship the workflow **source file** and run it remotely
  (`bunx smithers-orchestrator up <file> --input <json>`), then map the run
  result into the inline provider result shape.
- Template: `examples/freestyle/provider.ts` (mock client;
  real-client-shaped). Spec guidance: do NOT extend `SandboxRuntime`; use a
  provider object (cloud-execution-engineering.md Part 5).
- Agents: `.smithers/agents.ts` — `ClaudeCodeAgent` (claude CLI, model
  claude-sonnet-4-6 pool default) and `CodexAgent` (codex CLI, gpt-5.5).
  Claude auth: `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`. Codex auth:
  `~/.codex/auth.json` or `OPENAI_API_KEY`.

### Host environment (verified 2026-07-01)
- `FREESTYLE_API_KEY` set; `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` set;
  `~/.codex/auth.json` present; claude 2.1.198 + codex-cli 0.142.5 installed.
- Docker 29.4.0 up; `gh` authed (roninjin10); **npm NOT logged in** (publish
  step will need the user).
- plue dev stack boot in progress (background task btc35ge7v).

## Post-research adjustments (deep-read findings, 2026-07-01)

- **Architecture fork resolved: workspaces + SSH (option A).** plue has a
  second path (workflow-sandbox scheduler: `workflow_sandbox_scheduler.go`
  dispatch → ephemeral Freestyle VM → `bun x --package smithers-orchestrator
  smithers run <path>`), but it is broken with current orchestrator (`smithers
  run` does not exist in 0.26.x — only `up`), returns logs+exit-code only,
  hard-clamps at 30 min, and its default-deny egress blocks api.anthropic.com
  and api.openai.com/chatgpt.com. The workspace path has none of those limits,
  is persistent (warm re-runs), and workspaces already stage repo + smithers
  CLI + a Claude bootstrap.
- **Fix plue's broken dispatch at the source** while we're there: replace
  `smithers run` with `smithers up` in `buildWorkflowCommand`
  (`internal/services/workflow_sandbox_scheduler.go:610-654`) and pin the
  orchestrator version (currently unpinned `bun x --package
  smithers-orchestrator` + a badly stale `^0.9.1` in
  `cmd/runner/workflow/package.json`).
- **Result channel**: SSH `cat` of a result JSON file the remote run writes
  (`--emit-result`-style: run `up`, then read the run output via
  `smithers inspect --format json` remotely or a wrapper that writes
  result.json). No new plue API needed for v1.
- **Auth policy**: per-exec env injection over SSH — `ANTHROPIC_API_KEY`
  (ClaudeCodeAgent clears it but honors `ANTHROPIC_AUTH_TOKEN`; plue's
  poc/claude-in-freestyle proved `ANTHROPIC_AUTH_TOKEN` env works) and
  `OPENAI_API_KEY` + optional `~/.codex/auth.json` seed (0600). Nothing baked
  into snapshots or persisted.
- **Non-interactive v1**: `<Sandbox reviewDiffs={false}>` (default is
  fail-closed diff review); no approvals inside the remote child.
- **Prod reality**: live hosted API is `https://api.jjhub.tech` (health ok);
  `api.smithers.sh` is a dead Vercel deployment though it is the CLI's
  compiled-in default. Local docker-compose (localhost:4000) is our target;
  the npm package must not ship a dead default — point default at
  api.jjhub.tech or make it config-required.
- **npm identity**: package `plue`, bin `plue` (verified available; avoids the
  `smithers` bin collision with smithers-orchestrator). Go CLI extraction is
  clean: `internal/smitherscli` imports no other repo-internal packages and
  `github.com/smithersai/incur` is publicly fetchable.
- **Feature flags**: workspaces flag is default-OFF in plue config; local
  compose sets `SMITHERS_FEATURE_FLAGS_WORKSPACES=true`. The runner must
  surface a clear error if the target server has workspaces disabled.

## Architecture

```
run-on-plue.tsx (smithers workflow, .smithers/workflows/)
  └─ <Sandbox provider={plueProvider} input={{scriptSource, scriptName, agents, input}}>
       plueProvider (createPlueSandboxProvider, examples/plue/provider.ts →
                     later a real package if it earns it)
         1. plue CLI: workspace create --repo <owner>/<repo>  (JSON out)
         2. poll workspace ssh-ready (CLI view / ssh info)
         3. ssh: bootstrap  — idempotent, snapshot-aware:
              • bun on PATH (snapshot has it)
              • npm i -g @anthropic-ai/claude-code @openai/codex (if missing)
              • seed auth: CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY env;
                write ~/.codex/auth.json from local (0600) or OPENAI_API_KEY
         4. scp/ssh-heredoc: mini-project → /opt/smithers-run/
              package.json (smithers-orchestrator@current, zod)
              agents.ts (claude + codex providers, env-auth)
              script.tsx (the user's workflow, verbatim)
              input.json
         5. ssh: bun install && bunx smithers-orchestrator up script.tsx
                 --input "$(cat input.json)" ; capture run result JSON
         6. map to SandboxProviderResult {status, output, remoteRunId:vmId,
            workspaceId}; on error → {status:"failed", output:{error}}
         7. cleanup: workspace delete (opt-out via keepWorkspace)
```

Key decisions:
- **Provider goes through the plue CLI**, not raw Freestyle: plue owns auth,
  repo binding, quotas, workspace lifecycle. (Raw-Freestyle is what
  examples/freestyle sketches; plue is the product path.)
- **Auth is injected per-VM at runtime, never baked into snapshots.**
- **claude + codex both**: bootstrap installs both CLIs; agents.ts in the
  mini-project defines both providers; the e2e proof runs one task on each.
- The plue CLI needs a **non-interactive remote exec** path. `workspace ssh`
  exists; if it can't run a one-shot command, add `workspace exec` to the Go
  CLI (plue change, at the source).
- npm publish: prepare `packages/npm-cli` (rename if scope unavailable,
  release pipeline for Go binaries, README), extract to standalone repo via
  `gh repo create`, `npm publish --dry-run` proves readiness; real publish
  needs user npm login.

## Deliverables

1. `plue`: codex bootstrap parity (workspace provisioning + CLI auth seeding),
   `workspace exec` (if missing), npm-cli publish prep. Tests.
2. `smithers4`: `examples/plue/provider.ts` (createPlueSandboxProvider, real
   CLI shelling, no mocks), `.smithers/workflows/run-on-plue.tsx`,
   `.smithers/workflows/implement-plue-runner.tsx` (the builder), docs page +
   `pnpm docs:llms` regen. Tests (fake agent seeding for CI; real e2e local).
3. Standalone CLI repo + npm package prepped; publish gated on user npm auth.
4. E2E evidence: a demo script runs on plue infra twice — one claude task, one
   codex task — with real model output captured from the VM run.

## Verification (no mocks)

- `plue workspace create` against the LOCAL plue stack (docker-compose w/ real
  Freestyle key) → real VM boots from snapshot `sh-tg7lue1t2l0fv7z5uiwp`.
- `run-on-plue` executes `examples/plue/demo-child.tsx` whose graph has two
  tasks: one `agent={claude}`, one `agent={codex}`; both must return real
  completions (assert non-template output + token usage in run events).
- plue CI-safe tests: fake agent seeding, no browser; snapshot/Freestyle tests
  live behind env guards like `workspace_provisioning_live_test.go` does.
