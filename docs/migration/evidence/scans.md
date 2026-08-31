# Phase 7 gate: scans

Verdict: FAIL

One blocker: `known-files.d.ts` cannot be reproduced by its declared generator in the documented clean-checkout state, and the `//:knownFiles` target that should gate it cannot run under any verb. The secret, stale-version, and obsolete-import scans pass, and `legacy/` is absent. Details and root cause below.

## Environment

| Item | Value |
| --- | --- |
| Checkout | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout` |
| HEAD | `9c464343f0cfada6aa36f0a08144ed7cf1f0ce14` (`v1/rc0-migration`) |
| Node | v24.18.0 |
| Bun | 1.4.0 |
| pnpm (corepack) | 11.21.0 |
| ripgrep | `/opt/homebrew/bin/rg` (gitleaks not installed; pattern scan used instead) |
| Tracked files | 4705 (`git ls-files | wc -l`) |
| Date | 2026-08-30 |

`git status --porcelain` was empty before the scans and is empty again at the end. The one file the generated-file scan modified (`known-files.d.ts`) was restored with `git checkout --` after the diff was captured.

## 1. Secret scan: PASS

Pattern sweep over the tree from the checkout root (rg honors `.gitignore`, so `node_modules/` and `dist/` are excluded; `vendor/jj` is included).

High-confidence token patterns, one rg invocation, exit 0:

```
rg -n -e 'sk-ant-[A-Za-z0-9_-]{16,}' -e '\bsk-[A-Za-z0-9]{32,}\b' \
   -e 'ghp_[A-Za-z0-9]{36}' -e 'gh[ousr]_[A-Za-z0-9]{36}' -e 'github_pat_[A-Za-z0-9_]{22,}' \
   -e 'AKIA[0-9A-Z]{16}' -e 'ASIA[0-9A-Z]{16}' -e 'xox[baprs]-[0-9A-Za-z]{8,}-[0-9A-Za-z-]{4,}' \
   -e 'AIza[0-9A-Za-z_-]{35}' -e 'npm_[A-Za-z0-9]{36}' -e 'glpat-[0-9A-Za-z_-]{20}' \
   -e '-----BEGIN [A-Z ]*PRIVATE KEY-----' -e 'eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}'
```

Five hits, all fabricated fixtures:

| Hit | Classification |
| --- | --- |
| `apps/ui/src/mainview/state/seams/KeysSeam.test.ts:60` (`sk-ant-api03-THE-WHOLE-UNMASKED-SECRET-VALUE`) | masking test placeholder |
| `packages/cli/test/Bug.test.ts:21-23` (`github_pat_abcdef...`, `AKIAIOSFODNN7EXAMPLE`, `xoxb-1234567890-abcdef`) | redaction test inputs; `AKIAIOSFODNN7EXAMPLE` is AWS's documented example key |
| `vendor/jj/lib/tests/test_ssh_signing.rs:29` (OpenSSH private key block) | upstream jj SSH-signing test fixture in the pinned submodule |

Generic assignment and credential-URL patterns (`(api|auth|access|secret|client|private)[_-]?(key|token|secret) = "<24+ chars>"`, `scheme://user:password@host`): 17 hits, every one a test file using `password`, `secret`, or `hunter2` as the literal (`packages/build/infra/worker/test/protocol-hardening.test.ts:728`, `packages/build/terraform/modules/cache/service/test/*.js`, `packages/cli/test/Bug.test.ts:11-13`, `packages/artifacts/test/RemoteArtifacts.test.ts:99`, `packages/model/test/Endpoint.test.ts:30`, `packages/build-cli/test/Cache.test.ts:153`, `packages/build/test/PackageManager.test.ts:313,382`).

