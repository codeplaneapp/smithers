# Phase 7 gate: scans

Verdict: PASS

This run supersedes `scans-prev-41bfdcb06f.md` (PASS at `41bfdcb06f`) and re-proves the gate at `cd14388ed7`, the tip after the wave-5 and wave-6 fix lanes landed (`git log 41bfdcb06f..HEAD`: 18 commits, 66 files, +9526 -1384; none touches `.gitignore`, `packages/cli/src/Project.ts`, or `smithers-ui.json`). The secret scan, the generated-file scan, the stale-version scan, the obsolete-import scan, and the `legacy/` check pass with every hit classified. The `.smithers/UI.json` blocker closed at `41bfdcb06f` stays closed: a fresh shared clone's first `smithers ls` and `smithers doctor` print nothing on stderr and no `0.x` row.

## Environment

| Item | Value |
| --- | --- |
| Checkout | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-4` |
| HEAD | `cd14388ed782aac6e5f5b23d66c8fa9dc01dd6ba` (2026-08-31 04:08:04 -0700, `chore(wave-6): regenerate known-files.d.ts for the two landed lanes`), branch `v1/rc0-migration` |
| Submodule | `vendor/jj` at `47589ada70c12b3e829b5c98ab32503abad49eac` (`v0.25.0-3759-g47589ada7`), initialized |
| Node | v24.18.0 |
| Bun | 1.4.0 |
| pnpm | 11.21.0 (`corepack pnpm` for the clone install) |
| git | 2.50.1 (Apple Git-155) |
| ripgrep | 14.1.1; `gitleaks` and `trufflehog` are not installed, so the secret scan is a pattern sweep |
| Tracked files | 4773 (`git ls-files \| wc -l`) |
| Install | the frozen install already present in the checkout (`node_modules` from the `00-clean-install` gate); no install step ran in the checkout. The scratch clone received `corepack pnpm install --frozen-lockfile --offline` |
| `apps/ui/.hutch/devkit` | absent in the checkout and in the clone; `apps/ui` postinstall printed the soft `ensure-devkit` warning and exited 0 |
| Date | 2026-08-31, 04:59:33 to 05:08:31 -0700 |
| Load | 11.2 at the start, 18.4 during the read-only sweeps, 63.9 to 97.0 during the drift and docs gates, 75.6 at the end |
| Concurrency | other Phase 7 gates ran in this checkout during the run (`ps` showed `sqlite-gate-4/run-suite.sh engine-store`, `names-and-cycles.mjs`, and node processes under `packages/`). `.flows/cache` appeared at 04:59 from one of them. Every scan below is read-only except `check-llms.mjs`, which regenerates, compares, and restores in one second; the in-place regeneration of `known-files.d.ts`, `.github/workflows/ci.yml`, and `tsconfig.json` that the prior run performed was not repeated because a concurrent gate could read a half-written root file. The `smithers-build lint` drift targets, which are the CI gates for those three files, ran instead and exited 0 |

`SMITHERS_HOME` was unset for every `smithers`, `smithers-build`, and `pnpm` invocation (`env -u SMITHERS_HOME`).

`git status --porcelain` was empty at the start, after the drift targets, after the documentation gates, before and after `check-llms`, and at the end (`porcelain-start.txt`, `porcelain-after-lint.txt`, `porcelain-after-docs.txt`, `porcelain-before-llms.txt`, `porcelain-after-llms.txt`, `porcelain-end.txt` are all zero bytes). HEAD was `cd14388ed7` at the start and at the end.

Tooling note: under this harness `rg` with no positional path blocks reading its stdin pipe; every `rg` below passes `.` and `< /dev/null`.

Raw logs: `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/phase7/scans-logs/` (55 files, copied from the session scratchpad `scans-5/`).

## Summary of commands

All commands ran from the checkout root unless a directory is named.

| Command | Exit | Final line |
| --- | --- | --- |
| `env -u SMITHERS_HOME pnpm exec smithers-build lint '//:knownFiles'` | 0 | `"//:knownFiles",Generate,ran,4485.37...,dcbfebfb18...` (`ok: true`, `failed: 0`) |
| `env -u SMITHERS_HOME pnpm exec smithers-build lint '//:ci'` | 0 | `"//:ci",GithubCiGen,ran,174.41...,f6199f6fba...` (`ok: true`) |
| `env -u SMITHERS_HOME pnpm exec smithers-build lint '//:tsconfig'` | 0 | `"//:tsconfig",Tsconfig,ran,95.97...,270521476b...` (`ok: true`) |
| `node scripts/generate-docs-pages.mjs --check` | 0 | `✓ 43 generated docs pages are current` |
| `node scripts/docs-contract.mjs` | 0 | (silent) |
| `node --experimental-strip-types scripts/generate-theme-registry.ts --check` | 0 | (silent) |
| `node scripts/check-docs.mjs` | 0 | `✓ all 74 anchors the removal messages link to have a heading in the migration guide` |
| `node scripts/check-llms.mjs` | 0 | `✓ 12 documentation artifact(s) are current` |
| `node scripts/check-single-effect-version.mjs` | 0 | `check-single-effect-version: effect@4.0.0-rc.108 everywhere (63 sources)` |
| `node scripts/check-local-smithers.mjs` | 0 | `check-local-smithers: internal scripts run the Smithers working tree` |
| `node scripts/check-legacy-absent.mjs` | 0 | `check-legacy-absent: legacy/ is empty; every 0.x path has been ported or dropped` |
| `test -e legacy` | 1 | directory absent; `git ls-files -- legacy` lists 0 paths |
| `git ls-files .smithers` | 0 | 0 paths |
| `node scans-logs/manifest-audit.mjs` | 0 | `manifests=84 public=42 private=42`, `findings=6` (all 0.x fixtures, section 3.1) |
| `git clone --shared <checkout> <parent>/scans-fresh-clone-5` + `git submodule update --init` + `env -u SMITHERS_HOME corepack pnpm install --frozen-lockfile --offline` | 0 / 0 / 0 | `Done in 3m 30.2s using pnpm v11.21.0` |
| `env -u SMITHERS_HOME node packages/cli/bin/smithers.mjs ls` in the clone (first command) | 0 | stderr 0 bytes; stdout the 10-flow `{"_tag":"flows",...}` listing |
| `env -u SMITHERS_HOME node packages/cli/bin/smithers.mjs doctor` in the clone (second command) | 0 | stderr 0 bytes; 7 report rows, none mentioning `0.x` |

## 1. Secret scan: PASS

Pattern sweep from the checkout root. `rg` honors `.gitignore`, so `node_modules/`, `dist/`, and `.flows/` are excluded; `vendor/jj` is included.

Token patterns (Anthropic `sk-ant-`, OpenAI `sk-`/`sk-proj-`, GitHub `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`/`github_pat_`, AWS `AKIA`/`ASIA`, Slack `xox[baprs]-`, Google `AIza`, npm `npm_`, GitLab `glpat-`, Stripe `sk_live_`/`rk_live_`, SendGrid `SG.`, Hugging Face `hf_`, xAI `xai-`, Groq `gsk_`, Perplexity `pplx-`, PEM private-key headers, three-segment JWTs). One `rg` invocation, exit 0, 13 hits in 6 files (`secret-tokens.txt`):

| Hit | Classification |
| --- | --- |
| `apps/ui/src/mainview/state/seams/KeysSeam.test.ts:60` (`sk-ant-api03-THE-WHOLE-UNMASKED-SECRET-VALUE`) | masking test placeholder; the test asserts it never reaches the client |
| `packages/journal/test/Redaction.test.ts:36,93` (`sk-ant-api03-abcdefgh`) | redaction test input |
| `packages/cli/test/Bug.test.ts:13,20-23` (`ghp_abcdefghijklmnopqrstuvwxyz...`, `github_pat_abcdef...`, `AKIAIOSFODNN7EXAMPLE`, `xoxb-1234567890-abcdef`) | `Bug.scrubText` inputs, each asserted to become `[REDACTED]`; `AKIAIOSFODNN7EXAMPLE` is AWS's documented example key |
| `vendor/jj/lib/tests/test_gpg.rs:19`, `vendor/jj/lib/tests/test_ssh_signing.rs:29` (PGP and OpenSSH private key blocks) | upstream jj signing test fixtures in the pinned submodule |
| `docs/migration/evidence/scans.md:72-74` | the in-tree copy of the prior run of this gate quoting the rows above (3 lines; the prior run had 2 because the table was shorter) |

Generic patterns (`(api|auth|access|secret|client|private)[_-]?(key|token|secret)` assigned a quoted value of 24 or more `[A-Za-z0-9_\-/+=.]` characters, `scheme://user:password@host`, `password` assigned a quoted value of 8 or more characters), case-insensitive, excluding `vendor/` and the lockfiles: 27 hits in 15 files (`secret-generic.txt`). All are test or documentation literals whose credential is `password`, `secret`, `pass`, `hunter2`, `test`, `header-password`, `query-password`, `body-password`, `response-password`, or `step-key-password`: `packages/build/terraform/modules/cache/service/test/{config,server,protocol,postgres}_test.js`, `packages/build/infra/worker/test/protocol-hardening.test.ts:728`, `packages/build/docs/workspace/remote-caching.md:222`, `packages/build-cli/test/Cache.test.ts:153`, `packages/artifacts/test/RemoteArtifacts.test.ts:99`, `packages/integrations/test/ListenerRegistry.test.ts:146`, `packages/model/test/{RequestExecutor,Endpoint,Route}.test.ts`, `packages/cli/test/Bug.test.ts:11-13`, and the in-tree evidence file. `packages/build/terraform/modules/cache/main.tf:25` is a `format("postgres://%s:%s@%s...")` template whose password comes from `var.postgres_password`. The one hit new since the prior run, `packages/model/test/Route.test.ts:100` (`"x-password": "step-key-password"`), is a test that asserts the value is absent from the serialized error (`expect(JSON.stringify(error)).not.toContain("step-key-password")`). The two `${{ secrets.NAME }}` GitHub Actions expressions the prior run listed no longer match because this run's value class excludes `$`, `{`, and spaces; they carry no value either way.

