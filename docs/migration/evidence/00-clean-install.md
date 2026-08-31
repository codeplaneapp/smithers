# Phase 7 gate: clean-install

Verdict: PASS

Both frozen installs exit 0 from a fresh shared clone of `v1/rc0-migration` at
`cd14388ed782aac6e5f5b23d66c8fa9dc01dd6ba`, the offline verification re-runs
exit 0, and no install changes a tracked file. One soft postinstall step
(`apps/ui` Electrobun devkit projection) did not complete because a concurrent
`electrobun dev` in the source tree holds Hutch's release locks; see
"Follow-up for downstream gates".

This file supersedes the 2026-08-30 23:56 PT evidence taken at `20b32c6316` in
`migration/clean-checkout-2` (that directory no longer exists). The superseded
file is kept beside this one as `00-clean-install-prev-20b32c6316.md` with its
logs in `00-clean-install-logs-prev-20b32c6316/`.

## Environment

| Item | Value |
| --- | --- |
| Host | macOS 26.2 (build 25C56), Darwin 25.2.0, arm64 |
| Date | 2026-08-31 11:53 to 11:57 UTC (2026-08-31 04:53 to 04:57 PT) |
| git | 2.50.1 (Apple Git-155) |
| Node | v24.18.0 (`/Users/williamcory/.nvm/versions/node/v24.18.0/bin/node`); rc-contract section 1 floor is `>=22.19.0`, CI pins 22.19.0 |
| corepack | 0.35.0 |
| pnpm | 11.21.0, selected by corepack from `packageManager: pnpm@11.21.0`; store `/Users/williamcory/Library/pnpm/store/v11` |
| Bun | 1.4.0-canary.1+6618e7f7e (`bun --version` prints `1.4.0`); root `engines.bun` is `>=1.3.0`, CI pins 1.3.14 |
| hutch-engine (Electrobun 2.0.1 pairing) | `~/.hutch/npm/electrobun/2.0.1/macos-arm64/bin/hutch-engine` |
| Host load at run time | load averages 3.94 4.98 5.13, 7 users, up 1 day 7:53 |
| Free disk | 13 GiB before, 12 GiB after; the checkout occupies 2.7 GiB (2.4 GiB `node_modules`, hardlinked from the pnpm store) |

`SMITHERS_HOME` was unset in the calling shell and was additionally stripped
from every pnpm and bun invocation (`env -u SMITHERS_HOME`) so a host setting
cannot leak into the measurement.

## Checkout

Target: `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-4`
(written as `<clean-checkout-4>` below). No stale directory existed at that
path, so nothing was removed. `mkdir -p .../migration/phase7` exited 0 (the
directory already existed).

| Command | Exit | Result |
| --- | --- | --- |
| `git clone --shared /Users/williamcory/smithers <clean-checkout-4>` | 0 | `done.`; 4773 files checked out; `.git/objects/info/alternates` = `/Users/williamcory/smithers/.git/objects`; `.git` is 169 MiB |
| `git -C <clean-checkout-4> checkout v1/rc0-migration` | 0 | `Already on 'v1/rc0-migration'`, `Your branch is up to date with 'origin/v1/rc0-migration'` |
| `git -C <clean-checkout-4> submodule update --init` | 0 | `vendor/jj` registered from `https://github.com/smithersai/jj.git` and checked out at `47589ada70c12b3e829b5c98ab32503abad49eac` (`v0.25.0-3759-g47589ada7`) |

The three commands ran from 11:53:03 to 11:53:10 UTC.

HEAD: `cd14388ed782aac6e5f5b23d66c8fa9dc01dd6ba`, `chore(wave-6): regenerate
known-files.d.ts for the two landed lanes` (2026-08-31 04:08:04 -0700). It
equals `v1/rc0-migration` in `/Users/williamcory/smithers` (`git rev-parse`
of both printed the same hash). `git status --porcelain` was empty before the
installs. The submodule working tree was clean (`git -C vendor/jj status
--porcelain` printed nothing).

Lockfile digests before the installs (SHA-256), equal to the blobs committed at
`cd14388ed7` (`git show cd14388ed7:<file> | shasum -a 256` in the source repo):

```
8f43cd866140dae5f78bbc63494ad90cf28ca476e66be962109ec67a9f18c7e9  pnpm-lock.yaml  (910667 bytes, 25530 lines)
797e2790983797f66250352a3e12e9c63aa51e1d386936da721712f03846f1bf  bun.lock        (686431 bytes, 6841 lines)
```

Root manifest: `packageManager: pnpm@11.21.0`, `engines.node >=22.19.0`,
`engines.bun >=1.3.0`. `pnpm-workspace.yaml` lists `packages/*`,
`packages/build/infra`, `e2e`, `examples`, `apps/*` in that order, which is the
rc-contract section 9 Workspace row. Expanding those globs against the tree
yields 63 member manifests, plus the root, which matches pnpm's
`Scope: all 64 workspace projects`.

