---
name: smithers-fallback-agents
description: >
  Use every registered Claude Code and Codex subscription as one randomized
  failover pool in Smithers workflows, so rate limits on a single account
  never stall a run. Use when the user mentions rate limits, quota, multiple
  subscriptions/accounts, "fallback agents", adding a new Claude/Codex
  account to Smithers, or wants tasks spread across their team's
  subscriptions. Covers: registering a new account with a tmux browser
  login, verifying it, and wiring `fallbackAgents()` into a workflow.
---

# Smithers fallback agents

Smithers keeps a global account registry at `~/.smithers/accounts.json`
(managed by `smithers agents ...`). Each subscription account owns an isolated
CLI config directory (default `~/.smithers/accounts/<label>`), so one machine
can hold many Claude Code and Codex logins side by side: Claude Code reads
`CLAUDE_CONFIG_DIR`, Codex reads `CODEX_HOME`, and Smithers sets the right
variable per spawned agent.

`fallbackAgents()` (exported from `smthrs`) turns that registry into a
failover chain for a `<Task>`:

- One agent per registered Claude/Codex account, **randomly ordered on every
  call** — load spreads across subscriptions (round robin in expectation).
- The Smithers engine already fails over along the chain when a rung is
  rate-limited (persisted `chainIndex`, quota-blocked rungs are skipped for
  the round), so a 429 on one account just moves the task to the next one.
- The "normal" agent is appended as the last rung, and is returned alone when
  the registry is missing, empty, or unreadable — a workflow using this
  helper still runs on machines with no registered accounts (CI, teammates).

## Add a new agent account

One command per account; pick any label you like (`claude-will`, `codex-2`):

```sh
smithers agents add --provider claude-code --label claude-2 --tmux
smithers agents add --provider codex --label codex-3 --tmux
```

`--tmux` creates the account's config dir, launches the provider CLI inside a
detached tmux session with the config-dir env var set, and prints the attach
command (`tmux attach -t smithers-login-<label>`). Attach, complete the login
in the browser it opens, detach with `Ctrl-b d`. Claude Code is launched as
`claude auth login --claudeai`, which goes straight to the subscription flow
(on older CLIs without that subcommand it falls back to the REPL, where you
type `/login`). The command polls for the credential artifact (Claude:
`.credentials.json`, or on macOS the `oauthAccount` entry in `.claude.json`
since tokens go to a per-config-dir Keychain item; Codex: `auth.json`) and
registers the account the moment login completes. If it times out, just
re-run the same command — it detects finished credentials and registers.

**Each account must be a DIFFERENT subscription.** Sign into a different
claude.ai / chatgpt.com account in the browser each time; two labels on one
subscription share a single rate limit and add no capacity. Smithers names
the signed-in account after registering and warns when it duplicates an
existing label. To redo one: `smithers agents remove <label>`, delete its
config dir, then add again signed into another account (on macOS also
`security delete-generic-password -s "Claude Code-credentials-<suffix>"`,
where suffix is the first 8 hex chars of sha256 of the config dir — otherwise
the next login silently reuses the old token).

No tmux? Omit `--tmux` and the command prints the manual login recipe
(`CLAUDE_CONFIG_DIR=<dir> claude`, then `/login`).

Verify and inspect:

```sh
smithers agents list            # registered accounts + which subscription each is signed into
smithers agents test <label>    # spawn the CLI under that account's env
smithers usage                  # per-account quota consumption
smithers agents remove <label>  # deregister (credentials dir is left alone)
```

## Use the pool in a workflow

```tsx
import { fallbackAgents, ClaudeCodeAgent } from "smthrs";

// All Claude + Codex subscriptions, shuffled, then the stock agent last.
// Seed with the run id: the chain stays stable across every render and retry
// of one run, and still varies run to run. Prefer this in real workflows.
<Task agent={fallbackAgents({ seed: ctx.runId })} ... />

// Only Codex accounts, pinned to a model, with an explicit normal agent:
<Task
  agent={fallbackAgents({
    providers: ["codex"],
    models: { codex: "gpt-5.6-sol" },
    fallback: new ClaudeCodeAgent({ model: "claude-fable-5" }),
    seed: ctx.runId,
  })}
  ...
/>
```

Options: `providers` (default `["claude-code", "codex"]`, or `"all"`),
`fallback` (agent, array, or `[]` for no tail), `models` (per-provider
override; otherwise the account's registered model, else the CLI default),
`shuffle: false` to keep registration order, `seed` (string or number,
usually `ctx.runId`) for a deterministic run-stable order, `random` to
supply the RNG directly (wins over `seed`), `agentOptions` (per-provider
constructor options applied to every pooled rung), and `env` to locate the
registry (honors `SMITHERS_HOME`).

`agentOptions` is how a task keeps its authority when its single agent
becomes a pool. `fallbackAgents` constructs the per-account agents itself, so
anything the hand-written agent used to carry — `sandbox`, `permissionMode`,
`tools`, `dangerouslySkipPermissions` — is gone unless you pass it here.
Dropping a narrowing option silently WIDENS authority; dropping a widening
one stalls unattended runs on a permission prompt. Carry them over verbatim:

```tsx
fallbackAgents({
  seed: ctx.runId,
  agentOptions: {
    "claude-code": { permissionMode: "bypassPermissions", dangerouslySkipPermissions: true },
    codex: { sandbox: "danger-full-access", dangerouslyBypassApprovalsAndSandbox: true },
  },
})
```

Import name: the package publishes as `smthrs`, but some workspaces install
it under the `smithers-orchestrator` alias — the flows tree symlinks the dev
checkout that way, and there only that name resolves. Match whatever the
sibling workflows in the same `.smithers/workflows/` directory already
import; guessing wrong fails at module load, not at review time.

Why seed at all? A workflow re-renders on every frame, so a bare
`fallbackAgents()` draws a fresh order each time. The engine tracks quota
failover by position in the chain, so an order that keeps changing under a
running task blurs which rungs are already known to be rate-limited. Seeding
by run id pins one order for the whole run while different runs still start
on different accounts.

Registered accounts also flow into generated `.smithers/agents.ts` pools
(`smithers agents add` regenerates it when present), so default workflows
pick them up without `fallbackAgents()`. Reach for `fallbackAgents()` when
you want the whole subscription fleet behind a single Task, in random order,
with graceful degradation on machines that have no accounts.

## Rules

- Never share one config dir between two labels; every account gets its own.
- Do not delete `~/.smithers/accounts/<label>` while runs are active — agents
  spawned with that `CLAUDE_CONFIG_DIR`/`CODEX_HOME` lose auth mid-task.
- Rate-limit failover is the engine's job: do not hand-roll retry loops
  around `fallbackAgents()`; declare the chain and let the scheduler walk it.
