# Phase 7 gate: clean-install

Verdict: PASS

## Environment

| Item | Value |
| --- | --- |
| Host | macOS 26.2, arm64 |
| Node | v24.18.0 |
| Bun | 1.4.0-canary.1+6618e7f7e (`bun --version` prints 1.4.0) |
| corepack | 0.35.0 |
| pnpm (via corepack, from `packageManager: pnpm@11.21.0`) | 11.21.0 |
| Date | 2026-08-30 |

## Checkout

No stale checkout existed at the target path, so nothing was removed.

| Command | Exit | Result |
| --- | --- | --- |
| `git clone --shared /Users/williamcory/smithers /Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout` | 0 | `done.` |
| `git -C <clean-checkout> checkout v1/rc0-migration` | 0 | `Already on 'v1/rc0-migration'` (the clone's default branch), up to date with `origin/v1/rc0-migration` |
| `git -C <clean-checkout> submodule update --init` | 0 | `vendor/jj` cloned from https://github.com/smithersai/jj.git and checked out at `47589ada70c12b3e829b5c98ab32503abad49eac` (v0.25.0-3759-g47589ada7) |

HEAD: `9c464343f0cfada6aa36f0a08144ed7cf1f0ce14` — `fix(release): version @smthrs/evals at 1.0.0-rc.0 so the examples pin and the release-version gate agree`.

## Frozen installs

Run from the clean checkout root. Both lockfiles are present (`pnpm-lock.yaml`, `bun.lock`).

| Command | Exit | Final lines |
| --- | --- | --- |
| `corepack pnpm install --frozen-lockfile` (network allowed, first run) | 0 | `Done in 26.8s using pnpm v11.21.0`; 63 workspace projects |
| `corepack pnpm install --frozen-lockfile` (verification re-run) | 0 | `Already up to date` / `Done in 292ms using pnpm v11.21.0` |
| `bun install --frozen-lockfile --lockfile-only` | 0 | `Saved bun.lock (2176 packages) [64.00ms]` under `bun install v1.4.0-canary.1 (6618e7f7e)` |

`git status --porcelain` is empty after both installs: neither install modified `pnpm-lock.yaml`, `bun.lock`, or any tracked file, so both lockfiles are frozen-consistent with the manifests at `9c464343f0`.

## Notes

- The first pnpm install printed one warning: `[WARN] Failed to create bin at packages/cli/node_modules/.bin/smithers-migrate. ENOENT ... @smthrs/migrate/dist/esm/flow/bin.js`. The `@smthrs/migrate` bin target lives under `dist/`, which does not exist before the build step. This is expected in a pre-build checkout and does not affect the install exit code; the build gate produces `dist/` and pnpm relinks bins on demand.
- `apps/ui` postinstall (`ensure-devkit.mjs --soft`, electrobun prepare) completed inside the clean checkout.
- Phase 2 baseline recorded `bun.lock (2174 packages)`; this reading is 2176 because Phase 6 added `@smthrs/migrate` and its closure after that snapshot. The bun.lock file itself is unchanged by the install, so this is a package-count report difference, not drift.

## Verdict

PASS. Clean shared clone at `v1/rc0-migration` (`9c464343f0`), submodule initialized, both frozen installs exit 0, and the working tree stays byte-identical afterward.
