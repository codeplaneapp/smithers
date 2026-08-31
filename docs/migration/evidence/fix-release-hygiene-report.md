# Phase 7 lane release-hygiene, round 1

Status: done. Both verdict blockers and the low finding are closed.

Worktree `migration/wt/release-hygiene`, branch `phase7/release-hygiene`, base
`d7c5a3e503`. Node v24.18.0, corepack pnpm 11.21.0, bun 1.4.0, macOS arm64.
Three commits, no rebase, no other worktree touched.

| Commit | Subject |
| --- | --- |
| `050a30f89f` | `fix(testing)`: vitest and `@effect/vitest` become optional peers; the gate becomes a target |
| `688bc1bc2a` | `docs(release)`: the terminal credential-redaction limitation R-12 leaves shipped |
| `bd6c011ff7` | `docs(contract)`: section 9's stale counts, and the citation gate that missed them |

Both lockfiles moved, in the first commit.

---

## B5 (high): an npm consumer of the release set installs vitest

### Confirmed at the source

`packages/testing/package.json` before the fix:

```json
  "dependencies": {
    "@effect/vitest": "4.0.0-rc.108",
    ...
  },
  "peerDependencies": {
    "vitest": "^4.1.0"
  },
```

`@smthrs/kernel` declares `vitest` optional (`peerDependenciesMeta`), so
`check-npm-dedupe` puts `vitest` in the set that must be absent from a default
install. `packages/testing` declared it plain, and `@smthrs/create-app` (private,
tooling group) already had it optional. Reproduced:

```
$ node scripts/check-npm-dedupe.mjs
ok: effect@4.0.0-rc.108 (single copy)
ok: 2 optional peers absent from default install
resolved package count: 165 (budget 925)

npm dedupe check failed:
- vitest must stay out of the default install (optional peer), found:
  - node_modules/vitest
EXIT=1
```

### The mechanism, and why the stated fix alone is not enough

Making `vitest` an optional peer of `@smthrs/testing` does not remove it. npm
installs the non-optional peers of transitive dependencies, and
`@effect/vitest@4.0.0-rc.108` declares `vitest: '>=4.1.0 <5.0.0'` with no
`peerDependenciesMeta` (`pnpm-lock.yaml:5095-5099`). Measured directly, a
fixture whose only dependency is `@effect/vitest@4.0.0-rc.108`:

```
$ npm install --package-lock-only   # then read the lock
[ 'node_modules/vitest' ]
```

So `@effect/vitest` had to leave `@smthrs/testing`'s `dependencies` as well.
Both are now optional peers. Three facts made that safe rather than a
repo-wide design change:

- Every in-repo consumer of `@smthrs/testing` already carries `@effect/vitest`
  as its own devDependency (`packages/{agent,chain,create-app,evals}`), and
  `packages/testing` keeps it in `devDependencies` for its own suite.
- `scripts/smoke-release.mjs:80-162` installs every non-`@smthrs/*` peer a
  packed manifest declares, optional or not, before it imports the entry
  points. A new peer is installed by derivation, not by an edit.
- `packages/testing/src/index.ts` does not re-export `Vitest.ts`; the docs
  route callers to `@smthrs/testing/Vitest`, which is the module that imports
  both packages. The root entry the release smoke imports pulls in neither.

### Test and red run

New file `scripts/check-npm-dedupe.test.mjs`, three cells over the fixture the
script itself builds (real manifests, real tarballs, npm arborist). To make one
fixture serve both, `scripts/check-npm-dedupe.mjs` now exports
`resolveConsumerTree`, `copiesOf`, `optionalPeersOf`, and `SINGLETONS`; `main`
still prints and sets the exit code, and its output is byte-identical.

RED, captured with the fix stashed out of `packages/testing/package.json`
(`git stash push -- packages/testing/package.json`):

