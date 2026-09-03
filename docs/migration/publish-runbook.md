# Publish runbook: 1.0.0-rc.0

The exact commands a maintainer runs to publish `1.0.0-rc.0`, in order, with
the checks that must pass first. Nothing here is automated on your behalf:
publishing is a manual maintainer action.

This runbook is the rc.0 instance of the general
[release runbook](../internal/release-runbook.md). Where the two differ, this
file wins for this candidate.

## 0. Preconditions

All seventeen Phase 7 gates pass and the adversarial verdict is `ready=true`
at the release commit. Read [verification-evidence.md](verification-evidence.md)
first; the three findings its previous round listed are closed: the removed-verb
refusal and the served llms bundles landed in wave 7 (`92febad82c`) and the
docs gate re-ran PASS, and the plugins repository remains the one
publication-order item below.

Before the docs deploy, make `https://github.com/smithersai/plugins` public
(`gh api repos/smithersai/plugins` prints `private=true` today;
`smithersai/smithers-plugins` redirects to it) or change the five pages that
link to it. Release contract section 10 holds it as a maintainer prerequisite.

Push the branch and require a green CI run for the exact commit you tag: no
GitHub CI run exists for the release commit while the branch is unpushed, and
`ci.yml` runs on `pull_request` and on pushes to `main`, so open the cutover
pull request (or dispatch the workflow) rather than trusting a bare branch
push to run it. Steps 3 and 5 gate the tag and the publish on
`gh run watch --exit-status`.

The redaction decision this step used to carry is closed, not pending. The
section 5.2 deliverable landed `@smthrs/journal` `RedactedLogger`, both halves
of `e2e/faults/case22-secret-never-in-journal.test.ts` are green on the real
binary with no edit to the test, and root `PACKAGE.ts` drops `continueOnError`
and lists `e2e-faults` in `requiredJobs`. Contract section 5 records it as
shipped on both paths. Nothing about it needs deciding before publishing.

Plue is the other half of the cutover. PLAN completion criterion 9 is met on
the branch `smithers-rc0-cutover` (tip `976a170a6`) for everything that runs
without the live stack, and the plue-cutover gate is green. That branch is
unmerged, and its remaining items cannot run until `@smthrs/*` `1.0.0-rc.0` is
on the registry: the agent-host links swap to published pins, the agent VM
image builds, and `zig build e2e`, the live-API suites, and the pipeline
receipts follow. Publishing this candidate is what unblocks them, so plan that
pass before you tag. `plue-consumer-contract.md` section 13 holds the
checklist.

Two maintainer preconditions, neither of them code:

- The publishing identity is an owner of the `@smthrs` npm org:
  `npm org ls smthrs`.
- The GitHub environment `npm-publish` exists on this repository with npm
  trusted publishing configured for `smithersai/smithers` / `release.yml`, or
  a `NODE_AUTH_TOKEN` environment secret from an automation token with publish
  rights. The workflow publishes with `--provenance` under `id-token: write`.

## 1. Set the version

The tree is already at `1.0.0-rc.0`: on 2026-08-31 at `cd14388ed7`,
`node scripts/set-release-version.mjs --check 1.0.0-rc.0` answered
`63 workspace manifests and 1 versioned source are at 1.0.0-rc.0.` and exited 0.
Run this step for `rc.1` and later, or after any manifest change; today it is a
verification, not an edit.

Every public manifest must equal the tag's version, and the public packages
depend on each other by exact version, so both move together. A range naming a
private workspace package stays `workspace:*`.

```sh
node scripts/set-release-version.mjs 1.0.0-rc.0
pnpm install --lockfile-only
bun install --lockfile-only
node scripts/set-release-version.mjs --check 1.0.0-rc.0
```

Commit the manifests and both lockfiles together. A dependency change that
refreshes one lockfile and not the other breaks the Bun matrix.

```sh
git add packages/*/package.json pnpm-lock.yaml bun.lock
git commit -m "🔧 chore(release): set every manifest to 1.0.0-rc.0

Docs: docs/migration/publish-runbook.md"
```

Land that commit on the release branch. The tag in step 5 must point at it.

## 2. Check the versioned manifests and both lockfiles

Run all of these from a clean working tree. Each one is a gate, not a hint.

```sh
# Every non-private engine or agent manifest is exactly 1.0.0-rc.0, every
# sibling range is exact, and every private edge is workspace:*.
node scripts/set-release-version.mjs --check 1.0.0-rc.0

# Exactly one effect version resolves across every manifest and BOTH lockfiles.
node scripts/check-single-effect-version.mjs

# No duplicate copy of a package that must be a singleton. Needs the network:
# it packs the release manifests into a throwaway fixture and lets npm's own
# arborist resolve the tree an end user would get.
node scripts/check-npm-dedupe.mjs

# Both lockfiles are current and installable offline with no writes.
pnpm install --frozen-lockfile --offline
bun install --frozen-lockfile --offline --lockfile-only

# The publication set is exactly the 40 names release contract section 3.1
# freezes. pack-release.mjs throws on any mismatch.
node scripts/pack-release.mjs --names | wc -l    # 40

# Nothing moved while you were checking.
git status --porcelain                            # empty
```