Credential files: `git ls-files` matches no `.env*`, `.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `.keystore`, `.asc`, `.gpg`, `.netrc`, `.pypirc`, `id_rsa*`, `id_ed25519*`, or `service-account*.json`. The ten name matches (`secret-files.txt`) are `.npmrc` (comments only; the file is printed in the log), `packages/build-cli/test/Credentials.test.ts`, `packages/control/src/{Credential,CredentialCipher,CredentialStore,SqlCredentialStore}.ts`, `packages/control/test/{Credential,SqlCredentialStore}.test.ts`, and `apps/review/{action/src,tests/action}/materializeInferenceCredentials*.ts`, TypeScript source that matched the `credential` name pattern.

No real secret in the tree.

## 2. Generated-file scan: PASS

### 2.1 Root files generated from `BUILD.ts`

All three drift targets exit 0 with status `ran` (not a cache hit) and `ok: true`, with `vendor/jj` initialized:

```
$ env -u SMITHERS_HOME pnpm exec smithers-build lint '//:knownFiles'
  "//:knownFiles",Generate,ran,4485.372624999998,dcbfebfb18e769db...   ok: true
$ env -u SMITHERS_HOME pnpm exec smithers-build lint '//:ci'
  "//:ci",GithubCiGen,ran,174.40520800000013,f6199f6fba673b9d...        ok: true