```
✖ keeps every optional peer out of the default install (1.110666ms)
  AssertionError [ERR_ASSERTION]: an optional peer a release manifest still pulls in through a hard dependency is not optional for a consumer:
    vitest
      - node_modules/vitest
  + actual - expected

  + [
  +   'vitest'
  + ]
  - []
```

GREEN after the fix, and the gate itself:

```
$ node scripts/check-npm-dedupe.mjs
ok: effect@4.0.0-rc.108 (single copy)
ok: 3 optional peers absent from default install
resolved package count: 97 (budget 925)
EXIT=0
```

The consumer tree drops from 165 resolved packages to 97. The Effect
single-copy half stayed green throughout.

### Fix locations

- `packages/testing/package.json`: `@effect/vitest` moves from `dependencies`
  to `peerDependencies`; `peerDependenciesMeta` marks `@effect/vitest` and
  `vitest` optional.
- `pnpm-lock.yaml` (`corepack pnpm install --offline`, 3 lines moved) and
  `bun.lock` (`bun install --lockfile-only`, 5 lines: the dependency drops, the
  peer and an `optionalPeers` array appear), same commit.
- `scripts/check-npm-dedupe.mjs`: the fixture resolver is exported.
- `scripts/BUILD.ts`: `npmDedupe` (the script, as `Smithers.entrypoint`) and
  `npmDedupeUnit` (the node:test suite), both `NodeTest`, both uncacheable
  because the resolution reads registry metadata.
- `packages/flows/test/vitestCoverageIsolation.test.ts`: the comment beside the
  root-scripts pin claimed `check:npm-dedupe` could not be a target because
  "no target in this graph is allowed to require" registry metadata. It says
  what R-35 requires and what the target costs. No assertion changed: the root
  `check:npm-dedupe` script survives as the operator alias, exactly as
  `browser` does beside `//scripts:browserContract`.
- `known-files.d.ts`: regenerated for the one new file (4665 to 4666 entries),
  idempotent on a second run.

No CI selection edit was needed. The `test` job already runs
`smithers-build test '//scripts/...'`, which is recursive, so both new targets
enter CI as declared targets and `.github/workflows/ci.yml` does not change:

```
$ corepack pnpm exec smithers-build lint '//:ci'
ok: true                                        # exit 0, no drift
```

Both targets run under their labels:

```
$ corepack pnpm exec smithers-build test '//scripts:npmDedupe'
  "//scripts:npmDedupe",NodeTest,ran,3308.130792   ok: true
$ corepack pnpm exec smithers-build test '//scripts:npmDedupeUnit'
  "//scripts:npmDedupeUnit",NodeTest,ran,3198.959042   ok: true
```

---

## B6 (high): the shipped credential leak was not on the release page

### Confirmed at the source

`e2e/fault-gaps.md` row 22 ended:

> The behaviour is a shipped limitation of rc.0 and is recorded as one on the
> enforcement-owned known-limitations page.

`docs/pages/release/known-limitations.md` had no such record.
`grep -c "redact" docs/pages/release/known-limitations.md` returned 0 across
all 232 lines. The only release-facing trace of the leak was a red advisory CI
job, and `e2e/faults/case22-secret-never-in-journal.test.ts:105-114` is the
required red gate:

```
it("redacts the credential out of the operator's terminal", async () => {
  ...
  expect(child.output).not.toContain(secret)
}, 120_000)
```

### Test and red run

Extended `scripts/repo-contract/fault-skips.test.mjs`, the file that already
owns the required-red-gate roster. Each `requiredRedGates` entry gains a
`limitation` record (the heading on the release page, the anchor, and the
fault-gaps row), and two new cells check it. RED against the pre-fix docs:

