# Clean-checkout verification evidence

Twelve of seventeen Phase 7 gates pass. Five fail, and each failure is a
release blocker until it is closed or the maintainer accepts it in writing.

State as of 2026-08-30, HEAD `9c464343f0`. Fix lanes for the failures were open
when this was written, so re-run the affected gate from a clean checkout before
reading a verdict here as final.

Every gate ran from a clean checkout, never from the maintainer tree, with real
backends and real persisted data. No mocks, no fixtures standing in for a
service. The evidence file for each gate names its exact commands, the
environment they ran in, the final output lines, and the exit codes; the copies
under [evidence/](evidence/) are those files byte for byte.

## What was validated

| Item | Value |
| --- | --- |
| Checkout | `git clone --shared` of the maintainer tree, `v1/rc0-migration`, `vendor/jj` submodule initialized |
| HEAD | `9c464343f0cfada6aa36f0a08144ed7cf1f0ce14` |
| Host | macOS 26.2, arm64 |
| Node | v24.18.0 |
| Bun | 1.4.0 |
| pnpm | 11.21.0, resolved by corepack from `packageManager` |
| corepack | 0.35.0 |
| Dates | 2026-08-29 to 2026-08-30 |

The host runs Node 24.18.0, above the `>=22.19.0` floor. CI pins Node 22.19.0
and Bun 1.3.14; the consumer fixtures and the Bun matrix ran on Bun 1.4.0 here.
A Node 22.19.0 lane is CI's job, not this one's.

## Verdicts

| Gate | PLAN Phase 7 line | Verdict | Evidence |
| --- | --- | --- | --- |
| clean-install | frozen installs for pnpm and Bun | PASS | [00-clean-install.md](evidence/00-clean-install.md) |
| format-lint-typecheck | formatting, lint, and typecheck | PASS | [format-lint-typecheck.md](evidence/format-lint-typecheck.md) |
| unit-tests | package-level and full unit tests | PASS | [unit-tests.md](evidence/unit-tests.md) |
| sqlite-persistence-crash | real SQLite persistence and crash/restart suites | PASS | [sqlite-persistence-crash.md](evidence/sqlite-persistence-crash.md) |
| browser-bundling | browser bundling for advertised browser-safe entry points | PASS | [browser-bundling.md](evidence/browser-bundling.md) |
| cli-e2e | CLI end-to-end tests using the working-tree CLI | PASS | [cli-e2e.md](evidence/cli-e2e.md) |
| integrations-real-backend | real-backend integration tests for every integration in the RC | PASS | [integrations-real-backend.md](evidence/integrations-real-backend.md) |
| docs-generation-links | documentation generation and link checks | PASS | [docs-generation-links.md](evidence/docs-generation-links.md) |
| exports-types-sync | package export/type synchronization checks | FAIL | [exports-types-sync.md](evidence/exports-types-sync.md) |
| dependency-cycles-names | dependency-cycle and duplicate-package-name checks | PASS | [dependency-cycles-names.md](evidence/dependency-cycles-names.md) |
| npm-pack | npm pack/dry-run inspection for every public package | PASS | [npm-pack.md](evidence/npm-pack.md) |
| consumer-fixtures | installation into clean Node and Bun consumer fixtures | PASS | [consumer-fixtures.md](evidence/consumer-fixtures.md) |
| examples | execution of all published examples | FAIL | [examples.md](evidence/examples.md) |
| migration-tool | migration workflow tests against representative 0.x projects | PASS | [migration-tool.md](evidence/migration-tool.md) |
| plue-cutover | clean builds, real-backend contract tests, and import scans in `../plue` | FAIL | [plue-cutover.md](evidence/plue-cutover.md) |
| scans | secret, generated-file, stale-version, and obsolete-import scans | FAIL | [scans.md](evidence/scans.md) |
| smoke | the manual smoke test, eight items | FAIL | [smoke.md](evidence/smoke.md) |

[hardening-notes.md](evidence/hardening-notes.md) carries findings that are not
gates: rules learned during the round that later work should keep.

## The five blockers

### 1. A run parked on a durable wait is never continued (smoke)

The largest finding. A run that parks on a `wait` longer than 60 s, or on an
in-run `ask` approval, is finalized `cancelled` on the parking process's exit.
Every resumer (`smithers run --resume`, `smithers approve`) then accepts the
request, flips the control row to a non-terminal status, and hangs with no
output. The rows cannot be cancelled again, because `cancel` and `down` replay
the earlier receipt.

