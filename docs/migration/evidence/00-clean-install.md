# Phase 7 gate: clean-install

Verdict: PASS

Both frozen installs exit 0 from a fresh shared clone of `v1/rc0-migration` at
`20b32c6316487497301db74ec70cbe951428ef53`, and neither install changes a
tracked file. One soft postinstall step (`apps/ui` Electrobun devkit
projection) did not complete because a concurrent `electrobun dev` in the
source tree holds Hutch's release locks; see "Follow-up for downstream gates".

This file supersedes the 2026-08-30 15:47 evidence taken at `9c464343f0` in
`migration/clean-checkout` (that directory no longer exists).

## Environment

| Item | Value |
| --- | --- |
| Host | macOS 26.2 (build 25C56), Darwin 25.2.0, arm64 |
| Date | 2026-08-31 06:44 to 06:55 UTC (2026-08-30 23:44 to 23:55 PT) |
| git | 2.50.1 (Apple Git-155) |
| Node | v24.18.0 (`/Users/williamcory/.nvm/versions/node/v24.18.0/bin/node`); rc-contract floor is `>=22.19.0`, CI pins 22.19.0 |
| corepack | 0.35.0 |
| pnpm | 11.21.0, selected by corepack from `packageManager: pnpm@11.21.0`; store `/Users/williamcory/Library/pnpm/store/v11` |
| Bun | 1.4.0-canary.1+6618e7f7e (`bun --version` prints `1.4.0`) |
| hutch-engine (Electrobun 2.0.1 pairing) | 0.24.3 at `~/.hutch/npm/electrobun/2.0.1/macos-arm64/bin/hutch-engine` |
| Host load at run time | load averages 2.74 3.34 4.60, 7 users |
| Free disk after install | 16 GiB; the checkout occupies 2.7 GiB (2.4 GiB `node_modules`, hardlinked from the pnpm store) |

`SMITHERS_HOME` was unset for every pnpm and bun invocation
(`env -u SMITHERS_HOME`) so a host setting cannot leak into the measurement.

## Checkout

Target: `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-2`
(written as `<clean-checkout-2>` below). No stale directory existed at that path,
so nothing was removed. `mkdir -p .../migration/phase7` exited 0.

| Command | Exit | Result |
| --- | --- | --- |
| `git clone --shared /Users/williamcory/smithers <clean-checkout-2>` | 0 | `done.`; 4760 files checked out |
| `git -C <clean-checkout-2> checkout v1/rc0-migration` | 0 | `Already on 'v1/rc0-migration'`, `Your branch is up to date with 'origin/v1/rc0-migration'` |
| `git -C <clean-checkout-2> submodule update --init` | 0 | `vendor/jj` cloned from `https://github.com/smithersai/jj.git`, checked out at `47589ada70c12b3e829b5c98ab32503abad49eac` (`v0.25.0-3759-g47589ada7`) |

HEAD: `20b32c6316487497301db74ec70cbe951428ef53`, `feat(ui): onboarding, sidebar
repos and agent roles, targets table, pattern runs, slash tree, verbose`
(2026-08-30 23:33:28 -0700). It equals `v1/rc0-migration` in
`/Users/williamcory/smithers`. `git status --porcelain` was empty before the
installs. The submodule working tree was clean.

Lockfile digests before the installs (SHA-256):

```
7e601dbc5e14a1085e38ca11d8ca1978f05a23b6060cd449c09268a5e0736335  pnpm-lock.yaml  (910667 bytes, 25530 lines)
a90a105e5d35c081d53b75e81aaf81e2f6c424fb183324b4aa716b845fb664d0  bun.lock        (686353 bytes, 6837 lines)
```

## Frozen installs

All commands ran from `<clean-checkout-2>`.

