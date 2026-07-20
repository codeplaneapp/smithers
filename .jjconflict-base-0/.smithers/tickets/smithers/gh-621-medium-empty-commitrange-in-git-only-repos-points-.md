# [medium] Empty commitRange in git-only repos points review gates at an empty diff

GitHub: https://github.com/smithersai/smithers/issues/621

**Severity:** Medium · **Feature:** delegation-chain · **File:** `packages/components/src/components/delegation/withCommitRange.js:98`

## Problem
In a **git-only** repo where the exec agent edits files without committing, `commitRange` is captured as `{from: HEAD, to: HEAD}` (an empty range), so review gates are pointed at an empty diff and see "no changes".

`captureWorkingCopyCommit` (`withCommitRange.js:39-47`) falls back to `git rev-parse HEAD`; when the exec agent edits but does not `git commit`, `before.commit === after.commit`. The merge at `94-100` has no `from===to` guard (only `!before`, vcs-mismatch, and non-object guards), so `{from:HEAD,to:HEAD,vcs:'git'}` is written to the `dcExec` row.

## Impact
`commitInspectionRules` (`delegationPrompts.js:373-388`) then **skips** its own graceful `length===0` fallback ("locate the changes yourself") and instead emits `git: <sha>..<sha>` with `git diff <from> <to>` (empty) plus "Your verdict must cite evidence from the commits" — a misleading empty-diff prompt to a strict reviewer, which mis-judges (spurious fail, or a pass on a stale tree).

The **jj path is immune**: jj auto-snapshots `@` so `commit_id` advances during exec, giving `from != to`.

## Failure scenario
A plain-git repo (no jj). The default `execPrompt` never tells the agent to commit, so "edit without commit" is the ordinary case. The reviewer receives an empty `git diff <sha>..<sha>` and a "cite evidence from the commits" instruction, and returns a spurious verdict.

## Suggested fix
Omit `commitRange` when `from===to` so the reviewer falls back to inspecting the working tree itself (the already-intended `length===0` fallback).

## Verification
Confirmed no `from===to` guard on the write path; `DelegationExecution.js:127-129` keeps the empty range; `commitInspectionRules` skips its length-0 fallback. jj path forces a working-copy snapshot so HEAD advances. No test exercises `from===to` (all delegation-components tests use distinct jj from/to). Confined to git-only repos; reviewer retains latitude to recover via `git status`, so medium not high.

---
*Found in the pre-0.28.0 review of `v0.27.0..HEAD` (@0ed2c28710), adversarially verified against the code. Part of the `pre-0.28-review` batch.*