$ env -u SMITHERS_HOME pnpm exec smithers-build lint '//:tsconfig'
  "//:tsconfig",Tsconfig,ran,95.96916699999929,270521476b06c0eb...     ok: true
```

`git status --porcelain` is empty after the three targets. `known-files.d.ts` declares 4667 workspace files (header line 2; the prior run's 4654 plus the wave-5 and wave-6 test files), contains zero `vendor/jj` entries, carries the renamed paths `//smithers-ui.json` (line 4693) and `//apps/ui/e2e/fixtures/repo-plugin/smithers-ui.json` (line 413), and has no `.smithers/UI.json` entry. `.github/workflows/ci.yml` runs `pnpm exec smithers-build lint '//:knownFiles'` under the `Known-file registry drift` step (`BUILD.ts:146`).

The manual in-place regeneration (`node scripts/generate-known-files.mjs`, `smithers-build build '//:ci'`, `smithers-build build '//:tsconfig'` followed by `git diff --exit-code`) that the prior run also performed was skipped this run for the concurrency reason in the Environment table. The lint verb renders the same output and compares it to the tracked file, so the drift proof is the same.

### 2.2 Documentation artifacts

| Generated artifact | Gate | Result |
| --- | --- | --- |
| 12 llms bundles and `packages/cli/docs/SKILL.md` | `node scripts/check-llms.mjs` (regenerates, compares bytes, restores) | current; `git status --porcelain` empty before and after |
| 43 pages under `docs/pages/{cli,control,release,routes}` | `node scripts/generate-docs-pages.mjs --check` (also run by `check-docs.mjs`) | current |
| `docs/pages/**` against the removed-surface banlist | `node scripts/docs-contract.mjs` | clean |
| `packages/ui-styleguide/src/themes/*.ts` (7 files) | `node --experimental-strip-types scripts/generate-theme-registry.ts --check` | current |
| Placeholders, route plan (90 kept assets, 36 deletion rules), sidebar reach (127 routes), compatibility promise (3 places), package counts (40 names), moved trees, 74 migration-guide anchors | `node scripts/check-docs.mjs` | all eight checks pass |