`pack-release.mjs` refuses to pack when the set of non-private manifests whose
`smthrs.group` is `engine` or `agent` is not exactly those 40 names, so a
package cannot join or leave the train unnoticed.

### Measured on 2026-08-31 at `cd14388ed7`, in `migration/clean-checkout-4`

| Command                                                   | Exit | Output                                                                                                                                 |
| --------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `node scripts/set-release-version.mjs --check 1.0.0-rc.0` | 0    | `63 workspace manifests and 1 versioned source are at 1.0.0-rc.0.`                                                                     |
| `node scripts/check-single-effect-version.mjs`            | 0    | `check-single-effect-version: effect@4.0.0-rc.108 everywhere (63 sources)`                                                             |
| `node scripts/check-npm-dedupe.mjs`                       | 0    | `ok: effect@4.0.0-rc.108 (single copy)`, `ok: 3 optional peers absent from default install`, `resolved package count: 97 (budget 925)` |
| `node scripts/pack-release.mjs --names \| wc -l`          | 0    | `40`, in the order section 6 lists                                                                                                     |
| `git status --porcelain`                                  | 0    | empty                                                                                                                                  |

The frozen offline installs for both package managers are the clean-install
gate, which passes.

`check-npm-dedupe` failed in the previous round because `@smthrs/kernel`
declared `vitest` an optional peer and `@smthrs/testing` declared it a plain
one, so npm installed vitest into an end user's default tree. The
release-hygiene lane (`b22c47e5f5`) made `vitest` and `@effect/vitest` optional
peers of `@smthrs/testing` and declared the gate as `//scripts:npmDedupe`, with
a unit test at `//scripts:npmDedupeUnit`, so `smithers-build test
'//scripts/...'` selects it the way release contract R-35 requires. The
resolved package count fell from 165 to 97 with the change.

## 3. Rehearse without publishing

Locally, executing the workflow's own step bodies:

```sh
node scripts/release-rehearsal.mjs --tag v1.0.0-rc.0 --transcript /tmp/rehearsal.json
```

That runs every gate, including `pnpm test` over all workspaces. To rehearse
only the release-specific half:

```sh
node scripts/release-rehearsal.mjs --tag v1.0.0-rc.0 \
  --skip "Typecheck all workspaces" \
  --skip "Test all workspaces" \
  --skip "Lint all workspaces"
```

On GitHub, once `release.yml` is on the default branch:

```sh
gh workflow run release.yml --ref main -f releaseTag=v1.0.0-rc.0 -f dryRun=true
gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

`dryRun` defaults to true. The run ends with `Report the skipped publication`,
which prints the exact set, order, version, and dist-tag a real run would use.
Compare that list against section 6 below before you tag.

## 4. Pack and smoke-test the tarballs

```sh
find packages -type d -name dist -prune -exec rm -rf {} +
pnpm --recursive --if-present run build
node scripts/pack-release.mjs /tmp/release-packs
node scripts/smoke-release.mjs /tmp/release-packs
```

`pack-release.mjs` packs each package from a staged copy whose `exports` map is
rewritten from `publishConfig.exports`, so the tarballs are exactly what a
publish would ship. Packing without publishing is the dry run; raw
`npm pack --dry-run` against the workspace directory would pack the
source-first manifest that never publishes.

`smoke-release.mjs` imports every tarball as ESM and as CJS from outside the
repository. `smthrs` throws on import by design, and the script encodes that
expectation, so its failure there is the pass.

## 5. Tag and publish

```sh
git checkout main && git pull
git tag -a v1.0.0-rc.0 -m "Smithers 1.0.0-rc.0"
git push origin v1.0.0-rc.0
gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

The tag push publishes. `DRY_RUN` is false on that path and cannot be
overridden. The workflow re-runs every gate, rebuilds from clean artifacts,
packs, smoke-tests, then publishes each tarball with

```sh
pnpm publish "$PACK_DIR/$tarball" --provenance --access public --tag next
```

**The dist-tag is `next`, never `latest`.** A version containing `-` resolves to
`next` in three places that must agree: `publishConfig.tag` in every public
manifest, the `publish_tag` case in `.github/workflows/release.yml`, and the
`--tag` on the publish line. `latest` keeps resolving `smthrs@0.35.0` and the
0.x `@smthrs/*` packages until 1.0.0 is final, so an existing project running
`npm install smthrs` is not pulled onto the candidate.

The publish loop skips any version already on the registry, so a run that dies
partway resumes by re-pushing the same tag:

