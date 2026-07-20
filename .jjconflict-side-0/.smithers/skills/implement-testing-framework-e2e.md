---
name: implement-testing-framework-e2e
description: Implement and verify the testing framework with Luna/Fable planning, deterministic real checks, and fresh same-diff Sol/Fable consensus.
workflow: implement-testing-framework-e2e
---

Use this manual workflow for the high-control `packages/testing` implementation. Luna researches read-only, Fable plans read-only, Luna implements, Sol performs the first strict review, and a bounded loop requires Sol and Fable to approve the same unchanged SHA-256-identified diff. Deterministic tasks run real package/repo/e2e commands and reject tracked-file drift, commits, stale reviews, and POC edits. The workflow never commits or pushes.

Inputs are optional `objective` (the built-in objective already contains the full architecture contract), `maxRounds` (1–8, default 8), `verificationProfile` (`focused`, `ci`, or `full`; default `full`), and `focusedTestCommands` (additional explicit commands). `focused` always runs package tests and package typecheck. `ci` also runs root typecheck/test. `full` additionally runs real fault and e2e suites.

Start the default full run with:

```sh
smithers up .smithers/workflows/implement-testing-framework-e2e.tsx -d
```

For typed inputs, use:

```sh
smithers up .smithers/workflows/implement-testing-framework-e2e.tsx --input '{"maxRounds":8,"verificationProfile":"full","focusedTestCommands":[]}' -d
```

Watch it with `smithers ps`, `smithers logs <runId> -f`, or `smithers inspect <runId>`.

Visualize it without executing with `smithers graph .smithers/workflows/implement-testing-framework-e2e.tsx --compact`.

The workflow has no human approval gate: Sol and Fable are the required independent code reviewers. Use `smithers why <runId>` for a stalled run or `smithers cancel <runId>` to stop it.

Only Luna tasks have write-capable agents. Research, planning, and both review paths are technically read-only. Consensus fails after the configured bound rather than returning a partial success.
