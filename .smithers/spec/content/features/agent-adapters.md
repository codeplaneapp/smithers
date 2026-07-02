# Agent adapters

> **Status:** Partial · **Priority:** P0 · **Owner:** smithers-maintainers · **Group:** Author workflows

**What you can do:** Mix the best model for each step: plan with one agent, implement with another.

Adapters for Claude Code, Codex, OpenCode, Pi, Kimi, Amp, and Antigravity CLIs with account providers, pools, and failover. Kimi auth-setup failures are fatal to a run instead of failing over, so kimi stays out of default pools.

## Capabilities

### Provider pools

planning/review/implement pools with ordered failover in .smithers/agents.ts.

### Accounts

smithers agent add|list|remove manages per-account configDirs.




## Test cases

- pnpm -C packages/agents test

## Observability

_None recorded yet._

## Debugging

_None recorded yet._

## Architecture

_None recorded yet._

## Fixes & diffs

_None recorded yet._

## Open gaps

- Kimi auth-setup error should fail over to the next pool agent instead of failing the run