```sh
git push origin :v1.0.0-rc.0 && git push origin v1.0.0-rc.0
```

## 6. Package order

Publication order is the workspace dependency order `pack-release.mjs`
computes, so no package publishes before something it depends on. The workflow
reads it from the pack manifest rather than a hand-kept list. Reproduce it with
`node scripts/pack-release.mjs --names`.

| #  | Package                    |
| -- | -------------------------- |
| 1  | `@smthrs/canonical`        |
| 2  | `@smthrs/capability`       |
| 3  | `@smthrs/crypto`           |
| 4  | `@smthrs/artifacts`        |
| 5  | `@smthrs/core`             |
| 6  | `@smthrs/database`         |
| 7  | `@smthrs/jj`               |
| 8  | `@smthrs/journal`          |
| 9  | `@smthrs/keys`             |
| 10 | `@smthrs/migrate`          |
| 11 | `@smthrs/notifications`    |
| 12 | `@smthrs/observability`    |
| 13 | `@smthrs/patterns`         |
| 14 | `@smthrs/plan`             |
| 15 | `@smthrs/flow`             |
| 16 | `@smthrs/engine`           |
| 17 | `@smthrs/plugin`           |
| 18 | `@smthrs/run-store`        |
| 19 | `smthrs`                   |
| 20 | `@smthrs/step-cache`       |
| 21 | `@smthrs/sync`             |
| 22 | `@smthrs/kernel`           |
| 23 | `@smthrs/engine-store`     |
| 24 | `@smthrs/model`            |
| 25 | `@smthrs/memory`           |
| 26 | `@smthrs/platform-browser` |
| 27 | `@smthrs/platform-node`    |
| 28 | `@smthrs/platform-bun`     |
| 29 | `@smthrs/registry`         |
| 30 | `@smthrs/control`          |
| 31 | `@smthrs/gateway`          |
| 32 | `@smthrs/harness`          |
| 33 | `@smthrs/mcp`              |
| 34 | `@smthrs/sandbox`          |
| 35 | `@smthrs/std`              |
| 36 | `@smthrs/agent`            |
| 37 | `@smthrs/testing`          |
| 38 | `@smthrs/time-travel`      |
| 39 | `@smthrs/flows`            |
| 40 | `@smthrs/cli`              |

All 40 carry version `1.0.0-rc.0`, `publishConfig.tag: "next"`, and
`publishConfig.exports` pointing at `dist/esm` and `dist/cjs`.

## 7. Verify what was published

```sh
# Every name at the released version, on the next dist-tag, with latest
# untouched for every name that has a 0.x line.
for name in $(node scripts/pack-release.mjs --names); do
  echo "$name $(npm view "$name@1.0.0-rc.0" version) next=$(npm view "$name" dist-tags.next) latest=$(npm view "$name" dist-tags.latest)"
done

# Provenance is attached.
npm view @smthrs/flows@1.0.0-rc.0 --json \
  | node -e 'let s="";process.stdin.on("data",c=>s+=c)
      .on("end",()=>console.log(JSON.parse(s).dist.attestations ?? "NO ATTESTATION"))'
```

Then install the set from the registry, outside the repository, and load it:

```sh
repo=$PWD
rm -rf /tmp/smithers-verify && mkdir -p /tmp/smithers-verify && cd /tmp/smithers-verify
npm init -y >/dev/null && npm pkg set type=module
npm install $(node "$repo/scripts/pack-release.mjs" --names | sed 's/$/@1.0.0-rc.0/')
for name in $(node "$repo/scripts/pack-release.mjs" --names); do
  node --input-type=module --eval "await import('$name')" && echo "esm ok $name"
  node --eval "require('$name')" && echo "cjs ok $name"
done
```

Two expected results in that loop: `@smthrs/platform-bun` declares
`@effect/platform-bun` as an optional peer, so install it too or that import
fails by design; and `smthrs` throws on import because it is the migration
notice.

## 8. If it goes wrong

npm versions are immutable. Never try to republish a version.

- Broken publish, under 72 hours old, nothing depends on it:
  `npm unpublish @smthrs/<name>@1.0.0-rc.0`.
- Otherwise:
  `npm deprecate @smthrs/<name>@1.0.0-rc.0 "superseded by 1.0.0-rc.1"`, then
  start again from step 1 with the next candidate.
- Partial publish where some names landed: fix the cause and re-push the same
  tag. The loop leaves published versions in place and continues.

## 9. After publishing

- `docs/releases/1.0.0-rc.0.md` is the release note text.
- The `CHANGELOG.md` `1.0.0-rc.0` section is the commit-level record.
- `docs/migration/removed-apis.md` is what an upgrader is pointed at.
- Nothing in this candidate changes the `latest` dist-tag. That happens at
  1.0.0 final, as a separate decision.
