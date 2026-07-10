# 🐛 check-fault-skips: [medium] audit ignores .only/.todo, so a committed test.only silently disables a whole fault file

GitHub: https://github.com/smithersai/smithers/issues/748

_via ultracode (Opus multi-agent) review_

## Summary
`scripts/check-fault-skips.mjs` counts only `.skip`/`.skipIf`, so an accidentally-committed `test.only` or `test.todo` in a fault file goes undetected and the audit reports clean.

## Location
- `scripts/check-fault-skips.mjs:28` — `const skipPattern = /\b(?:test|describe)\.skip(?:If)?\s*\(/g;`
- Counting/compare logic: lines 39-65 (per-file count vs `allowedSkips`).

## Failure scenario
A developer commits `test.only("...", ...)` into e.g. `e2e/faults/case07-continue-as-new-lineage.test.ts`. bun then runs only that single case and silently skips every other fault assertion in the file. Because the file's `.skip` count is unchanged, `observed === allowedSkips` and `pnpm check-fault-skips` prints `no untracked skips` and exits 0. Same for `test.todo` (not executed by default). No other guard catches this — there is no eslint/biome `no-only-tests` rule in the repo.

## Why it matters
The fault suite is the durability/crash-recovery safety net. The guard's stated purpose is to ensure no fault test silently goes dark; missing `.only`/`.todo` gives false confidence that all fault assertions ran, letting regressions in kill/restart/replay paths ship green.

## Fix
Detect `\b(?:test|describe|it)\.(?:only|skip(?:If)?|todo|failing)\s*\(` with an allowlist of 0 for `only`/`todo`/`failing`.
