# Phase 1 authoring benchmark

Run the deterministic benchmark with:

```bash
bunx smithers-orchestrator eval evals/phase1-authoring-benchmark.tsx --cases evals/suites/phase1-authoring/cases.jsonl --suite phase1-authoring --force
```

The builder is `claude-haiku-4-5-20251001`. The case passes only when graph
rendering, reserved-column and nested-loop checks, the single global
`MergeQueue` check, documented loop bindings, `.smithers` typecheck, and the
registered `renderWorkflow` test all pass. There is no LLM judge.

Baseline result (2026-07-14): the deterministic Haiku case finished with all
seven gates passing. The provider attempt exhausted its local subscription
after writing the candidate artifacts, so the recorded result is the
deterministic gate pass over that authored candidate; a normal run resets the
three authoring paths before invoking Haiku.