### 2.3 Other files that declare themselves generated

A marker sweep (`Generated by`, `@generated`, `Do not edit`, `DO NOT EDIT`, `AUTO-GENERATED`, `auto-generated`) over tracked non-Markdown files outside `vendor/` finds 38 files (`generated-markers.txt`). 37 are the prior run's set. The 38th, `apps/review/src/walkthrough/renderWalkthroughHtml.ts:127`, matched the lowercase `auto-generated` pattern this run added; the line is a comment describing a UI intro string the walkthrough renders, not a generated-file marker. 11 files are the emitters themselves or tests of them (`packages/targets/src/KnownFile.ts`, `packages/build-cli/src/{GitHooks,GithubRender}.ts`, `packages/create-app/src/router.ts` and its test, `packages/migrate/src/{Report,flow/Contract}.ts`, `packages/migrate/scripts/generate-facade-exports.mjs`, `scripts/generate-theme-registry.ts`, `packages/ui-styleguide/tests/generatedThemes.test.ts`, `packages/ui/src/adapters/xtermCss.ts`), and `docs/migration/disposition-ledger.json` quotes the words. The generated files themselves:

| File | Status |
| --- | --- |
| `known-files.d.ts`, 7 theme files | gated above |
| `Cargo.lock` | cargo's lockfile; the required `rust` and `wasm-repro` CI jobs consume it |
| `packages/migrate/src/internal/FacadeExports.ts` | generated from the 0.x checkout's export graph (`0.35.0`); not reproducible from this tree by design, consumed as a fixed catalog |
| `packages/ui/src/adapters/markdown-editor/crepeTheme.generated.ts` | header names `scripts/generate-ui-themes.ts`, which is not tracked (`git ls-files` has no match). Dangling generator reference inside the private `@smthrs/ui` kit; informational, not a release blocker |
| `packages/create-app/template/{default,aomi}/routes.{gen,ui.gen}.ts` | template content; the generated app's own `//:routes` target checks drift after scaffolding |
| `packages/build-cli/test/fixtures/{git-hooks,github-render}/**` | rendered test fixtures compared by `GithubRender.test.ts` and the hook tests |
| `factory/flows/review-docs.ts:205` | a comment describing output the flow generates |

`packages/jj/wasm/flows_jj.wasm` is a binary artifact with its own reproducibility gate (`wasm-repro`) and is outside a text scan.

## 3. Stale-version scan: PASS

### 3.1 Manifests

`manifest-audit.mjs` parsed all 84 tracked `package.json` files: 42 public (no `"private": true`), 42 private. Every public workspace manifest is versioned `1.0.0-rc.0` with `effect` pinned at exactly `4.0.0-rc.108` (the `smthrs@1.0.0-rc.0` deprecation stub in `packages/smthrs-deprecation` has no `effect` dependency). No public manifest carries `0.35.0` or `0.1.0`. The two remaining "public" manifests are `packages/build-cli/test/fixtures/viem-node-spec/{,src/}package.json` (`viem-fixture@1.0.0`, `viem@1.0.0`), test fixtures inside a private package and outside the workspace globs.

The eight manifests at `0.1.0` (`@smthrs/{build,build-cli,chain,create-app,fs,scorers,targets,triggers}`) are all `private: true` per rc-contract section 3.2 and never pack (`manifests-0.1.0-0.35.0.txt`). No manifest is at `0.35.0`.

