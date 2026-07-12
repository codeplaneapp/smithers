# 🔒 fix(scripts): [low] shell-string interpolation turns repo-controlled state and paths into commands

GitHub: https://github.com/smithersai/smithers/issues/813

_via 2026-07 full-codebase audit_

## Summary

Developer/release scripts construct shell command strings from filesystem-controlled values instead of passing argument arrays.

## Where

- `scripts/sandbox.ts:36-38 — name/zone from .sandbox-vm are interpolated into execSync`
- `scripts/bump.mjs:97-102 — workspace paths are manually quoted inside execSync`

## Failure scenario / repro

Crafted repo-local state or checkout/workspace paths containing shell metacharacters escape the constructed command when a maintainer runs the corresponding script.

## Impact

Opening a prepared checkout or consuming tampered local state can execute commands under maintainer credentials. Exposure is local/developer-facing.

## Suggested fix

Use spawnSync/execFileSync with argument arrays and -- separators, plus field validation as defense in depth.

## Tests

- Capture argv with a fake executable and exercise spaces, quotes, semicolons, backticks, and dollar syntax without a shell

## Dedupe notes

No exact item in #303 or the current tracker.


> Closed by ticket-fleet sync: scripts/sandbox.ts uses spawnSync argument arrays and validates state fields with SAFE_RESOURCE. scripts/bump.mjs uses execFileSync("git", ["add", "--", ...paths]) and expands paths in-process. scripts/sandbox.test.ts and scripts/bump.test.mjs capture argv and cover spaces, quotes, semicolons, backticks, and dollar syntax. Both tests passed: 30 pass, 0 fail.
