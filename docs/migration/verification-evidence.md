# Clean-checkout verification evidence

## This record measures one commit, not the branch

Everything below is the validation run at `341c8fa87e` and is accurate for that
commit. It is not a statement about the current branch head, and it should not
be read as one before publishing.

Work landed after that verdict, and re-running the full suite later found seven
packages red that the verdict had covered: `build-cli` (77 tests),
`time-travel` (9), `examples` (4), `testing` (3), `agent` (2), `targets` (1)
and `create-app` (1), with `flows` below its coverage floor, the browser bundle
contract broken, and four of the script gates failing. Two causes account for
most of it: the in-memory engine began snapshotting replay payloads through a
codec that cannot encode a live BUILD.ts target reference, which failed every
target naming a dependency, and a resolver kept BUILD.ts modules and the CLI on
two physical copies of `effect`. Both are fixed, along with the rest.

The lesson is recorded because it will recur: a green verdict is a statement
about one commit. Before publishing, re-run the gates at the head being tagged
rather than citing this document.

## The run at `341c8fa87e`

All seventeen Phase 7 gates passed at that commit. The adversarial verdict over the full
evidence set returns `ready=true` at `341c8fa87e`; the verdict document is
[verdict-341c8fa87e.md](evidence/verdict-341c8fa87e.md), and the superseded
`ready=false` round it closes is
[verdict-cd14388ed7.md](evidence/verdict-cd14388ed7.md).

The validation has two tiers. The full seventeen-gate run measured
`cd14388ed7`. Its one failing gate, `docs-generation-links`, exposed two code
defects and one private external repository; the defects were fixed in the
wave-7 and wave-8 lanes, and eleven gates were then re-run at `341c8fa87e`,
the release commit, from the same clean checkout. The six gates that were not
re-run kept their `cd14388ed7` evidence after the verdict proved their package
surfaces unchanged by `git diff cd14388ed7 341c8fa87e` and re-ran spot
commands at the new commit (the circular check over 51 packages, example 09,
GitHubLive 4/4, the migrate detection suites, and the engine-store crash
trio).

Every gate ran from a clean checkout, never from the maintainer tree, with
real backends and real persisted data. No mocks, no fixtures standing in for a
service. The evidence file for each gate names its exact commands, the
environment they ran in, the final output lines, and the exit codes; the
copies under [evidence/](evidence/) are those files byte for byte.

## What was validated

| Item | Value |
| --- | --- |
| Checkout | `git clone --shared` of the maintainer tree, `v1/rc0-migration`, `vendor/jj` submodule initialized: `migration/clean-checkout-4`. The Plue gate cloned `/Users/williamcory/plue` branch `smithers-rc0-cutover` to `migration/plue-clean-cutover`. |
| HEAD, full run (17 gates) | `cd14388ed782aac6e5f5b23d66c8fa9dc01dd6ba` |
| HEAD, re-runs and final verdict (11 gates) | `341c8fa87e` (the release commit; the checkout was moved, stale build products removed, and the frozen offline installs re-verified) |
| Commits between the two | `f63809382b` (contract counts), `0156f2458e` (release artifacts), `92febad82c` (wave 7: served llms bundles, refuse-before-boot), `a42f8f6e5d`/`274c3b9e26`/`5cc98912d0` (wave 8: polish, init scaffold and launch settlement), `341c8fa87e` (release notes). Docs, scripts, `packages/cli`, `packages/agent`, `packages/control`, and two package manifests; every touched surface is covered by a re-run gate. |
| Plue branch tip | `976a170a64097827de8371bbf2a08930ebce7f34` on `smithers-rc0-cutover`, base `664c95c60`, unmerged |
| Submodule | `vendor/jj` at `47589ada70c1` |
| Host | macOS 26.2 (25C56), Darwin 25.2.0, arm64, 16 cores |
| Node | v24.18.0 |
| Bun | 1.4.0 (`1.4.0-canary.1+6618e7f7e`) |
| pnpm | 11.21.0, resolved by corepack 0.35.0 from `packageManager`. The Plue gate used pnpm 10.6.5, which Plue pins. |
| go / zig / jj / sqlite3 | go1.26.0, 0.15.2, 0.39.0, 3.51.0 |
| Date | 2026-08-31, 11:52Z to 17:05Z |

