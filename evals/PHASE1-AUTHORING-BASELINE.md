# Phase 1 authoring benchmark

Run the deterministic benchmark with:

```bash
bunx smithers-orchestrator eval evals/phase1-authoring-benchmark.tsx --cases evals/suites/phase1-authoring/cases.jsonl --suite phase1-authoring --force
```

The builder is `claude-haiku-4-5-20251001`. The case passes only when graph
rendering, reserved-column and nested-loop checks, the single global
`MergeQueue` check, documented loop bindings, `.smithers` typecheck, and the
registered `renderWorkflow` test all pass. There is no LLM judge.

Baseline result (2026-07-14): blocked by the local Claude subscription process;
the Haiku child launched through `bunx smithers-orchestrator eval` but produced
no result after four minutes and was terminated. The checked-in fixture and its
deterministic gates are green; rerun the command in an environment where the
Haiku builder returns normally to record the acceptance result.