Delta since the superseded run (`20b32c6316..cd14388ed7`, 20 commits): the only
manifest or lockfile change is `packages/testing/package.json` moving
`@effect/vitest` from `dependencies` to an optional `peerDependencies` entry
(with `vitest` also marked optional), and the matching 6-line edits in
`pnpm-lock.yaml` and `bun.lock`. Both lockfiles were regenerated in that commit;
the frozen installs below confirm they match the manifests.

## Frozen installs

All commands ran from `<clean-checkout-4>`.

| Command | Exit | Final lines |
| --- | --- | --- |
| `corepack pnpm install --frozen-lockfile` (network allowed, first run, 11:53:42 to 11:56:29 UTC) | 0 | `Scope: all 64 workspace projects`; `Lockfile is up to date, resolution step is skipped`; `Packages: +1799`; `Progress: resolved 1799, reused 1789, downloaded 0, added 1799, done`; `apps/ui postinstall: Done`; `Done in 2m 46.6s using pnpm v11.21.0` |
| `bun install --frozen-lockfile --lockfile-only` (first run, 11:56:44 UTC) | 0 | `bun install v1.4.0-canary.1 (6618e7f7e)`; `Resolved, downloaded and extracted [18]`; `Saved lockfile`; `Saved bun.lock (2177 packages) [221.00ms]` |
| `corepack pnpm install --frozen-lockfile --offline` (verification re-run) | 0 | `Scope: all 64 workspace projects`; `Already up to date`; `Done in 289ms using pnpm v11.21.0` |
| `bun install --frozen-lockfile --offline --lockfile-only` (verification re-run) | 0 | `Resolved, downloaded and extracted [0]`; `Saved bun.lock (2177 packages) [36.00ms]` |

Of the 2m 46.6s pnpm wall time, about 2m 05s was the `apps/ui` postinstall
waiting on a Hutch lock (diagnosed below); the package linking itself finished
in under 45 s with `downloaded 0` because every tarball was already in the
local pnpm store.

Lockfile digests after every install are byte-identical to the digests above.
`git status --porcelain` printed nothing after the pnpm install, after the bun
install, and after both verification re-runs. Both lockfiles are
frozen-consistent with the manifests at `cd14388ed7`.

Post-install sanity readings from `<clean-checkout-4>`:

| Check | Value |
| --- | --- |
| `node_modules/effect/package.json` version | `4.0.0-rc.108` (rc-contract section 9 Effect row) |
| `node_modules/typescript/package.json` version | `6.0.3` (rc-contract section 9 TypeScript row) |
| `packages/cli/bin/smithers.mjs` | present; runs `src/bin.ts` because no `dist/` exists yet |
| Root `node_modules/.bin` entries | 8 |
| `bun.lock` package count | 2177, unchanged from the superseded run (2174 in the Phase 2 baseline; the file is unchanged by the install, so the count is a property of the committed lockfile) |
| Untracked ignored paths at the top level, excluding `node_modules` | `apps/ui/.hutch/` only (`dependencies.lock` and `locks/`, written by the postinstall attempt; the directory is gitignored) |

## Warnings printed by the installs

1. `[WARN] There are cyclic workspace dependencies: <clean-checkout-4>/packages/kernel, <clean-checkout-4>/packages/platform-browser`.
   Both edges are runtime `dependencies`: `packages/kernel/package.json:92`
   depends on `@smthrs/platform-browser@1.0.0-rc.0` and
   `packages/platform-browser/package.json:100` depends on
   `@smthrs/kernel@1.0.0-rc.0`. Both edges arrived with the wholesale import at
   `378c182a75` (flows `393253c2b`) and were present at `9c464343f0` and
   `20b32c6316`. pnpm installs through the cycle. This is not a clean-install
   failure; it is input for the dependency-cycle gate
   (`dependency-cycles-names.md`), which measures module-level cycles per
   package with madge and does not see a package-level cycle.
2. `[WARN] Failed to create bin at <clean-checkout-4>/packages/cli/node_modules/.bin/smithers-migrate. ENOENT ... packages/migrate/dist/esm/flow/bin.js`
   (printed twice, once for the workspace link and once for the
   `@smthrs/migrate` link under `packages/cli/node_modules`).
   `packages/migrate/package.json` declares
   `"bin": {"smithers-migrate": "./dist/esm/flow/bin.js"}` and
   `packages/cli/package.json:102` depends on `@smthrs/migrate`. `dist/` does
   not exist before the build step. Same warning as both superseded runs; pnpm
   links the bin after `dist/` exists.
3. `apps/ui postinstall: ensure-devkit: electrobun prepare exited by signal (continuing; run \`pnpm exec electrobun prepare\` in apps/ui)`.
   Diagnosed below.
4. pnpm printed `✓ Lockfile passes supply-chain policies (verified 2h ago)`,
   the cached result of its supply-chain check, and did not print an
   update banner this run.

