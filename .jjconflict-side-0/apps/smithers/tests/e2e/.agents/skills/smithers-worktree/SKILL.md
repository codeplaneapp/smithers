---
name: smithers-worktree
description: Inspect and reclaim the worktrees Smithers created for <Worktree> lanes. Run `smithers worktree --help` for usage details.
requires_bin: smithers
command: smithers worktree
---

# smithers worktree list

List every worktree Smithers created in this repository and the run that owns it.

---

# smithers worktree prune

Remove the worktrees of runs that are over (finished, failed, or cancelled).

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--run` | `string` |  | Only prune worktrees owned by this run id |
| `--olderThan` | `string` |  | Only prune worktrees untouched for at least this long, e.g. 24h |
| `--dryRun` | `boolean` | `false` | Report what would be removed without removing anything |
| `--force` | `boolean` | `false` | Also remove worktrees holding uncommitted or unpushed work |