Credential file check: `git ls-files` matches no `.env`, `.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `.netrc` file. The tracked `.npmrc` contains comments only. `apps/review/action/src/materializeInferenceCredentials.ts` and `packages/control/src/*CredentialStore*` are credential-scrubbing and storage code, not stored secrets.

No real secret in the tree.

## 2. Generated-file scan: FAIL

The three root files generated from `BUILD.ts` were regenerated in place and diffed against the committed copies.

| Command | Exit | Result |
| --- | --- | --- |
| `pnpm exec smithers-build lint '//:ci'` | 0 | `//:ci GithubCiGen ran`, ok: true (drift check) |
| `pnpm exec smithers-build build '//:tsconfig'` | 0 | ran; `git status --porcelain` stays empty |
| `pnpm exec smithers-build build '//:ci'` | 0 | ran; `git status --porcelain` stays empty |
| `pnpm exec smithers-build build '//:knownFiles'` | 1 | `target selected by //:knownFiles does not support the build verb` |
| `pnpm exec smithers-build test '//:knownFiles'` | 1 | `target selected by //:knownFiles does not support the test verb` |
| `pnpm exec smithers-build ci '//:knownFiles'` | 1 | `smithers-build/ExecError ... spawn {smthrs:tool:{"_tag":"RuntimeBin"}} ENOENT` |
| `node scripts/generate-known-files.mjs` | 0 | rewrites `known-files.d.ts`: 1409 insertions, 1 deletion |

`tsconfig.json` and `.github/workflows/ci.yml` are byte-stable. `known-files.d.ts` is not.

### Finding: known-files.d.ts regeneration drift

The committed file declares 4598 workspace files and contains zero `vendor/jj` entries (`git show HEAD:known-files.d.ts | grep -c "vendor/jj"` prints 0). Running the declared generator (`scripts/generate-known-files.mjs`, the exact script `//:knownFiles` names in root `BUILD.ts:12-15`) in the documented checkout state produces 5302 files, adding 704 `//vendor/jj/**` entries plus their header count change. The clean checkout has the submodule initialized because the setup command runs `git submodule update --init`, and CI checks out with `submodules: recursive` (`.github/workflows/ci.yml:130,156`), so the documented state is the initialized one.

Root cause, verified in source:

- `KnownFile.discoverKnownFiles` delegates to `Input.discoverFiles` (`packages/targets/src/KnownFile.ts:97`), which hardcodes `repositoryBoundaries: []` (`packages/targets/src/Input.ts`, `discoverFiles` at line 803). The walk skips only entries named `.git` and `node_modules`, so it descends into an initialized `vendor/jj` (whose `.git` is a gitfile) and collects every file its own `.gitignore` rules admit.
- The target-glob walk does have a nested-repository rule: `packages/targets/src/Input.ts:651-652` skips a directory listed in `repositoryBoundaries` unless entered, and `packages/build-cli/src/PackageExec.ts:1275,2490` supplies those boundaries from the workspace repos index. The generated header's own contract ("The N workspace files below follow the same .gitignore and host-state rules as globs") is therefore violated: globs skip the nested repository, the KnownFile scan does not.
- Nothing gates this. `//:knownFiles` rejects the `build` and `test` verbs, and its `ci` verb fails before spawning because the `{smthrs:tool:{"_tag":"RuntimeBin"}}` placeholder is never substituted with the runtime binary path (`spawn ... ENOENT`). No step in `.github/workflows/ci.yml` references the target, so the committed file matches whatever state the last manual run happened to see (a checkout with `vendor/jj` empty).

Consequence: any operator who follows the invariant ("regenerated, never hand-edited") in a normally initialized checkout commits 704 `//vendor/jj/**` literals into `known-files.d.ts` and shifts the pins in `packages/flows/test/vitestCoverageIsolation.test.ts`. The fix belongs in the fix lane, not here; the two candidate repairs are teaching the KnownFile discovery path the same repository-boundary rule the glob walk uses, and making `//:knownFiles` runnable so drift is gated. After evidence capture the file was restored (`git checkout -- known-files.d.ts`; porcelain 0).

## 3. Stale-version scan: PASS

Manifest audit: a Node script parsed all 84 tracked `package.json` files. 42 are public (no `"private": true`); every public workspace manifest is versioned `1.0.0-rc.0`, including the `smthrs@1.0.0-rc.0` deprecation stub (`packages/smthrs-deprecation`). No public manifest carries version `0.35.0` or `0.1.0`. The only manifests declaring stale material are 0.x fixtures the migration tool transforms, which is their function:

| Fixture manifest | Stale content |
| --- | --- |
| `packages/migrate/test/fixtures/batch-issues/package.json` | `smithers-orchestrator ^0.32.0` |
| `packages/migrate/test/fixtures/mixed-api/.smithers/package.json`, `plue-pack/.smithers/package.json` | `smithers-orchestrator 0.32.0` |
| `packages/migrate/test/fixtures/{jsx-single,persisted-db}/package.json`, `flows/migrate-smithers-v1/test/fixtures/smithers-0x-hello/package.json` | `smthrs 0.35.0`, `effect 4.0.0-beta.105` |

Fixtures do not ship: `@smthrs/migrate` `files` is `["src/**", "dist/**", LICENSE, README, CHANGELOG]`, and fixture directories are outside the pnpm workspace globs (`packages/*`, `packages/build/infra`, `examples`, `apps/*`).

Effect version: `node scripts/check-single-effect-version.mjs` exits 0 with `effect@4.0.0-rc.108 everywhere (63 sources)`. Remaining `4.0.0-beta` strings are third-party peer ranges recorded inside `pnpm-lock.yaml`/`bun.lock` (`@distilled.cloud/*`, `@alchemy.run/*` declare `effect: '>=4.0.0-beta.104 || >=4.0.0'`), the migrate fixtures above, and the vendor-fork attribution in `THIRD_PARTY_NOTICES.md:17` (`@smthrs/engine` forked from `effect@4.0.0-beta.102`, license bookkeeping required by `packages/engine/VENDOR.md`).

`0.35.0` outside fixtures appears only as intentional product or history content: the migration guide and `packages/cli/src/{Legacy,Project}.ts` messages that direct operators to `bunx smthrs@0.35.0 ps` for unfinished 0.x runs, `packages/smthrs-deprecation/README.md` dist-tag notes, `docs/internal/release-runbook.md`, historical changelog pages and their route entries, `apps/bug-worker` sample payloads, and the tests pinning those behaviors.

Old package names (`smithers-orchestrator`, `@smthrs/graph`, `@smthrs/scheduler`, `@smthrs/driver`, `@smthrs/react-reconciler`, `@smthrs/components`): both lockfiles resolve none of them (rg over `pnpm-lock.yaml` and `bun.lock` matches only the third-party effect peer ranges quoted above). Every textual hit outside `vendor/` classifies as one of:

- migration tool function: `packages/migrate/src/{Constructs,Detect,Mapping,Inventory}.ts`, `src/internal/FacadeExports.ts`, `src/flow/Archive.ts`, tests and fixtures; `flows/migrate-smithers-v1/**`; `skills/migrate-smithers-v1/SKILL.md`.
- enforcement literals: `scripts/docs-contract.mjs:265-270` (the banlist naming all six), `scripts/normalize-bunx.ts:39` (`stalePackages`), `flows/pack.test.mjs:406`.
- guard tests asserting absence: `apps/status-site/tests/rcSurfaces.test.ts:45` (`expect(text).not.toContain("smithers-orchestrator")`).
- migration record and guidance: `docs/migration/*`, `docs/pages/migration/*`, `PLAN.md`, `CHANGELOG.md`, `docs/pages/changelogs/*.mdx`, the migrate-tool sections of `docs/llms-full.txt`, `docs/llms-migration.txt`, `packages/cli/docs/llms-full.txt`, `skills/smithers/llms-full.txt`, and the plugin skills' "if the project still depends on `smthrs` or `smithers-orchestrator`" migration pointer (`claude-plugin/skills/smithers/SKILL.md:167`, `codex-plugin/skills/smithers/SKILL.md:131`).
- historical render fixture: `packages/build-cli/test/fixtures/github-render/originals/coordinate.yaml:59` and its test, a 0.x-era workflow YAML in a private package's test data.

`node scripts/docs-contract.mjs` exits 0, so the docs pages themselves are clean against that banlist.

## 4. Obsolete-import scan: PASS

Import-position sweep over the tree excluding `vendor/` and the migrate fixtures:

```
rg -n "(from ['\"]|require\(['\"]|import\(['\"])(smithers-orchestrator|smthrs['\"/]|@smthrs/(graph|scheduler|driver|react-reconciler|components))"
rg -n 'smthrs/jsx(-dev)?-runtime|jsxImportSource["'"'"':= ]*["'"'"']?(smthrs|smithers-orchestrator)'
rg -n "from ['\"][^'\"]*legacy/|require\(['\"][^'\"]*legacy/"
rg -n '@smithers-orchestrator/'
```

Zero live-code hits. Every match is prose or quoted 0.x source: the migration ledger and contract documents, `docs/migration/feature-parity-audit.md` code listings, historical changelogs, and `packages/migrate/src/flow/Contract.ts:132`, where the `import ... from "smthrs"` line sits inside the `old:` template-string literal of a captured 0.x example (verified by reading lines 120-145; the surrounding code is `export const examples` with backtick strings). The only `jsxImportSource: smthrs` settings are in the 0.x fixtures (`flows/migrate-smithers-v1/test/fixtures/smithers-0x-hello/tsconfig.json:12` and its workflow). No file imports a `legacy/` path. `node scripts/check-local-smithers.mjs` exits 0 (`internal scripts run the Smithers working tree`).

## 5. legacy/ absence: PASS

| Command | Exit | Result |
| --- | --- | --- |
| `node scripts/check-legacy-absent.mjs` | 0 | `check-legacy-absent: legacy/ is empty; every 0.x path has been ported or dropped` |
| `test -e legacy` | 1 | directory absent |
| `git ls-files -- legacy | wc -l` | 0 | zero tracked paths |

## Verdict

FAIL. Four of the five scans pass with every hit classified and accounted for. The generated-file scan fails on one finding: `known-files.d.ts` is not reproducible by `scripts/generate-known-files.mjs` in the documented clean-checkout state (704 `//vendor/jj/**` entries appear because `Input.discoverFiles` lacks the repository-boundary rule the glob walk applies), and the `//:knownFiles` Generate target cannot run under any verb (`build`/`test` unsupported, `ci` fails with the unsubstituted `RuntimeBin` placeholder), so no gate catches the drift. The checkout was restored to pristine after evidence capture.
