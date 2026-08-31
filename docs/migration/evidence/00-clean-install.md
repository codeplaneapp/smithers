# Phase 7 gate: clean-install

Verdict: PASS

Validated commit: `341c8fa87e2dadbe80d0f0d3258dae112a7d03d3` (`v1/rc0-migration`,
`docs(release): consumer overrides note and the browser-contract list's new
home`, 2026-08-31 09:12:47 -0700).

This file supersedes the run at `cd14388ed7` from this same checkout
(`migration/clean-checkout-4`). That run's full evidence is kept beside this
file as `00-clean-install-prev-cd14388ed7.md` with its logs in
`00-clean-install-logs/`. This run's logs are in
`00-clean-install-logs-rerun-341c8fa87e/`. Everything from the superseded run
that still applies is restated below; the one material change is that the
`apps/ui` Electrobun devkit projection now exists in the checkout (copied from
the source tree, verified byte-identical), where the cd14388ed7 run recorded it
absent.

## Environment

| Item | Value |
| --- | --- |
| Host | macOS 26.2 (build 25C56), Darwin 25.2.0, arm64 |
| Date | 2026-08-31 16:14 to 16:15 UTC (09:14 to 09:15 PT) |
| git | 2.50.1 (Apple Git-155) |
| Node | v24.18.0; rc-contract section 1 floor is `>=22.19.0`, CI pins 22.19.0 |
| corepack | 0.35.0 |
| pnpm | 11.21.0, selected by corepack from `packageManager: pnpm@11.21.0` |
| Bun | 1.4.0-canary.1+6618e7f7e (`bun --version` prints `1.4.0`); root `engines.bun` is `>=1.3.0`, CI pins 1.3.14 |
| hutch-engine (Electrobun 2.0.1 pairing) | `~/.hutch/npm/electrobun/2.0.1/macos-arm64/bin/hutch-engine` |
| Host load at run time | load averages 3.56 4.57 5.59, 8 users, up 1 day 12:15 |
| Free disk | 12 GiB after the run |

`SMITHERS_HOME` was stripped from the pnpm and bun invocations
(`env -u SMITHERS_HOME`) so a host setting cannot leak into the measurement.

## Checkout move

The checkout is the shared clone the cd14388ed7 run created:
`git clone --shared /Users/williamcory/smithers <clean-checkout-4>` with
`.git/objects/info/alternates` pointing at the source repository's object
store. This run moved it forward instead of recloning.

| Command | Exit | Result |
| --- | --- | --- |
| `git -C <clean-checkout-4> status --short` (before the move) | 0 | Empty. No tracked file was modified; nothing needed `git checkout -- <paths>` |
| `git -C <clean-checkout-4> fetch /Users/williamcory/smithers v1/rc0-migration` | 0 | `* branch v1/rc0-migration -> FETCH_HEAD` |
| `git -C <clean-checkout-4> checkout --detach 341c8fa87e` | 0 | `HEAD is now at 341c8fa87e ...` |
| `git -C <clean-checkout-4> submodule update --init` | 0 | No output; `vendor/jj` already at `47589ada70c12b3e829b5c98ab32503abad49eac` (`v0.25.0-3759-g47589ada7`), the same pin the cd14388ed7 run recorded |
| `git -C <clean-checkout-4> rev-parse --short HEAD` | 0 | `341c8fa87e` |

Delta from cd14388ed7 to 341c8fa87e is 15 commits (waves 7 and 8 plus the
release-docs refresh). The only manifest changes are one added `files` entry
each in `packages/memory/package.json` (`"src/**/*.sql"`) and
`packages/smthrs-deprecation/package.json` (`"dist/**/package.json"`), the
polish-2 pack fixes. Neither lockfile changed: SHA-256 digests are identical to
the cd14388ed7 run before and after this run's installs:

```
8f43cd866140dae5f78bbc63494ad90cf28ca476e66be962109ec67a9f18c7e9  pnpm-lock.yaml
797e2790983797f66250352a3e12e9c63aa51e1d386936da721712f03846f1bf  bun.lock
```

Stale build products of cd14388ed7 were removed before the installs so no gate
runs an old build: `docs/dist`, all 51 `packages/*/dist` directories,
`apps/ui/dist` (7.4 MiB vite output), and the three
`packages/build/infra/tsconfig.*.tsbuildinfo` incremental caches. After
removal, zero `dist` directories and zero tracked-tree `*.tsbuildinfo` files
remain outside `node_modules`.