| Command | Exit | Final lines |
| --- | --- | --- |
| `corepack pnpm install --frozen-lockfile` (network allowed, first run) | 0 | `Scope: all 64 workspace projects`; `Lockfile is up to date, resolution step is skipped`; `Progress: resolved 1799, reused 1789, downloaded 0, added 1799, done`; `Done in 2m 36.7s using pnpm v11.21.0` |
| `bun install --frozen-lockfile --lockfile-only` (first run) | 0 | `bun install v1.4.0-canary.1 (6618e7f7e)`; `Resolved, downloaded and extracted [18]`; `Saved bun.lock (2177 packages) [237.00ms]` |
| `corepack pnpm install --frozen-lockfile --offline` (verification re-run) | 0 | `Scope: all 64 workspace projects`; `Already up to date`; `Done in 272ms using pnpm v11.21.0` |
| `bun install --frozen-lockfile --offline --lockfile-only` (verification re-run) | 0 | `Resolved, downloaded and extracted [0]`; `Saved bun.lock (2177 packages) [36.00ms]` |

Lockfile digests after every install are byte-identical to the digests above,
and `git status --porcelain` is empty after each command. Both lockfiles are
frozen-consistent with the manifests at `20b32c6316`.

The 64 workspace projects are the root `smithers@0.0.0` plus 63 members
(`packages/*` including `packages/build/infra`, `apps/*`, `e2e`, `examples`).
`git ls-tree` shows the same 63 member `package.json` paths at `9c464343f0` and
at this HEAD, so the count did not move since the superseded run. `bun.lock`
reports 2177 packages (2176 in the superseded run, 2174 in the Phase 2
baseline); the file itself is unchanged by the install, so the difference is
the package count of the committed lockfile, not drift.

## Warnings printed by the installs

1. `[WARN] There are cyclic workspace dependencies: <clean-checkout-2>/packages/kernel, <clean-checkout-2>/packages/platform-browser`.
   Both edges are runtime `dependencies`, not devDependencies:
   `packages/kernel/package.json` depends on `@smthrs/platform-browser@1.0.0-rc.0`
   (imported by `packages/kernel/src/test/TestHost.ts`, the
   `@smthrs/kernel/test/TestHost` entry) and
   `packages/platform-browser/package.json` depends on `@smthrs/kernel@1.0.0-rc.0`
   (imported by `src/BrowserChildProcessSpawner/make.ts` and
   `src/BrowserFileSystem/layer.ts`). Both edges arrived with the wholesale
   import at `378c182a75` (flows `393253c2b`) and were present at `9c464343f0`.
   pnpm installs through the cycle. This is not a clean-install failure; it is
   input for the dependency-cycle gate, which today measures module-level
   cycles per package with madge and does not see a package-level cycle.
2. `[WARN] Failed to create bin at <clean-checkout-2>/packages/cli/node_modules/.bin/smithers-migrate. ENOENT ... packages/migrate/dist/esm/flow/bin.js`
   (printed twice). The `@smthrs/migrate` bin lives under `dist/`, which does
   not exist before the build step. Same warning as the superseded run; pnpm
   links the bin after `dist/` exists.
3. `apps/ui postinstall: ensure-devkit: electrobun prepare exited by signal (continuing; run \`pnpm exec electrobun prepare\` in apps/ui)`.
   Diagnosed below.
4. pnpm printed its `Update available! 11.21.0 -> 11.24.0` banner. The
   `packageManager` pin selects 11.21.0, which is the rc-contract section 9
   baseline; no action.

## Diagnosis: `apps/ui` devkit projection

`apps/ui/scripts/ensure-devkit.mjs --soft` runs as `postinstall`, spawns
`node_modules/electrobun/bin/electrobun.cjs prepare`, and on `--soft` exits 0
after printing a warning when the child fails. The child failed, so
`<clean-checkout-2>/apps/ui/.hutch/devkit` does not exist. `apps/ui`
`tsconfig.json` extends the projected tsconfig and `vite.config.ts` imports the
projected Vite aliases, so `apps/ui` typecheck, build, and start in this
checkout fail until `pnpm exec electrobun prepare` succeeds there.

Measurements:

