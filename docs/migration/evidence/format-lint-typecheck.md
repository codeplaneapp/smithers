# Phase 7 gate: format-lint-typecheck

Verdict: PASS

## Environment

| Item | Value |
| --- | --- |
| Host | macOS 26.2 (25C56), arm64 |
| Node | v24.18.0 |
| Bun | 1.4.0 (`bun --version`; canary 1.4.0-canary.1+6618e7f7e) |
| corepack | 0.35.0 |
| pnpm (via corepack, `packageManager: pnpm@11.21.0`) | 11.21.0 |
| Date | 2026-08-30 |

## Checkout

Clean checkout at `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout`, HEAD `9c464343f0cfada6aa36f0a08144ed7cf1f0ce14` on `v1/rc0-migration`. `git status --porcelain` was empty before the gate. Dependencies were installed by the clean-install gate (`00-clean-install.md`).

## What the gate covers

The root `package.json` defines `check` as `pnpm --recursive --if-present run check` and `lint` as `pnpm --recursive --if-present run lint`. Per rc-contract §9, the formatter is dprint per package: every package `lint` script is `eslint src --max-warnings=0 && dprint check`, so the formatting check runs inside the lint pass and there is no separate root format script. The workspace has 63 projects; `-r` recurses into 62 (the private root is excluded). Members without a script are skipped by `--if-present`:

- No `check` script (4): `apps/bug-worker`, `apps/status-site`, `packages/ui`, `packages/ui-styleguide`. 62 - 4 = 58 projects typechecked.
- No `lint` script (11): `apps/bug-worker`, `apps/review`, `apps/server`, `apps/shared`, `apps/status-site`, `apps/tui`, `apps/ui`, `examples`, `packages/build/infra`, `packages/ui`, `packages/ui-styleguide`. 62 - 11 = 51 projects linted.

This skip set matches the Phase 2 baseline method (`phase2-baseline.md` ran the same root scripts). The `lint/BUILD.ts` LLM lint targets are diff-driven codex reviews, not part of this gate.

## Commands and results

Run from the clean checkout root.

| Command | Exit | Result |
| --- | --- | --- |
| `corepack pnpm -r --no-bail --if-present run check` | 0 | `Scope: 62 of 63 workspace projects`; 58 packages print `check: Done`; final line `packages/cli check: Done`; zero `error TS` or `ELIFECYCLE` lines |
| `corepack pnpm -r --no-bail --if-present run lint` | 0 | `Scope: 62 of 63 workspace projects`; 51 packages print `lint: Done`; final line `packages/build-cli lint: Done`; zero eslint problems, zero dprint findings |

Per-package `check` is `tsc -b tsconfig.json && tsc -p tsconfig.test.json --noEmit` (variants: `apps/ui` runs `ensure-devkit.mjs && tsc --noEmit`, `examples` runs `tsc -p tsconfig.json --noEmit`). Per-package `lint` is `eslint src --max-warnings=0 && dprint check`.

Full logs: `/private/tmp/claude-501/-Users-williamcory-smithers/b0a4ab15-ceef-429c-8898-089a3db0bc0d/scratchpad/p7-check.log` (117 lines) and `p7-lint.log` (104 lines).

## Post-run tree state

`git status --porcelain` is empty after both runs. `tsc -b` writes only into per-package `dist/` build output, which is git-ignored; `dprint check` and `eslint` (no `--fix`) mutate nothing. The checkout remains byte-identical to `9c464343f0` for tracked files.

## Notes

- One benign log line: `packages/build lint: Multiple projects found, consider using a single tsconfig with references ... noWarnOnMultipleProjects`. This is a typescript-eslint projectService performance note, not a lint warning; the package still exits 0 under `--max-warnings=0`.
- The Phase 2 baseline recorded the same two commands green at `b8af974334` across 53 packages; this run covers the wider post-Phase-6 workspace (58 checked, 51 linted) including `packages/migrate`.

## Verdict

PASS. Typecheck exits 0 across all 58 members with a `check` script, and the combined eslint plus dprint formatting pass exits 0 across all 51 members with a `lint` script, from the clean checkout at `9c464343f0` with no working-tree drift.
