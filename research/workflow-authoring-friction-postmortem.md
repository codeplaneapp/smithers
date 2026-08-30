# Postmortem: 11-hour workflow-authoring repair loop (riskless-github-issue-sweep)

> **Written for Smithers 0.x.** This note is research from before the 1.0
> rewrite. It describes the JSX workflow runtime, its CLI, or its gateway, none
> of which exist in 1.0.0-rc.0. It is kept as history, not as guidance; see
> `docs/pages/migration/1.0.md` for what replaced each surface it names.

Date: 2026-07-14. Source: Codex orchestrator session `019f5edc` in `~/smithers4`
(04:25Z–18:58Z, killed by a machine restart). The orchestrator spent ~11 hours
and **7 smithers authoring/repair runs** trying to produce a landing-grade
sweep workflow, never launched it once, then re-implemented its topology ad-hoc
in `/tmp` clones — all of which the reboot erased.

## Failure taxonomy (~30 reject/incident events across 7 runs)

| Class | Count | Examples |
|---|---|---|
| (b) missing smithers primitives | ~14 | isolated verification sandbox, idempotent gh closure, provenance binding, collision detection, dirty-main proof |
| (e) environment/tooling | ~11 | 30-min agent timeouts, stale jj/git locks, nested-run duplicate writer, quota-dead required reviewer, panel retried after producing a valid rejection |
| (a) API/docs feedback gaps | ~10 | reserved `iteration` column, nested `<Loop>` (x3 runs), `ctx.latest` vs `outputMaybe({nodeId, iteration})`, renderWorkflow test contract, `.smithers/package.json` test registration |
| (d) agent shortcuts caught by review | ~7 | stubbed landing half with fabricated success values, hand-authored graph tests, fake equivalence-by-commit-message |
| (c) review churn | ~2 | heartbeat-window miss re-ran an already-valid rejection |

Key insight for class (a): **every one of these rules is already documented**
(`docs/reference/db.mdx` reserved columns, `docs/effect/overview.mdx` "nested
loops are not supported", `docs/recipes.mdx:62` loop output binding). The
failure is feedback *timing*: rules are enforced hours later by reviewers or
live runs instead of seconds later by `smithers graph`. Docs alone demonstrably
did not prevent the loop; static checks would have.

Confirmed engine defect: `packages/graph/src/extract.js` (and `dom/extract.js`,
`scheduler/buildPlanTree.js`) throw `NESTED_LOOP` only for nested `<Ralph>`.
A nested `<Loop>` passes `smithers graph` and fails only at runtime. The
Effect builder API (`packages/engine/src/effect/builder.js:674`) already
rejects nested loops — the JSX path does not. This single blind spot burned
repair runs 1–3.

## Phase 1 (this implement run)

1. **Static nested-`<Loop>` rejection.** Make the JSX graph extraction paths
   (`packages/graph/src/extract.js`, `packages/graph/src/dom/extract.js`,
   `packages/scheduler/src/buildPlanTree.js`) throw `NESTED_LOOP` for a
   `<Loop>` (or `<Ralph>`) nested inside any loop construct, matching the
   Effect builder. The error message must name both loop ids and suggest the
   fix ("run the inner work through a queue such as <MergeQueue> and re-enter
   via the outer loop's next iteration instead of nesting loops"). Tests in
   packages/graph + packages/scheduler; verify `smithers graph` on a nested-loop
   fixture fails fast. Audit seeded workflows first: if any seeded workflow
   actually renders a nested Loop today, that's a semantics question to resolve
   (scoped loops via `buildLoopScope` exist for ID purposes) — the check must
   reject only what the engine genuinely cannot execute.
2. **Authoring-rules doc.** A single "workflow authoring rules" section in
   `docs/workflows/` consolidating, with one-line WHY each: reserved output
   columns (`runId`/`nodeId`/`iteration`; input reserves `runId`), no nested
   loops + the queue-based-backfill pattern, loop output binding (`ctx.latest`
   in `until`; `outputMaybe(schema, {nodeId, iteration})` for cross-iteration
   reads), the renderWorkflow-based production-test contract (hand-built graph
   copies in tests are worthless), and `.smithers/package.json` test
   registration for pack tests. Cross-link from workflows/overview and the
   `skills/smithers` skill so create-workflow builders see it. Regenerate
   bundles (`pnpm docs:llms`); CI gates on check-docs/check-llms.
3. **Authoring benchmark ("haiku can build this").** An eval suite (run via
   `smithers eval`, checked into the repo, runnable in CI-lite mode) that asks
   a workflow-builder agent to author a miniature issue-sweep workflow
   (per-item parallel lanes with a correction `<Loop>`, one global serialized
   `<MergeQueue>` landing queue, typed outputs, a renderWorkflow-based test)
   and scores DETERMINISTICALLY, no LLM judges: graph renders clean on first
   try (no reserved-column / NESTED_LOOP / render errors), MergeQueue present
   and single, loop bindings use the documented pattern, `.smithers` typecheck
   passes, test file registered + green. Baseline the suite with
   claude-haiku-4-5 as the builder model; acceptance = haiku passes all
   deterministic gates. The benchmark exists to prove the Phase-1 fixes close
   the loop — wire it so regressions in authoring feedback show up as eval
   failures.

## Phase 2 backlog (separate runs; from the pack audit — ~45-48% of the
1,887-line surviving pack is hand-rolled logic smithers should provide)

- Isolated-verification sandbox primitive: disposable candidate-copy of the
  tree, offline-frozen dep install, network+credential denial, before/after
  tree-digest proof (~385 lines hand-rolled today).
- GitHub landing/closure component: canonical-remote + gh pinning, exact-tip
  re-proof, idempotent comment+close with marker dedup (~280 lines).
- Provenance/causal-binding gate: "this step may run only while the exact
  upstream artifact that authorized it is still current" (~130 lines).
- `<Worktree>` option to pin a lane to an exact remote SHA (fetch-to-SHA).
- Cross-lane/open-PR path-collision detection helper (fail-closed).
- Engine: don't re-run a review panel whose transcript already contains a
  valid terminal verdict after a heartbeat-window miss; quota-aware required-
  reviewer gates (park, don't spin); duplicate-writer guard for nested runs in
  the same checkout.
- Durability lesson: agent lanes staged under `/tmp` do not survive reboot;
  worktree/aggregate staging must default to durable storage
  (`.smithers/worktrees/...`).

## Where the surviving artifacts are

- The hardened (never-committed) workflow pack: `~/smithers4/.smithers/`
  (workflows/riskless-github-issue-sweep.tsx + lib + prompts + tests + ui;
  23/23 tests green as of 2026-07-14).
- Orchestrator transcript: `~/.codex/sessions/2026/07/14/rollout-2026-07-14T00-22-44-019f5edc-*.jsonl`.