- A direct re-run, `node node_modules/electrobun/bin/electrobun.cjs prepare`
  in `<clean-checkout-2>/apps/ui`, wrapped in `spawnSync` with a 240 s
  timeout, ended with `status=null signal=SIGTERM` after 154662 ms and
  produced no stdout and no stderr. The node shim's own timeouts are 15 s
  (`cacheLockTimeoutMs`, `hutchVersionProbeTimeoutMs`) and 30 s
  (`downloadTimeoutMs`) and raise errors rather than signals, so the
  termination comes from inside the Hutch engine's lock wait, not from the
  shim and not from this session.
- A `pnpm run start` launched at 23:33:36 PT from `/Users/williamcory/smithers/apps/ui`
  (PID 64705, parent PID 1) is still running:
  `sh -c node scripts/ensure-devkit.mjs && vite build --configLoader runner && electrobun dev`
  (PID 65025) -> `node .../electrobun.cjs dev` (PID 66063) ->
  `hutch-engine electrobun dev` (PID 66138). `lsof -p 66138` shows it holding
  `~/.hutch/releases/electrobun/2.0.1/macos-arm64.lock`,
  `~/.hutch/releases/cottontail/0.5.0/e5660061b8e64b5ea044799da8518780a9987391/macos-arm64.lock`,
  and a reader lease under the source tree's `apps/ui/.hutch/locks/electrobun-readers/`.
- A non-blocking `flock` probe (Python `fcntl`, `LOCK_NB`, released
  immediately) reports both release locks as `SHARED-HELD`: a shared lock is
  granted, an exclusive lock returns `EWOULDBLOCK`. `~/.hutch/state/locks/graph.lock`,
  the Bun toolchain lock, and both projects' `electrobun-build.lock` files are
  free.
- A second observed `prepare`, sampled 20 s after start, had opened
  `graph.lock`, the Cottontail release lock, and `<clean-checkout-2>/apps/ui/.hutch/locks/electrobun-build.lock`,
  had spawned nothing, and had printed nothing. It never reached the
  Electrobun 2.0.1 release lock. That observed process was killed by this
  session (`kill -INT`, then `kill -TERM`, own PIDs 9148 and 9151 only); the
  source tree's `electrobun dev` was not touched.

Conclusion: `electrobun prepare` needs an exclusive lock on a Hutch release
that the concurrent `electrobun dev` from `/Users/williamcory/smithers/apps/ui`
holds shared, and the engine terminates the waiting `prepare` after about
150 s. The condition is environmental to this host at this time. The
superseded run at 15:47 completed the projection because no `electrobun dev`
was running then. The rc-contract section 9 CI install form,
`pnpm install --frozen-lockfile --ignore-scripts`, never runs this postinstall,
so CI does not depend on it.

## Follow-up for downstream gates

- Before any gate that typechecks, builds, or starts `apps/ui` in
  `<clean-checkout-2>`, run `pnpm --dir apps/ui exec electrobun prepare` once
  the source tree's `electrobun dev` (PID 66138 tree, `pnpm run start` PID 64705)
  has exited, and confirm `apps/ui/.hutch/devkit/projection.json` reports
  `product.version` `2.0.1`. Until then, an `apps/ui` failure that names
  `.hutch/devkit` is this environmental condition, not a repository defect.
- Carry the `kernel` <-> `platform-browser` runtime dependency cycle into the
  dependency-cycle gate's evidence. It predates rc.0 work (import commit
  `378c182a75`), and no rc-contract row rules on package-level cycles.

## Raw logs

`00-clean-install-logs/` beside this file:
`01-clone.log`, `02-pre-install.log`, `03-pnpm-install.log`,
`04-bun-install.log`, `05-electrobun-prepare.log`, `06-verify.log`,
`07-prepare-observe.out` (empty: the observed `prepare` printed nothing).

## Verdict

PASS. Clean shared clone of `v1/rc0-migration` at `20b32c6316`, submodule
initialized, `corepack pnpm install --frozen-lockfile` and
`bun install --frozen-lockfile --lockfile-only` both exit 0 online and offline,
and every tracked file, including both lockfiles, is byte-identical
afterward. The `apps/ui` devkit projection is an environmental soft-postinstall
skip with a recorded remedy, not an install failure.
