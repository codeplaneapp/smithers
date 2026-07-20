---
name: riskless-github-issue-sweep
description: Conservatively classify and, when safe, implement, review, land, and close localized GitHub issue fixes; use for a manual issue sweep.
workflow: riskless-github-issue-sweep
---

Use this manual-only workflow to sweep open GitHub issues against the latest `main`. It performs one complete conservative admission pass, then bounded isolated lanes (maximum 16) with automatic backfill and a serialized evidence-bound landing queue. A final rescan reports whether new/edited issues appeared; it never fabricates an in-run fixpoint.

Inputs include `prompt`, pinned `repo` (`smithersai/smithers`), `excludeNumbers` (default `[]`), `laneConcurrency` (1–16, default 16), `reviewIterations` (1–4, default 3), `landingRetries` (1–5, default 3), `dryRun` (default `false`), and `conservativeLabelHints` (priority hints only). Omitted Smithers values are runtime-normalized even when delivered as null. Every run considers the complete current open non-PR issue set; exclusions receive evidence-backed deferred rows and labels never establish eligibility.

Start it with:

```sh
smithers up .smithers/workflows/riskless-github-issue-sweep.tsx --input '{"prompt":"Sweep only safe, localized issues"}' -d
```

For structured inputs, use `smithers up .smithers/workflows/riskless-github-issue-sweep.tsx --input '{"prompt":"Sweep the current open issues","repo":"smithersai/smithers","excludeNumbers":[],"laneConcurrency":4,"reviewIterations":3,"landingRetries":3,"dryRun":true,"conservativeLabelHints":[]}'`.

Run detached with `-d`, then watch it with `smithers ps`, `smithers logs <runId> -f`, and `smithers inspect <runId>`. The workflow has no approval gates.

Visualize it with `smithers graph .smithers/workflows/riskless-github-issue-sweep.tsx`; add `--interactive` for the TUI. The custom UI exists at `.smithers/ui/riskless-github-issue-sweep.tsx`; open a run with `smithers ui <runId>`.

Dry-run is structurally read-only: it uses `git ls-remote` to prove canonical remote main equals clean local main, HEAD, and the tracking ref, and mounts no root synchronization, worktree implementation, approval, fetch/rebase/push, comment, or close subtree. Stop a run with `smithers cancel <runId>`. Every admitted issue ends with one mechanically recorded landed+closed, deferred, blocked, or explicit controller-missing-evidence result. Exclusions are externally owned work and prevent completion/fixpoint. Landing and bounded idempotent closure loops share one global serialized queue. Final shared-root synchronization is always reported as deferred to the outer controller; the workflow never mutates the root to synchronize it.

Sol issue lanes never commit or receive GitHub credentials. Luna owns exact issue/head/digest/paths/iteration bindings and the atomic commit/amend/closure proposals; deterministic tasks mutate with enumerated pathspecs and verified rollback. Fable is pinned to `claude-fable-5`, must return nonempty summary and acceptance evidence, and re-reviews the complete exact digest after any rebase. Each focused/global gate runs in a fresh disposable macOS sandbox copy with credential/config stripping, denied network, private HOME/TMPDIR, true exit/signal handling, per-command complete snapshots, and mechanically verified source-lane immutability. Publication refreshes live collisions, rechecks the issue is open, uses a normal non-force push, and requires both fresh remote reads to equal the candidate SHA. Closure repeats that exact-tip boundary immediately before every repository-pinned comment/close mutation and after closure. Historical `Fixes` or equivalent commits are deferred; only an ambiguous push from the same current-run rebase and Luna publication approval can recover without another push.

Suggest next: run it, watch it in the custom UI, and iterate by re-running `create-workflow` with a follow-up prompt.