```
✖ states every required red gate as a shipped limitation on the release page (0.478667ms)
  AssertionError [ERR_ASSERTION]: faults/case22-secret-never-in-journal.test.ts is red by design, so rc.0 ships the limitation it names. docs/pages/release/known-limitations.md has no "Credential redaction in logs" section, so a reader of the release learns about it only from a failing CI job. Add the paragraph to rc-contract §7 and regenerate the page.

✖ points the fault-gaps row at that limitation instead of describing it (0.185458ms)
  AssertionError [ERR_ASSERTION]: the | 22 | row claims the limitation is recorded on the known-limitations page and does not link to it. Link docs/pages/release/known-limitations.md#credential-redaction-in-logs.
```

GREEN after the fix: 9 of 9 cells pass, none of the seven existing cells
touched.

### Fix locations

- `docs/migration/rc-contract.md` section 7: new paragraph
  `**Credential redaction in logs.**`, placed before `**Effect.**`. It states
  what leaks (the credential in the operator's terminal log line, written by
  `Effect.logInfo` to the child's stderr), that the journal half passes and is
  proved by reading the SQLite file, why the log half stays a plain failing
  test under R-12, and the promotion condition: `continueOnError` dropped and
  `e2e-faults` added to `requiredJobs` when the section 5.2 redaction
  deliverable lands and the durable-park defect closes.
- `docs/pages/release/known-limitations.md`: the same wording, byte for byte,
  written into the generated `release-notes` region by
  `node scripts/generate-docs-pages.mjs`. The contract is the single source, so
  the "record the exception in section 7 with the same wording" requirement is
  met by construction rather than by copying. The paragraph carries no Table B
  exclusion id, so the generator emits no `Exclusions:` line and the coverage
  table below the block is unaffected.
- `e2e/fault-gaps.md` row 22: the closing sentence now names
  `docs/pages/release/known-limitations.md#credential-redaction-in-logs` and
  says what the reader will find there.
- `docs/llms-full.txt`, `docs/llms-operations.txt`,
  `packages/cli/docs/llms-full.txt`, `skills/smithers/llms-full.txt`:
  regenerated by `node scripts/generate-llms.ts` (12 artifacts, 4 changed).

Case 22 is still red, deliberately, and the matrix is otherwise unchanged
(66 of 67 tests pass, the same reading the e2e-matrix lane recorded):

```
 FAIL  faults/case22-secret-never-in-journal.test.ts > case22 a secret never reaches the journal > redacts the credential out of the operator's terminal
AssertionError: expected '[02:58:37.185] INFO (#100): calling h…' not to contain 'sk-live-e2ecase22NEVERLOGTHIS'
 ❯ faults/case22-secret-never-in-journal.test.ts:113:30
```

The journal half of the same file passes. Nothing in this lane touches
`e2e/faults`.

---

## Low (verdict): section 9 carries stale counts

### Confirmed at the source, and why no gate caught it

Four readings in section 9 disagreed with the tree:

| Reading | Was | Is |
| --- | --- | --- |
| Release tooling row | "equals the 39 names in §3.1" | 40; section 3.1's own heading says 40 and `publishedPackages` has 40 |
| Release tooling row | `pack-release.test.mjs:104-107` | the roster assertion is at `101-106` |
| Workspace row | "`examples`, `apps/*`, plus `e2e` when the rewritten suite lands (widen the pin at `vitestCoverageIsolation.test.ts:277-290`)" | `e2e` landed; the workspace globs are `packages/*`, `packages/build/infra`, `e2e`, `examples`, `apps/*` and the pin is at `297-344` |
| Exception 2 | root-scripts pin at `vitestCoverageIsolation.test.ts:354-364` | `378-452` |

The CI-lanes row listed the required `test` job with five of its twelve
`smithers-build` steps missing: `ci '//apps/review'`, `ci '//apps/bug-worker'`,
`ci '//apps/status-site'`, `test '//evals/review-seeded-bugs'`, and
`build '//evals/review-seeded-bugs:types'`. It also called `node-macos` and
`node-windows` advisory without saying they are in the generator's
`requiredJobs` array, which asserts a job is still declared rather than that it
can fail the pipeline (`packages/targets/src/GithubCiGen.ts:257-261`).

`check-docs` has a package-count check and it was green over "39". The reason
is in `scripts/docs-contract.mjs`: `citedPackageCounts` knew three spellings,
and none of them was the shortest one, the form the contract uses to point at
itself.

### Test and red run, in two stages

Stage 1, a fixture cell in `scripts/docs-contract.test.mjs`:

```
✖ finds the count the contract cites in its own cross-references (0.729583ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected

  + []
  - [
  -   39,
  -   41
  - ]
```

Stage 2, after adding `/(\d+) names in (?:§|section )3\.1/g` to
`citedPackageCounts`, the real gate went red on the real document:

```
✖ every document that cites the published set agrees with the contract
  AssertionError [ERR_ASSERTION]: docs/migration/rc-contract.md cites 39 published packages and the contract freezes 40

$ node scripts/check-docs.mjs
✗ a document states the wrong number of published packages:
    docs/migration/rc-contract.md: states 39, the contract freezes 40
```

GREEN after correcting section 9: `check-docs` exit 0, 27 of 27 cells in
`docs-contract.test.mjs`.

### Fix locations

- `docs/migration/rc-contract.md` section 9: the four readings above, the five
  missing CI steps, and the `requiredJobs` sentence. Exception 3 now names
  `//scripts:npmDedupe` and `//scripts:npmDedupeUnit` and states the second
  claim the gate makes.
- `scripts/docs-contract.mjs`: the fourth spelling, and its doc comment.
- `scripts/docs-contract.test.mjs`: the fixture cell.

---

## Gates

Load is read before each. The guard's threshold of 40 was never approached, so
no suite ran at reduced worker count and none was rerun for flake.

| Gate | Command | Result | Load at start |
| --- | --- | --- | --- |
| Frozen offline install | `corepack pnpm install --frozen-lockfile --offline` | exit 0, "Done in 2m 56s" | 9.65 |
| Lockfile refresh | `corepack pnpm install --offline` | exit 0, 3 lines moved in `pnpm-lock.yaml` | 5.51 |
| Bun lockfile | `bun install --lockfile-only` | exit 0, "Saved bun.lock (2177 packages)" | 7.33 |
| npm dedupe gate | `node scripts/check-npm-dedupe.mjs` | exit 0, single-copy effect, 3 optional peers absent, 97 packages | 7.42 |
| npm dedupe target | `smithers-build test '//scripts:npmDedupe'` | ok: true, 3.3 s | 7.64 |
| npm dedupe pins | `smithers-build test '//scripts:npmDedupeUnit'` | ok: true, 3.2 s | 7.27 |
| All script gates | `smithers-build test '//scripts/...'` | 22 targets, 20 ran, 1 failed, 1 skipped; the failure is `//scripts:releasePack` on an unbuilt tree, see below | 2.62 |
| Repo contract | `node --test "scripts/repo-contract/*.test.mjs"` | 25 pass before the extension, 27 after, 0 fail | 6.96 |
| Docs gate | `node scripts/check-docs.mjs` | exit 0, 16 checks | 4.77 |
| llms bundles | `node scripts/check-llms.mjs` | exit 0, 12 artifacts current | 4.77 |
| Dependency boundaries | `node scripts/check-dependency-boundaries.mjs` | exit 0, 63 packages | 6.96 |
| Effect version | `node scripts/check-single-effect-version.mjs` | exit 0, `effect@4.0.0-rc.108` everywhere (63 sources) | 6.96 |
| Workflow drift | `smithers-build lint '//:ci'` | ok: true, exit 0 | 7.42 and 10.21 |
| Known-file drift | `smithers-build lint '//:knownFiles'` | ok: true, exit 0 | 10.21 |
| `packages/testing` | `smithers-build ci '//packages/testing'` | 7 of 7 targets ran, 0 failed | 9.08 |
| `packages/create-app` | `smithers-build ci '//packages/create-app'` | 7 of 7, 0 failed | 8.14 |
| `packages/evals` | `smithers-build ci '//packages/evals'` | 7 of 7, 0 failed | 8.14 |
| `packages/chain` | `smithers-build ci '//packages/chain'` | 7 of 7, 0 failed | 8.14 |
| `packages/flows` | `smithers-build ci '//packages/flows'` | 7 of 7, 0 failed | 6.46 |
| `packages/agent` | `smithers-build ci '//packages/agent'` | 7 of 7, 0 failed | 6.28 |
| Coverage-isolation pins | `pnpm -C packages/flows exec vitest run test/vitestCoverageIsolation.test.ts` | 264 of 264 tests passed (the single-file run's coverage threshold error is an artifact of running one file, not a regression) | 10.88 |
| Fault matrix | `smithers-build test '//e2e:faults'` | 25 of 26 files, 66 of 67 tests, 102.5 s; the one failure is case 22's required red gate, unchanged | 4.79 |
| Frozen re-verify | `corepack pnpm install --frozen-lockfile --offline` | exit 0, "Already up to date", 330 ms | 5.12 |
| Bun frozen re-verify | `bun install --frozen-lockfile --offline --lockfile-only` | exit 0, lockfile byte-identical (clean `git status`) | 5.12 |

### The one failing target, and why it is not this lane's

```
//scripts:releasePack  failed  243ms
Error: ENOENT: no such file or directory, access '.../packages/canonical/dist/esm/Canonical.js'
    at async assertBuilt (scripts/pack-release.mjs:240:5)
//scripts:releaseSmoke  skipped  dependency //scripts:releasePack did not succeed
```

`packages/*/dist` does not exist in a freshly installed worktree. `releasePack`
packs built artifacts, so it needs `//packages/...` to have run first, which is
the order CI uses and not the order `test '//scripts/...'` alone establishes.
No file this lane touched is on that path. `releaseSmoke` is the gate that
would have proved the peer move end to end on real tarballs, so a verifier with
a built tree should run `smithers-build test '//scripts:releaseSmoke'`; the
derivation at `smoke-release.mjs:80-162` is what makes it safe, and it is
quoted above rather than measured.

---

## Files touched outside the lane's stated owned paths

Three, each forced by the work and none of them a change to a test's meaning:

1. `known-files.d.ts`. Adding `scripts/check-npm-dedupe.test.mjs` moves the
   generated registry. The repository invariant requires it in the same commit,
   and `lint '//:knownFiles'` is green.
2. `scripts/repo-contract/fault-skips.test.mjs`. B6's behaviour test had no
   other honest home: this file already owns the required-red-gate roster, and
   the claim being pinned is about that roster. Extended by two cells and one
   record field; nothing existing was changed or weakened.
3. `scripts/docs-contract.mjs` and `scripts/docs-contract.test.mjs`. One regex
   alternative and one fixture cell. Without them the section 9 correction is
   prose with no gate behind it, and the gate that should have caught the stale
   count is the one that missed it.

## For the orchestrator

1. `docs/migration/publish-runbook.md:37,129,148` still records
   `check-npm-dedupe` as exiting 1 on the peer disagreement and lists the fix
   as pending work. That file is not owned here. The gate exits 0 now, and line
   129's expected-exit table row is wrong.
2. `docs/migration/phase2-baseline.md:29` and `phase3-validation.md:333` record
   the same gate red for the Effect duplication. Those are historical baselines
   and are correct as history; no edit is needed unless the ledger wants a
   closing note.
3. `//scripts:releasePack` and `//scripts:releaseSmoke` cannot pass under
   `test '//scripts/...'` alone. Either the target declares a dependency on the
   package build or the Phase 7 checklist runs the two verbs in CI's order.
