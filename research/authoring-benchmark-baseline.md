# Authoring benchmark baseline: claude-haiku-4-5

> **Written for Smithers 0.x.** This note is research from before the 1.0
> rewrite. It describes the JSX workflow runtime, its CLI, or its gateway, none
> of which exist in 1.0.0-rc.0. It is kept as history, not as guidance; see
> `docs/pages/migration/1.0.md` for what replaced each surface it names.

Date: 2026-07-14. Suite: `.smithers/evals/authoring-benchmark.jsonl`, workflow:
`.smithers/workflows/authoring-benchmark.tsx`. This is the "haiku can build
this" acceptance bar from Phase 1 of
`research/workflow-authoring-friction-postmortem.md`.

## Result: PASS (all deterministic gates green)

claude-haiku-4-5 was given a single prompt (see `builderPrompt()` in the
workflow) describing a miniature issue-sweep workflow: parallel per-item
lanes with a bounded correction `<Loop>`, one global `<MergeQueue>`, typed
outputs with no reserved-column collisions, no same-lane nested loops, and a
`renderWorkflow`-based test registered in `.smithers/package.json`. No further
guidance, no LLM judge in the scoring path.

The candidate it produced
(`.smithers/workflows/.authoring-benchmark/bench-issue-sweep.tsx` +
`bench-issue-sweep.test.tsx`) passed every deterministic gate on the first
try:

| Gate | Result |
|---|---|
| `smithers graph` renders clean (no `NESTED_LOOP`/reserved-column/render error) | ✅ |
| Exactly one `<MergeQueue>` | ✅ (count: 1) |
| `.smithers` typecheck green | ✅ |
| Test file registered in `.smithers/package.json`'s `test` script | ✅ (haiku appended it itself) |
| Registered test green (`bun test`) | ✅ |

Deterministic score object (`scoreCandidate()` output):

```json
{
  "graphRendersClean": true,
  "singleMergeQueue": true,
  "typecheckGreen": true,
  "testRegistered": true,
  "testGreen": true,
  "allPassed": true
}
```

## A caveat on how this result was obtained

The `smithers eval` harness run itself (`eval-authoring-bench-8937f430-haiku-baseline`)
parked at `waiting-quota`: the account's Claude five-hour usage window was
exhausted by the same session driving this implementation, so the `build`
task's structured JSON reply was never captured by the harness even though
the underlying Claude Code CLI call had already written both files to disk
correctly. The candidate files are real, unedited agent output (no mock, no
hand authoring); the deterministic gates above were verified by calling the
workflow's own `scoreCandidate()` (the exact function the `score` task runs)
directly against those files once quota blocked the harness from reaching
that task itself. Re-running `smithers up .smithers/workflows/authoring-benchmark.tsx --run-id eval-authoring-bench-8937f430-haiku-baseline --resume true`
once quota resets will replay the same run to a clean `finished` status
end-to-end through the harness (the `build` output was never persisted, so
resuming re-attempts that task, not a re-score of a already-answered one).

## Acceptance

Per Phase 1's acceptance bar ("haiku passing all deterministic gates"): **met**.