The six findings are 0.x fixtures the migration tool transforms, which is their function:

| Fixture manifest | Stale content |
| --- | --- |
| `packages/migrate/test/fixtures/batch-issues/package.json` | `smithers-orchestrator ^0.32.0` |
| `packages/migrate/test/fixtures/{mixed-api,plue-pack}/.smithers/package.json` | `smithers-orchestrator 0.32.0` |
| `packages/migrate/test/fixtures/{jsx-single,persisted-db}/package.json`, `flows/migrate-smithers-v1/test/fixtures/smithers-0x-hello/package.json` | `smthrs 0.35.0`, `effect 4.0.0-beta.105` |

Fixtures do not ship: `@smthrs/migrate` `files` is `["src/**", "dist/**", LICENSE, README, CHANGELOG]`, and fixture directories are outside the pnpm workspace globs.

### 3.2 Effect

`check-single-effect-version` exits 0 (`effect@4.0.0-rc.108 everywhere (63 sources)`). `pnpm-lock.yaml` resolves `effect@4.0.0-rc.108` only (lines 10265 and 20367, one importer block each) and `bun.lock` has one `effect` resolution, `effect@4.0.0-rc.108` (line 4041). The 36 `4.0.0-beta` lines in 26 files outside the lockfiles (`effect-beta-files.txt`, the same counts as the prior run) are: the fixtures above and the migrate tests that assert the detector reports them (`packages/migrate/test/{Detect,Scan,flow/Archive}.test.ts`, `flows/pack.test.mjs`); the vendor-fork attribution `effect@4.0.0-beta.102` in `THIRD_PARTY_NOTICES.md`, `packages/{engine,flow}/THIRD_PARTY_NOTICES.md`, `packages/engine/VENDOR.md`, `docs/pages/comparisons.md` and its llms renderings; the migration record (`docs/migration/{disposition-ledger,rc-contract}.*`, the in-tree evidence file); and historical changelog entries (`CHANGELOG.md`, `packages/chain/CHANGELOG.md`, `docs/pages/changelogs/{0.32.0,0.34.0}.mdx`). The 22 lockfile lines (`effect-beta-lock.txt`) are third-party peer ranges (`@distilled.cloud/*`, `@alchemy.run/*`, `alchemy` declare `effect: '>=4.0.0-beta.104 || >=4.0.0'` or `beta.105`), not resolutions.

### 3.3 `0.35.0`