The host runs Node 24.18.0, above the `>=22.19.0` floor. CI pins Node 22.19.0
and Bun 1.3.14; the consumer fixtures also ran on Node 22.19.0, and the Bun
work here ran on 1.4.0. A full Node 22.19.0 lane is CI's job, not this one's;
no CI run exists yet for `341c8fa87e` because the branch is unpushed, and the
publish runbook gates the tag on a green CI run for the exact commit.

Raw logs, databases, transcripts, and packed tarballs stay in the Phase 7
working directory (`migration/phase7/`), which each evidence file cites by
name. Only the evidence documents are copied into this repository.

## Verdicts

| Gate | Commit | Verdict | Headline result | Evidence |
| --- | --- | --- | --- | --- |
| clean-install | `341c8fa87e` | PASS | The checkout moved to the release commit with stale build products removed; both frozen offline installs exit 0 and no tracked file changes | [00-clean-install.md](evidence/00-clean-install.md) |
| format-lint-typecheck | `341c8fa87e` | PASS | Typecheck, dprint plus eslint, and the generated-file drift targets exit 0 across the workspace | [format-lint-typecheck.md](evidence/format-lint-typecheck.md) |
| unit-tests | `341c8fa87e` | PASS | 63 of 63 projects, 14,745 tests: 14,713 pass, 25 gate-skip, 7 fail with proof that each needs live external state (provider credits, Docker, a Gemini free-tier quota, the mise binary); the built-tree script targets including `//scripts:docsUnit`, `//scripts:npmDedupe`, `//scripts:releasePack`, and `//scripts:releaseSmoke` all pass | [unit-tests.md](evidence/unit-tests.md) |
| sqlite-persistence-crash | `cd14388ed7` | PASS | 1,543 tests across 191 files, 0 failures; the fault matrix keeps case 22's terminal-log half as the one documented required red | [sqlite-persistence-crash.md](evidence/sqlite-persistence-crash.md) |
| browser-bundling | `341c8fa87e` | PASS | 28 of 28 browser-safe entries bundle and 7 of 7 Node-only entries fail on their documented `node:` builtin, with the list now owned by `scripts/browser-contract.mjs` and mirrored by the docs tables | [browser-bundling.md](evidence/browser-bundling.md) |
| cli-e2e | `341c8fa87e` | PASS | The full CLI suite passes against the working-tree binary; every removed verb refuses from an empty directory with its documented sentence and creates nothing; surviving verbs still boot the control plane | [cli-e2e.md](evidence/cli-e2e.md) |
| integrations-real-backend | `cd14388ed7` | PASS | GitHub and Linear pass their contract suites against the real APIs; Telegram is ENV-SKIP with no token on this host | [integrations-real-backend.md](evidence/integrations-real-backend.md) |
| docs-generation-links | `341c8fa87e` | PASS | `vocs build`, `check-docs`, and `check-llms` exit 0; the served `llms-full.txt` is byte-identical to the curated bundle after the deploy's copy step, which `check-llms` now asserts; `//scripts:docsUnit` is green; the only 404s are the documented cutover-order links and the private plugins repository | [docs-generation-links.md](evidence/docs-generation-links.md) |
| exports-types-sync | `341c8fa87e` | PASS | Export maps agree with the files on disk for all 40 published packages, including the new `refusal` export of `@smthrs/cli` | [exports-types-sync.md](evidence/exports-types-sync.md) |
| dependency-cycles-names | `cd14388ed7` | PASS | Zero import cycles; all project names unique; re-proven by the verdict's circular re-run at `341c8fa87e` | [dependency-cycles-names.md](evidence/dependency-cycles-names.md) |
| npm-pack | `341c8fa87e` | PASS | 40 of 40 tarballs pack and pass every completeness check, now including `dist/cjs/package.json` in the `smthrs` tarball and the three `@smthrs/memory` migration references | [npm-pack.md](evidence/npm-pack.md) |
| consumer-fixtures | `341c8fa87e` | PASS | The 40 tarballs install into fresh Node and Bun projects and run the quick start; the README overrides recipe takes `npm ls` from exit 1 to exit 0; a seat-stripped scaffold launch refuses and leaves no accepted row | [consumer-fixtures.md](evidence/consumer-fixtures.md) |
| examples | `cd14388ed7` | PASS | The suite and every script pass under the shipped CI condition; example 09's corrected header re-ran at `341c8fa87e` | [examples.md](evidence/examples.md) |
| migration-tool | `cd14388ed7` | PASS | 374 tests pass and 6 skip over six byte-for-byte 0.x fixtures including Plue's pack | [migration-tool.md](evidence/migration-tool.md) |
| plue-cutover | `cd14388ed7` | PASS | Every cutover item that runs without the live stack and the published registry passes; the rest are ENV-SKIP until publication | [plue-cutover.md](evidence/plue-cutover.md) |
| scans | `341c8fa87e` | PASS | All sweeps pass; `known-files.d.ts` regenerates identically; a fresh clone's first `smithers ls` and `smithers doctor` print nothing on stderr | [scans.md](evidence/scans.md) |
| smoke | `341c8fa87e` | PASS | All eight items end to end on the real binary: the scaffold as written resolves a seat, a no-credit launch settles `failed` in both databases, SIGKILL and timer parks resume, cancel reaps children, and ten runs end terminal with `finished_at_ms` set and no owner-pid-0 row | [smoke.md](evidence/smoke.md) |