## Frozen installs

All commands ran from `<clean-checkout-4>`.

| Command | Exit | Final lines |
| --- | --- | --- |
| `env -u SMITHERS_HOME corepack pnpm install --frozen-lockfile --offline` (16:14:56 UTC) | 0 | `Scope: all 64 workspace projects`; `Already up to date`; `Done in 332ms using pnpm v11.21.0` |
| `env -u SMITHERS_HOME bun install --frozen-lockfile --offline --lockfile-only` (16:15:04 UTC) | 0 | `bun install v1.4.0-canary.1 (6618e7f7e)`; `Resolved, downloaded and extracted [18]`; `Saved lockfile`; `Saved bun.lock (2177 packages) [246.00ms]` |

The pnpm install completed in 332ms as `Already up to date`: the
`node_modules` tree from the cd14388ed7 full install (2m 46.6s, `+1799`
packages, recorded in the superseded file) is still consistent because the
dependency graph is unchanged; the two manifest edits touch only `files`
arrays, which do not affect resolution. The offline frozen run exiting 0
proves both lockfiles are frozen-consistent with the manifests at
341c8fa87e. `--offline` succeeded on the first attempt; the
ERR_PNPM_NO_OFFLINE_META fallback was not needed. Because pnpm skipped the
link step, no postinstall scripts re-ran this time; the postinstall behavior
on a full link (including the `smithers-migrate` bin warning and the
Electrobun `--soft` skip) is documented in the superseded file and still
describes what a from-scratch install does on this host.

`git status --short` after both installs is empty: no install changed a
tracked file, and both lockfile digests above are byte-identical afterward.

Post-install sanity readings:

| Check | Value |
| --- | --- |
| `node_modules/effect/package.json` version | `4.0.0-rc.108` (rc-contract section 9 Effect row) |
| `node_modules/typescript/package.json` version | `6.0.3` (rc-contract section 9 TypeScript row) |
| `packages/cli/bin/smithers.mjs` | present; runs `src/bin.ts` because no `dist/` exists after the stale-dist sweep |
| `bun.lock` package count | 2177, unchanged |

## `apps/ui` devkit projection (documented setup state)

`<clean-checkout-4>/apps/ui/.hutch/devkit` exists and `diff -rq` against
`/Users/williamcory/smithers/apps/ui/.hutch/devkit` exits 0: the projection is
a byte-identical copy of the source tree's devkit,
`projection.json` `product` = `{"name":"electrobun","version":"2.0.1"}`. The
copy is the documented setup for this checkout because `electrobun prepare`
cannot run here while a concurrent `electrobun dev` session on this host holds
Hutch's release locks shared; the full lock diagnosis, taken during the
cd14388ed7 run, is in `00-clean-install-prev-cd14388ed7.md` and still applies.
The directory is gitignored, so it does not affect tracked-tree cleanliness.
`apps/ui` typecheck, build, and start work against this projection; an
`apps/ui` failure naming `.hutch/devkit` would be environmental, not a
repository defect.

## Standing notes carried from the cd14388ed7 run

- pnpm warns `There are cyclic workspace dependencies: packages/kernel,
  packages/platform-browser`. Both runtime-dependency edges predate rc.0 work
  (import commit `378c182a75`); this is input for the dependency-cycle gate,
  not an install failure.
- pnpm warns it cannot create the `smithers-migrate` bin until
  `packages/migrate/dist` exists. Gates that invoke it by bin name must build
  first or call `packages/migrate/src/flow/bin.ts` through the working-tree
  CLI.
- The rc-contract section 9 CI install form is
  `pnpm install --frozen-lockfile --ignore-scripts`, so CI never depends on
  the Electrobun postinstall.

## Raw logs

`00-clean-install-logs-rerun-341c8fa87e/` beside this file:
`01-pnpm-install.log`, `02-bun-install.log`, `03-verify.log`. The cd14388ed7
full-install logs remain in `00-clean-install-logs/`.

## Verdict

PASS. The shared clone moved cleanly to `341c8fa87e` with the `vendor/jj`
submodule at its pinned commit, every stale build product of cd14388ed7 was
removed, `corepack pnpm install --frozen-lockfile --offline` and
`bun install --frozen-lockfile --offline --lockfile-only` both exit 0, no
tracked file changed, both lockfiles are byte-identical to their committed
blobs, and the Electrobun 2.0.1 devkit projection is in place as the
documented setup state.
