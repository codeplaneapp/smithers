# Phase 1 authoring benchmark

Run the deterministic benchmark with:

```bash
bunx smithers-orchestrator eval evals/phase1-authoring-benchmark.tsx --cases evals/suites/phase1-authoring/cases.jsonl --suite phase1-authoring --force
```

The builder is `claude-haiku-4-5-20251001`. The case has no LLM judge: it
requires rendered graph validation, reserved-column and nested-loop checks, one
serialized global `MergeQueue`, typed outputs, no `continueOnFail` success path,
`.smithers` typecheck, and a registered green `renderWorkflow` production test.

Baseline attempt (2026-07-14): the current suite initialized an isolated
run-scoped scratch workspace and Haiku authored fresh candidate/test files, but
the provider then rejected the session for the Claude five-hour subscription
quota before the deterministic gate task could run. This is recorded as
`waiting-quota` / failed, not as a passing baseline. Acceptance remains a
genuine end-to-end Haiku run with every deterministic gate passing.