Two of the eight PLAN smoke items are affected: "restart a process during
execution" passes for an in-memory wait and fails for a durable park, and
"resume a durable wait" fails. The other six items pass against the
working-tree CLI, real SQLite files, a real model seat, a real gateway, and the
real GitHub and Linear APIs.

Durable resume is the core promise of this release. Reproduction, event dumps,
and the final database state are in the evidence file.

### 2. Path D workflows cannot resolve the JSX runtime (plue-cutover)

The Plue cutover branch builds against the rc.0 contracts, and every
removed-package and JSX-loading scan is clean. Two real-backend runner tests
fail at the branch tip: executing `.smithers/workflows/*.tsx` cannot resolve
`react/jsx-dev-runtime`, so all eight surviving Tier 0 CI DSL workflows are
broken at runtime on any checkout without its own React.

The chain is verified in the evidence file: Bun transpiles the consumer `.tsx`
with the automatic JSX runtime, the workflow shim exports no `./jsx-runtime`,
no `jsxImportSource` is configured for the CI DSL, and the lane removed the
root React pin that had been masking it.

A second, procedural blocker: `docs/migration/plue-consumer-contract.md` names
no Plue migration branch, so the gate had to discover its own validation
target.

### 3. `known-files.d.ts` is not reproducible, and nothing gates it (scans, exports-types-sync)

Both gates fail on the same finding, which is why they are one blocker.

`node scripts/generate-known-files.mjs` in a checkout with the `vendor/jj`
submodule initialized (the setup PLAN and CI use) rewrites the committed
declaration from 4,598 to 5,302 entries, adding 704 `//vendor/jj/**` literals.
`Input.discoverFiles` never treats `vendor/jj` as a repository boundary, so the
walk descends into any materialized submodule. As committed, the file is only
reproducible from a checkout without the submodule.

The target that should catch this cannot run under any verb:
`pnpm exec smithers-build lint '//:knownFiles'` fails with
`spawn {smthrs:tool:{"_tag":"RuntimeBin"}} ENOENT`, because the RuntimeBin
interpreter token is never substituted before spawn. No CI job selects the
target and no test pins it.

Everything else in both gates is green. The other four scans (secret,
stale-version, obsolete-import, `legacy/` absence) pass with every hit
classified, and package export and type synchronization is green across all 40
published packages: public types build cleanly, both export maps agree with
each other and with the files on disk, and every non-null subpath resolves
under Node and Bun while every null subpath refuses.

### 4. One published example fails with its prerequisites met (examples)

`examples/src/13-agent-live-smoke-local.ts`, the local Ollama agent stack,
fails reproducibly with `HarnessError` code `model_failed`: the agent action
ended without a completed answer. The deterministic suite is 57 of 57 green,
and the other two live examples behave as documented.

This is the one example failure that is not environmental. The separate
`12-agent-live-smoke` failure is: that seat's OpenAI account answers
`no credits remaining`, which the Phase 2 baseline recorded as the same
environmental failure.

## Environmental failures, classified and not blocking

Three of the 62 workspace projects fail in the full unit-test fan-out, all on
live external state rather than on repository code:

- `packages/model`: two live Gemini tests fail with HTTP 429 from an exhausted
  free-tier quota. Re-running with `env -u GEMINI_API_KEY` exits 0.
- `examples`: the live OpenAI seat answers `no credits remaining`.
- `packages/build-cli`: no Docker daemon on the host, and one fixture requires
  `mise` to be absent where the host has it installed.

The Phase 2 baseline recorded `Summary: 2 fails, 55 passes` and Phase 3
recorded `2 fails, 56 passes`, both with the same two environmental projects.
This round is `3 fails, 59 passes`; `packages/model` is new only because
`GEMINI_API_KEY` was present in this shell and absent in the earlier ones.

One more environmental result, recorded so it is not mistaken for a product
defect: Bun does not satisfy a nested exact `@smthrs/*@1.0.0-rc.0` edge from a
root `file:` tarball, so the Bun consumer fixture adds overrides mapping each
of the 40 names to its tarball. Once the version is on the registry, a Bun
consumer following the README install line resolves normally.

## What this round did not cover

- CI's own pinned toolchain. These gates ran on Node 24.18.0 and Bun 1.4.0;
  the required lanes pin Node 22.19.0 and Bun 1.3.14.
- Windows, which the release contract lists as unsupported.
- Publishing. Nothing was published to any registry, and `--apply` was never
  run against a real project by the migration-tool gate.
- The plugins repository, which release contract section 10 holds as a
  maintainer prerequisite rather than a gate in this repository.
