# Core workflow scenarios

Token-free, **real engine + sqlite** tests of practical Smithers workflow shapes.
Agents are **scripted** from `fixtures/agent-traces/` (no LLM).

These scenarios are **plane-agnostic**: they establish control-plane truth.
Visibility planes (overview HUD, herdr, gateway/TUI) attach as adapters.

Published model: [Token-free visibility testing](../../../../docs/guides/token-free-visibility-testing.mdx).

Run: `pnpm -C packages/testing test` (30s timeout for engine scenarios).

## Catalog (`core-workflows.test.jsx`)

| Scenario id | What it covers |
|---|---|
| `hello` | Single agent task |
| `sequence` | implement → validate |
| `parallel` | 4 workers, one hard-fail |
| `hitl-approve` | Approval parks, approve resumes |
| `hitl-deny` | Deny with `onDeny=skip` |
| `steer-steer` | Durable steer inject (no gate) |
| `steer-expire` | Unused steer expires at terminal |
| `retry` | attempt 1 fail → attempt 2 ok |
| `loop` | Loop body across iterations |
| `hang` | Hang → failed (not cancel-only) |
| `stream` | Multi-chunk virtual stream + delays |
| `mixed` | Static compute + agent |
| `branch` | Branch then/else by input |
| `continueAsNew` | Continuation payload |
| `system` | `smithers-system` frontmatter detection |
| `hitl+steer` | Plan → gate → steer-steered implement |

## Watch-pack (human-visible subset)

Stable ids: **`hello`**, **`sequence`**, **`parallel`** (`WATCH_PACK_IDS` in `scripts/watch-pack.mjs`).

Used by campaign CLI and herdr-bridge; not herdr-exclusive.

## Plane attach (gates B/C)

```bash
# Machine herdr (auto soft-skip / cleanup in bun test):
pnpm -C packages/testing test tests/scenarios/herdr-bridge.test.jsx

# Campaign:
bun packages/testing/scripts/core-campaign.mjs --plane engine
bun packages/testing/scripts/core-campaign.mjs --plane herdr --session smithers-dev --ops
```

Human herdr: `docs/VIBE_CHECK_RUNBOOK.md`.

## Deferred

- Full Worktree / Sandbox isolation in this suite
- Fuzz campaign (gate D), live LLM smoke (gate E)
- `--plane hud` terminal-only smoke
- Scenario → run-snapshot export for TUI/gateway seeds

## Layout

```text
tests/
  unit/           # library unit tests
  scenarios/      # core workflow + plane bridge tests
  helpers/
scripts/
  core-campaign.mjs
  watch-pack.mjs      # WATCH_PACK_IDS + runners
  setup-ops-workspace.mjs
docs/
  README.md
  VIBE_CHECK_RUNBOOK.md
  HUMAN_CHECKLIST.md
fixtures/
  agent-traces/
```