## Diagnosis: `apps/ui` devkit projection

`apps/ui/scripts/ensure-devkit.mjs --soft` runs as `postinstall`
(`apps/ui/package.json:7`), spawns
`node_modules/electrobun/bin/electrobun.cjs prepare`, and on `--soft` exits 0
after printing a warning when the child fails. The child was terminated by a
signal, so `<clean-checkout-4>/apps/ui/.hutch/devkit` does not exist
(`projection.json` reads `ABSENT` in the verification log). `apps/ui`
`tsconfig.json` extends the projected tsconfig and `vite.config.ts` imports the
projected Vite aliases, so `apps/ui` typecheck, build, and start in this
checkout fail until `pnpm exec electrobun prepare` succeeds there.

Measurements taken while the postinstall was waiting (`05-postinstall-observe.log`,
11:54:44 UTC, 18 s into the wait):

- Process tree of the postinstall: `node scripts/ensure-devkit.mjs --soft`
  (PID 76867) -> `node .../electrobun.cjs prepare` (PID 76873) ->
  `hutch-engine electrobun prepare` (PID 76877). `lsof -p 76877` showed it
  holding `~/.hutch/state/locks/graph.lock`, the Cottontail 0.5.0 release lock,
  and `<clean-checkout-4>/apps/ui/.hutch/locks/electrobun-build.lock`. It had
  not opened the Electrobun 2.0.1 release lock.
- A `pnpm run start` launched at about 00:45 PT from
  `/Users/williamcory/smithers/apps/ui` is still running (elapsed 4h10m at
  observation time): `sh -c node scripts/ensure-devkit.mjs && vite build
  --configLoader runner && electrobun dev` (PID 33164) ->
  `node .../electrobun.cjs dev` (PID 33196) -> `hutch-engine electrobun dev`
  (PID 33202). `lsof -p 33202` shows it holding
  `~/.hutch/releases/electrobun/2.0.1/macos-arm64.lock` and
  `~/.hutch/releases/cottontail/0.5.0/e5660061b8e64b5ea044799da8518780a9987391/macos-arm64.lock`.
- A non-blocking `flock` probe (Python `fcntl`, `LOCK_NB`, released
  immediately) reports the Electrobun 2.0.1 release lock, the Cottontail
  release lock, and `graph.lock` all as `SHARED-HELD`: a shared lock is
  granted, an exclusive lock returns `EWOULDBLOCK`.
- The `prepare` engine ran from 11:54:26 to about 11:56:28 UTC (2m 02s) and
  was then terminated by a signal; the shim reported `exited by signal` and
  the postinstall continued.

Conclusion: `electrobun prepare` needs an exclusive lock on a Hutch release
that the concurrent `electrobun dev` from `/Users/williamcory/smithers/apps/ui`
holds shared, and the engine terminates the waiting `prepare` after about
two minutes. The condition is environmental to this host at this time and is
the same condition the superseded `20b32c6316` run recorded. The rc-contract
section 9 CI install form, `pnpm install --frozen-lockfile --ignore-scripts`,
never runs this postinstall, so CI does not depend on it. This session did not
touch the source tree's `electrobun dev` process.

## Follow-up for downstream gates

- Before any gate that typechecks, builds, or starts `apps/ui` in
  `<clean-checkout-4>`, run `pnpm --dir apps/ui exec electrobun prepare` once
  the source tree's `electrobun dev` (PID 33202 tree, `pnpm run start`
  PID 33164) has exited, and confirm `apps/ui/.hutch/devkit/projection.json`
  reports `product.version` `2.0.1`. Until then, an `apps/ui` failure that
  names `.hutch/devkit` is this environmental condition, not a repository
  defect.
- Carry the `kernel` <-> `platform-browser` runtime dependency cycle into the
  dependency-cycle gate's evidence. It predates rc.0 work (import commit
  `378c182a75`), and no rc-contract row rules on package-level cycles.
- `smithers-migrate` has no bin link until `packages/migrate` is built. Gates
  that invoke it by bin name must build first or call
  `packages/migrate/src/flow/bin.ts` through the working-tree CLI.

## Raw logs

`00-clean-install-logs/` beside this file:
`01-clone.log`, `02-pre-install.log`, `03-pnpm-install.log` (+ `.exit`),
`04-bun-install.log` (+ `.exit`), `05-postinstall-observe.log`, `06-verify.log`.

## Verdict

PASS. Clean shared clone of `v1/rc0-migration` at `cd14388ed7`, submodule
initialized, `corepack pnpm install --frozen-lockfile` and
`bun install --frozen-lockfile --lockfile-only` both exit 0 online and both
exit 0 on the offline verification re-run, and every tracked file, including
both lockfiles, is byte-identical afterward. The `apps/ui` devkit projection is
an environmental soft-postinstall skip with a recorded remedy, not an install
failure.
