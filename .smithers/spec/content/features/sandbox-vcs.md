# Local sandboxes, worktrees, and VCS

> **Status:** Partial | **Priority:** P1 | **Owner:** smithers-maintainers | **Group:** Isolate execution | **Tier:** Platform

Smithers isolates risky work through tool sandboxes, explicit <Sandbox> boundaries, per-task worktrees, `jj-first/git-fallback` VCS helpers, diff bundles, and `path/network/output` limits.

## What you can do

Let agents edit and execute in bounded environments so parallel work, untrusted code, and generated diffs do not stomp the operator's checkout.

## Capabilities

### Worktree component

<Worktree> gives each task an isolated checkout; agents must not pin cwd.

### Cloud sandbox

Cloudflare sandbox backend for remote execution.

### Tool sandbox

Built-in `read/write/edit/grep/bash` tools are jailed to rootDir with symlink, network, timeout, and output-size controls.

### Worktree boundary

<Worktree> and VCS helpers allocate isolated checkouts for branches of work.

### Transport sandbox

<Sandbox> bundles `requests/results` through local, bubblewrap, docker, codeplane, cloud, or provider-backed runtimes.

### jj/git pointer capture

VCS helpers detect jj and git, capture stable pointers, and restore files for time-travel operations.

## Endpoints and commands

- `API <Sandbox runtime=...>` ([docs](docs/components/sandbox.mdx))
- `API <Worktree>` ([docs](docs/components/worktree.mdx))
- `API runJj/workspaceAdd/revertToJjPointer` ([docs](docs/workflows/vcs.mdx))

## Related docs

- [Execution model](docs/concepts/execution-model.mdx)
- [Production hardening](docs/deployment/production-hardening.mdx)
- [Sandbox providers](docs/components/sandbox-providers.mdx)

## Test cases

- `packages/sandbox/tests/transport-runners.test.js`
- `packages/vcs/tests/jj-real-repo.test.js`
- `packages/vcs/tests/vcs-tooling-status.test.js`
- `packages/vcs/tests/jj-snapshot-parse.test.js`
- `e2e/faults/case02-kill-sandbox-engine-alive.test.ts`
- `e2e/faults/case21-file-vcs-pointer-integrity.test.ts`
- `e2e/faults/case22-secret-injection-no-leak.test.ts`
- `e2e/faults/case23-network-policy-allow-deny.test.ts`
- `e2e/faults/case26-diff-review-mode.test.ts`

## Observability

- Sandbox metrics include sandboxActive, sandboxCreatedTotal, sandboxCompletedTotal, sandboxDurationMs, sandboxBundleSizeBytes, sandboxPatchCount, and sandboxTransportDurationMs.
- VCS operations track vcsDuration and structured durability-gap warnings when jj snapshots cannot be captured.

## Debugging

- Run `smithers workflow` doctor or vcsToolingStatus to verify `jj/git` availability before worktree workflows.
- Use sandbox transport tests when changing env redaction, network policy, bundle path checks, or provider selection.

## Architecture

- `packages/sandbox/src/index.js` exports bundle, egress, execute, transport, and provider-kit modules.
- `packages/vcs/src/index.js` exports find-root, jj, binary resolution, and tooling status helpers.
- `docs/concepts/execution-model.mdx` clearly distinguishes tool sandbox, CLI agent internal sandbox, and <Sandbox> compute isolation.

## Fixes and diffs

- 2026-07-06 refresh: read README.md, package exports, selected package entry points, `docs/how-it-works.mdx`, `docs/cli/overview.mdx`, `docs/agents/overview.mdx`, `docs/integrations/custom-ui.mdx`, `docs/integrations/mcp-server.mdx`, `docs/deployment/production-hardening.mdx`, `docs/deployment/control-plane.mdx`, and targeted test inventories.
- `packages/sandbox/src`
- `packages/vcs/src`
- `packages/components/src/components/Sandbox.js`
- `packages/components/src/components/Worktree.js`
- `e2e/faults/case22-secret-injection-no-leak.test.ts`

## Open gaps

- jj bookmark conflicts from git commits in chained worktrees need an automated repair path.
- Production deployments must separately prove their selected container runtime enforces CPU, memory, network, and volume policies.