171 lines in 62 files outside `vendor/` and the lockfiles (`v0350-files.txt`; the prior run's 161 in 55 plus the evidence files committed since); neither lockfile mentions `0.35.0` (`rg -c` exits 1 on both). Every hit is intentional product or record content: the operator message `bunx smthrs@0.35.0 ps` in `packages/cli/src/{Legacy,Project}.ts` and the tests that pin it (`packages/cli/test/{Legacy,Project}.test.ts`, `scripts/normalize-bunx.{ts,test.ts}`); `packages/cli/test/Update.test.ts`, which asserts that an rc.0 install is not told to downgrade to the `latest` tag that stays on 0.35.0; `docs/pages/changelogs/0.35.0.mdx`, its route rows in `docs/pages/routes.md`, `docs/pages/changelogs/index.md`, `docs/llms-operations.txt`, `scripts/docs-routes.test.mjs`, `scripts/generate-llms.test.mjs`, and its two path entries in `known-files.d.ts`; `packages/smthrs-deprecation/README.md` dist-tag notes; `docs/releases/1.0.0-rc.0.md`, `docs/migration/publish-runbook.md`, and `docs/internal/release-runbook.md` naming the `latest` tag; `docs/pages/migration/{1.0,migrate-tool}.md` (the 0.x command operators run); the migrate tool's version tables (`packages/migrate/src/{Detect,Constructs,internal/Semver,internal/FacadeExports}.ts`); `apps/bug-worker` sample payloads (`README.md`, `tests/smithersBugPayload.test.ts`); `flows/pack.test.mjs` and the two fixture `FIXTURE.md` files; the migration ledger, plan, contract, removed-API list, verification evidence, and the 16 per-gate evidence files under `docs/migration/evidence/`.

### 3.4 Removed package names

`smithers-orchestrator`, `@smithers-orchestrator/*`, `@smthrs/graph`, `@smthrs/scheduler`, `@smthrs/driver`, `@smthrs/react-reconciler`, `@smthrs/components`: both lockfiles resolve none of them (`rg` over `pnpm-lock.yaml` and `bun.lock` exits 1, `old-names-lock.txt` is empty). The only unscoped `smthrs` entries in the lockfiles are the workspace deprecation stub (`bun.lock:375,1676,5377`, `smthrs@workspace:packages/smthrs-deprecation`).

407 textual lines in 66 files outside `vendor/` and the lockfiles (`old-names.txt`; the prior run's 402 in 65 plus `docs/migration/evidence/npm-pack.md`), by class:

- Migration tool function (205 lines in `packages/migrate`, plus `flows/migrate-smithers-v1/**` and `skills/migrate-smithers-v1/SKILL.md:14`): `src/{internal/FacadeExports,Detect,Inventory,Constructs,Mapping,flow/Archive}.ts`, their tests, and the 0.x fixtures under `test/fixtures/{plue-pack,mixed-api,batch-issues}`.
- Enforcement literals (10): `scripts/docs-contract.mjs:265-270` (the banlist naming all six), `scripts/docs-contract.test.mjs:248-249`, `scripts/normalize-bunx.ts:39` (`stalePackages`), `scripts/normalize-bunx.test.ts:9`.
- Guard tests asserting absence (2): `apps/status-site/tests/rcSurfaces.test.ts:10,45` (`expect(text).not.toContain("smithers-orchestrator")`).
- Migration record and guidance (134 lines in `docs/migration`, 20 in `docs/pages`, plus `PLAN.md`, `CHANGELOG.md`, `docs/llms-full.txt`, `docs/llms-migration.txt`, `packages/cli/docs/llms-full.txt`, `skills/smithers/llms-full.txt`, and the plugin skills' "if the project still depends on `smthrs` or `smithers-orchestrator`" pointer at `claude-plugin/skills/smithers/SKILL.md:167` and `codex-plugin/skills/smithers/SKILL.md:131`).
- Historical render fixture (2): `packages/build-cli/test/fixtures/github-render/originals/coordinate.yaml:59` and `packages/build-cli/test/GithubRender.test.ts:659`, a 0.x-era workflow YAML in a private package's test data.

The residue after excluding `docs/`, `PLAN.md`, `CHANGELOG.md`, `research/`, `packages/migrate`, `flows/migrate-smithers-v1`, `skills/`, and the llms renderings is exactly the enforcement literals, the guard test, the plugin-skill pointers, and the render fixture (16 lines, printed in the log). `node scripts/docs-contract.mjs` exits 0, so the docs pages are clean against the banlist.

## 4. Obsolete-import scan: PASS

### 4.1 Import-position and JSX-runtime sweeps

```
rg -n "(from ['\"]|require\(['\"]|import\(['\"]|import ['\"])(smithers-orchestrator|smthrs['\"/]|@smthrs/(graph|scheduler|driver|react-reconciler|components)|@smithers-orchestrator/)" --glob '!vendor/**' --glob '!packages/migrate/test/fixtures/**' --glob '!flows/migrate-smithers-v1/test/fixtures/**' . < /dev/null
rg -n 'smthrs/jsx(-dev)?-runtime|smithers-orchestrator/jsx(-dev)?-runtime|jsxImportSource["'"'"':= ]*["'"'"']?(smthrs|smithers-orchestrator)' --glob '!vendor/**' . < /dev/null
rg -n "(from ['\"][^'\"]*legacy/|require\(['\"][^'\"]*legacy/|import\(['\"][^'\"]*legacy/)" --glob '!vendor/**' . < /dev/null
```

Import-position sweep (`import-a.txt`): 44 lines, 41 in `docs/`, `PLAN.md`, `CHANGELOG.md`, or `research/` (migration ledger and contract prose, `docs/migration/feature-parity-audit.md` code listings, historical changelogs, the evidence files, `research/xstate-integration.md`). The three outside documentation are unchanged from the prior run:

| Hit | Classification |
| --- | --- |
| `packages/migrate/src/flow/Contract.ts:132` `import { closeSingleRunnerRuntime, createSmithers, runWorkflow } from "smthrs"` | inside the `old:` template-string literal of a captured 0.x example |
| `packages/migrate/test/Detect.test.ts:465` | a string literal fed to the detector |
| `apps/ui/src/bun/Repos.test.ts:45` | a string the test writes into a scratch `PACKAGE.ts` to exercise workspace detection |

JSX-runtime sweep (`import-b.txt`): 123 lines; 46 in `docs/migration`, 11 in `docs/pages`, 12 in the `docs/llms-*.txt` renderings, 1 in `docs/releases`, 31 in `packages/migrate` (source, tests, and 0.x fixtures), 6 in `packages/cli/docs/llms-full.txt`, 1 in `packages/smthrs-deprecation/README.md`, 7 in `skills/`, 3 in the `flows/migrate-smithers-v1` fixture, 2 in `scripts/docs-contract.mjs` (the banlist), and the `README.md` and `PLAN.md` sentences stating that the runtime does not exist. After excluding those classes the residue is empty. The only `jsxImportSource` settings in JSON files are `react` in `packages/ui/tsconfig.json:9`, `@opentui/react` in `apps/tui/tsconfig.json:14`, and the 0.x fixture tsconfigs (`flows/migrate-smithers-v1/test/fixtures/smithers-0x-hello`, `packages/migrate/test/fixtures/{jsx-single,persisted-db,plue-pack/.smithers}`). No live module carries a JSX pragma or runtime import.

`legacy/` import sweep (`import-c.txt`): 0 hits, `rg` exits 1. A wider `legacy/` word sweep over non-Markdown files outside `docs/` (`import-d.txt`, 16 lines, the prior run's set) finds only the gate itself (`scripts/check-legacy-absent.mjs`), the `exclude` entries in `BUILD.ts` and generated `tsconfig.json` with their pins in `packages/targets/test/GeneratedRootFiles.test.ts` and `packages/flows/test/vitestCoverageIsolation.test.ts`, `scripts/check-local-smithers.test.mjs` (asserts nothing under `legacy/` is scanned), a comment in `apps/ui/src/mainview/chain/deps.test.ts:134`, and the sentence at `smithers-ui.json:158`.

`node scripts/check-local-smithers.mjs` exits 0.

### 4.2 Removed-package imports in Plue

Out of scope for this lane; the `plue-cutover` gate owns those scans.

### 4.3 Prior blocker stays closed: no tracked `.smithers/` at the repository root

`git ls-files .smithers` prints nothing at `cd14388ed7`. `git check-ignore -v .smithers/UI.json` answers `.gitignore:98:/.smithers/*`. The 96 tracked paths that contain a `.smithers/` segment are all below the root, inside 0.x fixtures (`packages/migrate/test/fixtures/{batch-issues,mixed-api,persisted-db,plue-pack}`, 77 paths; `flows/migrate-smithers-v1/test/fixtures/smithers-0x-hello`, 8), the private build-system fixtures and templates (`packages/build-cli/test/fixtures/force-spec`, 3; `packages/create-app/template/{default,aomi}`, 6), and the UI Playwright fixture (`apps/ui/e2e/fixtures/repo-plugin/{,tools/}.smithers/WORKSPACE.ts`, 2). `legacyState` (`packages/cli/src/Project.ts`) walks from `cwd` upward only, so none of them is visible from the repository root.

Reproduction in one fresh clone. `git clone --shared <checkout> <parent>/scans-fresh-clone-5` (parent `.../migration/`), verified at HEAD `cd14388ed782aac6e5f5b23d66c8fa9dc01dd6ba`, `git submodule update --init` (checked out `47589ada70`), installed with `env -u SMITHERS_HOME corepack pnpm install --frozen-lockfile --offline` (exit 0, `Done in 3m 30.2s` under load 64 to 97; `git status --porcelain` empty afterwards; `.flows` absent before the first command), and probed with the clone's own `packages/cli/bin/smithers.mjs`. The clone was removed after the probes (05:08:25).

First command:

```
$ git ls-files .smithers | wc -l
0
$ env -u SMITHERS_HOME node packages/cli/bin/smithers.mjs ls
exit=0
stderr: (0 bytes)
stdout: { "_tag": "flows", "items": [ ...10 create-flow/* and create-skill/* flows... ] }   (1941 bytes)
```

`grep -c -i '0\.x'` over stdout is 0.

Second command:

```
$ env -u SMITHERS_HOME node packages/cli/bin/smithers.mjs doctor
exit=0
stderr: (0 bytes)
stdout:
smithers doctor — <clone>
warn registry: <clone>/flows holds no flow.ts or flow.mdx; discovery finds nothing
ok   state: <clone>/.flows
ok   database <clone>/.flows/control.db: 4 migrations applied, latest 1002
ok   database <clone>/.flows/engine.db: 8 migrations applied, latest 4001
ok   node: v24.18.0
ok   jj: /opt/homebrew/bin/jj
ok   providers: OPENAI_API_KEY, CEREBRAS_API_KEY
```

No `smithers 0.x` row; `grep -c -i '0\.x'` over stdout and stderr is 0. The `warn registry` row is expected: the repository's `flows/` holds `migrate-smithers-v1`, which is a directory of test fixtures and a `pack.test.mjs`, not a `flow.ts`. The prior run's positive control (a project with `.smithers/UI.json` at the old location trips the detector) was not repeated; the detector source `packages/cli/src/Project.ts` is unchanged between `41bfdcb06f` and `cd14388ed7` (`git diff --name-only` does not list it).

Install warnings in the clone are the ones `00-clean-install.md` already classifies: the `kernel`/`platform-browser` cyclic workspace dependency, `Failed to create bin ... smithers-migrate` (twice; the bin lives under an unbuilt `dist/`), and the soft `apps/ui postinstall: ensure-devkit: electrobun prepare exited by signal (continuing ...)`.

### 4.4 Informational findings, not blockers

Carried from the prior run, unchanged:

1. The private build system keeps `.smithers/WORKSPACE.ts` as a workspace-declaration location (`packages/build-cli/src/PackageDiscovery.ts`, `apps/ui/src/bun/Targets.ts`, and the `packages/create-app/template/{default,aomi}/.smithers/` scaffold). Nothing on the rc.0 public surface creates that layout: `@smthrs/create-app` and `@smthrs/build-cli` are `private: true` at `0.1.0`, `smithers init` writes `flows/<name>/flow.mdx` and `.flows/` only, and this repository's own root declares `BUILD.ts` with no `.smithers/`. It becomes a blocker the day either package is published or `init` adopts the template.
2. `.gitignore:96-98` still carries the comment "The repository's own UI plugin manifest ... is source, not run state" and the `!/.smithers/` plus `/.smithers/*` pair that once framed the deleted `!/.smithers/UI.json` exception. The net effect is a fully ignored directory; the comment is stale.
3. `packages/ui/src/adapters/markdown-editor/crepeTheme.generated.ts` names an untracked generator (section 2.3).
4. `gitleaks` and `trufflehog` are not installed on this host, so the secret scan is the pattern sweep in section 1 rather than an entropy scan.

## 5. `legacy/` absence: PASS

| Command | Exit | Result |
| --- | --- | --- |
| `node scripts/check-legacy-absent.mjs` | 0 | `check-legacy-absent: legacy/ is empty; every 0.x path has been ported or dropped` |
| `test -e legacy` | 1 | directory absent |
| `git ls-files -- legacy` | 0 paths | nothing tracked |

## Verdict

PASS. At `cd14388ed7` the secret sweep finds only test placeholders, upstream jj fixtures, and evidence quotations; `known-files.d.ts`, `.github/workflows/ci.yml`, and `tsconfig.json` pass their `smithers-build lint` drift targets with `vendor/jj` initialized; every documentation artifact gate is current; every public manifest is `1.0.0-rc.0` on `effect@4.0.0-rc.108`, no public manifest is at `0.35.0` or `0.1.0`, and neither lockfile resolves a removed package name or a beta Effect; no live module imports a removed package, a 0.x JSX runtime, or `legacy/`; and `legacy/` is absent. The repository tracks nothing under `.smithers/`, and a fresh clone's first `smithers ls` and `smithers doctor` print no 0.x notice and no `smithers 0.x` row. The checkout is pristine after evidence capture (`git status --porcelain` empty, HEAD unchanged) and the scratch clone is removed.