## Records that are not gates

The [evidence/](evidence/) directory also carries the fix-lane reports (one
per Phase 7 fix lane, each with its recorded red run), the superseded FAIL
rounds the current runs cite, the hardening notes, and both verdict documents.
They are transcripts: a report that records a count or a failure the release
later corrected keeps quoting it, which is why the docs citation gate skips
this directory.

## Closed findings

The `cd14388ed7` verdict listed six blockers. Each closes as follows:

1. The docs gate defects: wave 7 (`92febad82c`) makes every removed verb
   refuse before the control plane boots and makes the deployed site serve
   the curated llms bundles, guarded by `check-llms`; the gate re-ran PASS.
2. Uncommitted release artifacts: committed in `0156f2458e` and
   `341c8fa87e`, and this document with the final evidence set is the last
   recorded artifacts commit.
3. The contract's case 22 contradiction: ruling R-12 is amended in place;
   the terminal-log half ships red as the documented limitation in contract
   section 7, the release notes, and the known-limitations page, with the
   `e2e-faults` CI job advisory until the section 5.2 redaction deliverable
   lands.
4. The private plugins repository: a runbook-named maintainer step before
   the docs deploy.
5. Plue: criterion 9 holds on the unmerged `smithers-rc0-cutover` branch;
   the registry-dependent items run at publication, per
   `plue-consumer-contract.md` section 13.
6. CI: the runbook gates the tag on a green CI run for the exact release
   commit once the branch is pushed.

## What this round did not cover

- CI's own pinned toolchain. These gates ran on Node 24.18.0 and Bun 1.4.0
  (with a Node 22.19.0 consumer-fixture lane); the required CI lanes pin Node
  22.19.0 and Bun 1.3.14, and no CI run exists yet for the release commit.
- Windows, which the release contract lists as unsupported.
- Publishing. Nothing was published to any registry, and the migration-tool
  gate never ran `--apply` against a real project.
- Plue mainline. The cutover lives on the unmerged branch
  `smithers-rc0-cutover`; Plue's `664c95c60` still carries the full 0.x
  surface.
- The plugins repository, which release contract section 10 holds as a
  maintainer prerequisite rather than a gate in this repository.
