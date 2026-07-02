# Sandboxes, worktrees, and VCS

> **Status:** Partial · **Priority:** P1 · **Owner:** smithers-maintainers · **Group:** Ship & review · **Tier:** Platform

**What you can do:** Agents work in isolated copies of the repo so parallel work cannot stomp your tree.

Isolated per-task worktrees (jj-first with git fallback), Cloudflare sandbox backend, and VCS plumbing. Chained-worktree workflows can hit jj bookmark conflicts after git commits, forcing the git-worktree fallback.

## Capabilities

### Worktree component

<Worktree> gives each task an isolated checkout; agents must not pin cwd.

### Cloud sandbox

Cloudflare sandbox backend for remote execution.




## Test cases

- pnpm -C packages/vcs test
- pnpm -C packages/sandbox test

## Observability

_None recorded yet._

## Debugging

_None recorded yet._

## Architecture

_None recorded yet._

## Fixes & diffs

_None recorded yet._

## Open gaps

- jj bookmark conflicts from git commits in chained worktrees need an automated repair path

