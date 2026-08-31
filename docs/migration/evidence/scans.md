# Phase 7 gate: scans

Verdict: PASS

This run supersedes the earlier evidence file for the same gate, which recorded FAIL at `163fdf4bf5` with one remaining blocker: the tracked `.smithers/UI.json` collided with the CLI's `legacyMarkers` (`packages/cli/src/Project.ts:31`), so a fresh clone's first `smithers ls` printed the rc-contract section 6 0.x notice and `smithers doctor` reported a `warn smithers 0.x` row. `41bfdcb06f` (`fix(ui): move the repo UI manifest out of .smithers/ so rc.0 clones stop warning about 0.x state`, 16 files, +63 -30) renames `.smithers/UI.json` to `smithers-ui.json` at the repository root, renames the Playwright fixture the same way, drops the `!/.smithers/UI.json` exception from `.gitignore`, and points `apps/ui/src/bun/RepoPlugin.ts:14`, `apps/shared/src/LocalApp.ts`, `apps/ui/docs/LOCAL-APP.md:82`, `TargetCards.tsx:501`, and both Playwright specs at the new name. The blocker is closed and re-proven below: two fresh shared clones of `41bfdcb06f` with a frozen offline install print nothing on stderr for a first `smithers ls` and show no `0.x` row in a first `smithers doctor`, `git ls-files .smithers` is empty in both, and the positive control (the old `.smithers/UI.json` layout) still trips the detector, so the silence is the fix and not a broken detector.

The secret scan, the generated-file scan, the stale-version scan, the obsolete-import scan, and the `legacy/` check pass with every hit classified.

## Environment

| Item | Value |
| --- | --- |
| Checkout | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-3` |
| HEAD | `41bfdcb06f0fa3a7d01b0b9e0242c663802d0f78` (2026-08-31 00:43:32 -0700), detached |
| Submodule | `vendor/jj` at `47589ada70c12b3e829b5c98ab32503abad49eac` (`v0.25.0-3759-g47589ada7`), initialized |
| Node | v24.18.0 |
| Bun | 1.4.0 |
| pnpm | 11.21.0 (via `corepack pnpm` for the clone installs) |
| git | 2.50.1 (Apple Git-155) |
| ripgrep | 14.1.1; `gitleaks` and `trufflehog` are not installed, so the secret scan is a pattern sweep |
| Tracked files | 4760 (`git ls-files \| wc -l`) |
| Install | the frozen install already present in the checkout; no install step ran in the checkout. The two scratch clones each received `corepack pnpm install --frozen-lockfile --offline` |
| `apps/ui/.hutch/devkit` | electrobun 2.0.1 projection copied from the maintainer checkout (gitignored; `electrobun prepare` blocks on a hutch lock another session holds). Documented setup state. No scan reads it: `rg` and `git ls-files` skip ignored paths. The scratch clones have no projection; their `apps/ui` postinstall printed the soft `ensure-devkit` warning and exited 0 |
| Date | 2026-08-31, 00:47:55 to 01:07:53 -0700 |
| Load | 2.62 at start, 1.90 before the drift targets, 2.45 before clone 1, 5.82 before clone 2, 4.72 at the end; below the 40 threshold, so the read-only sweeps ran in parallel and the file-writing steps ran serially |
| Concurrency | `ps` showed no other process rooted in the checkout; `.flows/` (`cache/`, `control.db`) already existed from an earlier gate |

`SMITHERS_HOME` was unset (`env -u SMITHERS_HOME`) for every `smithers`, `smithers-build`, `pnpm`, and script invocation.

`git status --porcelain` was empty before the scans, after the drift targets, after the manual regeneration, after the documentation gates, and at the end (`porcelain-start.txt`, `porcelain-after-lint.txt`, `porcelain-before-regen.txt`, `porcelain-after-regen.txt`, `porcelain-after-docs.txt`, `porcelain-end.txt` are all zero bytes). The regeneration step rewrote `known-files.d.ts`, `.github/workflows/ci.yml`, and `tsconfig.json` in place and `git diff --exit-code` on each returned 0, so nothing needed restoring.

Tooling note: under this harness `rg` with no positional path blocks reading its stdin pipe. The first attempt at the tree-wide sweeps timed out at 120 s for that reason and wrote nothing; every `rg` below passes `.` and `< /dev/null`, and each finished in under a second.

Raw logs: `/private/tmp/claude-501/-Users-williamcory-smithers/b0a4ab15-ceef-429c-8898-089a3db0bc0d/scratchpad/scans-4/`.

## Summary of commands

All commands ran from the checkout root unless a directory is named.

| Command | Exit | Final line |
| --- | --- | --- |
| `pnpm exec smithers-build lint '//:knownFiles'` | 0 | `"//:knownFiles",Generate,ran,642.44...` (`ok: true`) |
| `pnpm exec smithers-build lint '//:ci'` | 0 | `"//:ci",GithubCiGen,ran,19.50...` (`ok: true`) |
| `pnpm exec smithers-build lint '//:tsconfig'` | 0 | `"//:tsconfig",Tsconfig,ran,16.24...` (`ok: true`) |
| `node scripts/generate-known-files.mjs` then `git diff --exit-code --stat -- known-files.d.ts` | 0 / 0 | no diff |
| `pnpm exec smithers-build build '//:ci'` then `git diff --exit-code --stat -- .github/workflows/ci.yml` | 0 / 0 | no diff |
| `pnpm exec smithers-build build '//:tsconfig'` then `git diff --exit-code --stat -- tsconfig.json` | 0 / 0 | no diff |
| `grep -c 'vendor/jj' known-files.d.ts` | 1 (no match) | `0` |
| `node scripts/check-llms.mjs` | 0 | `✓ 12 documentation artifact(s) are current` |
| `node scripts/generate-docs-pages.mjs --check` | 0 | `✓ 43 generated docs pages are current` |
| `node scripts/docs-contract.mjs` | 0 | (silent) |
| `node --experimental-strip-types scripts/generate-theme-registry.ts --check` | 0 | (silent) |
| `node scripts/check-docs.mjs` | 0 | `✓ all 74 anchors the removal messages link to have a heading in the migration guide` |
| `node scripts/check-single-effect-version.mjs` | 0 | `check-single-effect-version: effect@4.0.0-rc.108 everywhere (63 sources)` |
| `node scripts/check-local-smithers.mjs` | 0 | `check-local-smithers: internal scripts run the Smithers working tree` |
| `node scripts/check-legacy-absent.mjs` | 0 | `check-legacy-absent: legacy/ is empty; every 0.x path has been ported or dropped` |
| `test -e legacy` | 1 | directory absent; `git ls-files -- legacy` lists 0 paths |
| `git ls-files .smithers` | 0 | 0 paths |
| `git clone --shared <checkout> <parent>/scans-fresh-clone-1` + `corepack pnpm install --frozen-lockfile --offline` | 0 / 0 | `Done in 2m 49s using pnpm v11.21.0` |
| `env -u SMITHERS_HOME node packages/cli/bin/smithers.mjs ls` in clone 1 (first command) | 0 | stderr 0 bytes; stdout the 10-flow `{"_tag":"flows",...}` listing |
| `git clone --shared <checkout> <parent>/scans-fresh-clone-2` + `corepack pnpm install --frozen-lockfile --offline` | 0 / 0 | `Done in 2m 36.2s using pnpm v11.21.0` |
| `env -u SMITHERS_HOME node packages/cli/bin/smithers.mjs doctor` in clone 2 (first command) | 0 | stderr 0 bytes; 7 report rows, none mentioning `0.x` |

## 1. Secret scan: PASS

Pattern sweep from the checkout root. `rg` honors `.gitignore`, so `node_modules/`, `dist/`, `.flows/`, and `apps/ui/.hutch/` are excluded; `vendor/jj` is included.

Token patterns (Anthropic `sk-ant-`, OpenAI `sk-`, GitHub `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`/`github_pat_`, AWS `AKIA`/`ASIA`, Slack `xox[baprs]-`, Google `AIza`, npm `npm_`, GitLab `glpat-`, Stripe `sk_live_`/`rk_live_`, SendGrid `SG.`, Hugging Face `hf_`, xAI `xai-`, Groq `gsk_`, Perplexity `pplx-`, PEM private-key headers, three-segment JWTs). One `rg` invocation, exit 0, 12 hits (`secret-tokens.txt`):

| Hit | Classification |
| --- | --- |
| `apps/ui/src/mainview/state/seams/KeysSeam.test.ts:60` (`sk-ant-api03-THE-WHOLE-UNMASKED-SECRET-VALUE`) | masking test placeholder |
| `packages/journal/test/Redaction.test.ts:36,93` (`sk-ant-api03-abcdefgh`) | redaction test input |
| `packages/cli/test/Bug.test.ts:13,20-23` (`ghp_abcdefghijklmnopqrstuvwxyz...`, `github_pat_abcdef...`, `AKIAIOSFODNN7EXAMPLE`, `xoxb-1234567890-abcdef`) | scrub test inputs; `AKIAIOSFODNN7EXAMPLE` is AWS's documented example key |
| `vendor/jj/lib/tests/test_gpg.rs:19`, `vendor/jj/lib/tests/test_ssh_signing.rs:29` (PGP and OpenSSH private key blocks) | upstream jj signing test fixtures in the pinned submodule |
| `docs/migration/evidence/scans.md:40-41` | the in-tree copy of an earlier run of this gate quoting the rows above |

Generic patterns (`(api|auth|access|secret|client|private)[_-]?(key|token|secret) = "<24+ chars>"`, `scheme://user:password@host`, `password = "<8+ chars>"`), excluding `vendor/` and the lockfiles: 28 hits (`secret-generic.txt`). 25 are test or documentation literals whose credential is `password`, `secret`, `pass`, `hunter2`, `test`, `header-password`, `query-password`, `body-password`, or `response-password` (`packages/build/terraform/modules/cache/service/test/{config,server,protocol,postgres}_test.js`, `packages/build/infra/worker/test/protocol-hardening.test.ts:728`, `packages/build/docs/workspace/remote-caching.md:222`, `packages/build-cli/test/Cache.test.ts:153`, `packages/artifacts/test/RemoteArtifacts.test.ts:99`, `packages/integrations/test/ListenerRegistry.test.ts:146`, `packages/model/test/{RequestExecutor,Endpoint}.test.ts`, `packages/cli/test/Bug.test.ts:11-13`, and the in-tree evidence file). The other 3: `packages/build-cli/test/GithubRender.test.ts:648-649` are GitHub Actions `${{ secrets.NAME }}` expressions with no value, and `packages/build/terraform/modules/cache/main.tf:25` is a `format("postgres://%s:%s@%s...")` template whose password comes from `var.postgres_password`.

Credential files: `git ls-files` matches no `.env*`, `.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `.keystore`, `.asc`, `.gpg`, `.netrc`, `.pypirc`, `id_rsa*`, `id_ed25519*`, or `service-account*.json`. The seven name matches are `.npmrc` (comments only, printed in the log), `packages/build-cli/test/Credentials.test.ts`, `packages/control/src/{CredentialStore,SqlCredentialStore}.ts`, `packages/control/test/SqlCredentialStore.test.ts`, and `apps/review/{action/src,tests/action}/materializeInferenceCredentials*.ts` (TypeScript source that matched the `credentials*` name pattern).

No real secret in the tree.

## 2. Generated-file scan: PASS

### 2.1 Root files generated from `BUILD.ts`

All three drift targets exit 0 with status `ran` (not a cache hit), and the manual regeneration confirms byte identity with `vendor/jj` initialized:

```
$ pnpm exec smithers-build lint '//:knownFiles'
  "//:knownFiles",Generate,ran,642.4452090000002,a97a071dd4...   ok: true
$ pnpm exec smithers-build lint '//:ci'
  "//:ci",GithubCiGen,ran,19.508624999999938,2c718c44e0...        ok: true
$ pnpm exec smithers-build lint '//:tsconfig'
  "//:tsconfig",Tsconfig,ran,16.247292000000016,15c47b829a...     ok: true
$ node scripts/generate-known-files.mjs && git diff --exit-code --stat -- known-files.d.ts   # exit 0, no output
$ pnpm exec smithers-build build '//:ci' && git diff --exit-code --stat -- .github/workflows/ci.yml   # exit 0
$ pnpm exec smithers-build build '//:tsconfig' && git diff --exit-code --stat -- tsconfig.json          # exit 0
```

`known-files.d.ts` declares 4654 workspace files (header line 2), matching the generator, and contains zero `vendor/jj` entries. It carries the renamed paths `//smithers-ui.json` (line 4680) and `//apps/ui/e2e/fixtures/repo-plugin/smithers-ui.json` (line 413) and no `.smithers/UI.json` entry. `.github/workflows/ci.yml:90` runs `pnpm exec smithers-build lint '//:knownFiles'` and line 85 runs `lint '//:ci'`.

### 2.2 Documentation artifacts

| Generated artifact | Gate | Result |
| --- | --- | --- |
| 12 llms bundles and `packages/cli/docs/SKILL.md` | `node scripts/check-llms.mjs` (regenerates, compares bytes, restores) | current |
| 43 pages under `docs/pages/{cli,control,release,routes}` | `node scripts/generate-docs-pages.mjs --check` (also run by `check-docs.mjs`) | current |
| `docs/pages/**` against the removed-surface banlist | `node scripts/docs-contract.mjs` | clean |
| `packages/ui-styleguide/src/themes/*.ts` (7 files) | `node --experimental-strip-types scripts/generate-theme-registry.ts --check` | current |
| Sidebar reach (127 routes), compatibility promise (3 places), package counts (40 names), moved trees, 74 migration-guide anchors | `node scripts/check-docs.mjs` | all five checks pass |

### 2.3 Other files that declare themselves generated

A marker sweep (`Generated by`, `@generated`, `Do not edit`, `DO NOT EDIT`, `AUTO-GENERATED`) over tracked non-Markdown files outside `vendor/` finds 37 files (`generated-markers.txt`), the same set as the prior run. 11 are the emitters themselves or tests of them (`packages/targets/src/KnownFile.ts`, `packages/build-cli/src/{GitHooks,GithubRender}.ts`, `packages/create-app/src/router.ts` and its test, `packages/migrate/src/{Report,flow/Contract}.ts`, `packages/migrate/scripts/generate-facade-exports.mjs`, `scripts/generate-theme-registry.ts`, `packages/ui-styleguide/tests/generatedThemes.test.ts`, `packages/ui/src/adapters/xtermCss.ts`), and `docs/migration/disposition-ledger.json` quotes the words. The generated files themselves:

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

The eight manifests at `0.1.0` (`@smthrs/{build,build-cli,chain,create-app,fs,scorers,targets,triggers}`) are all `private: true` per rc-contract section 3.2 and never pack.

The six findings are 0.x fixtures the migration tool transforms, which is their function:

| Fixture manifest | Stale content |
| --- | --- |
| `packages/migrate/test/fixtures/batch-issues/package.json` | `smithers-orchestrator ^0.32.0` |
| `packages/migrate/test/fixtures/{mixed-api,plue-pack}/.smithers/package.json` | `smithers-orchestrator 0.32.0` |
| `packages/migrate/test/fixtures/{jsx-single,persisted-db}/package.json`, `flows/migrate-smithers-v1/test/fixtures/smithers-0x-hello/package.json` | `smthrs 0.35.0`, `effect 4.0.0-beta.105` |

Fixtures do not ship: `@smthrs/migrate` `files` is `["src/**", "dist/**", LICENSE, README, CHANGELOG]`, and fixture directories are outside the pnpm workspace globs.

### 3.2 Effect

`check-single-effect-version` exits 0 (`effect@4.0.0-rc.108 everywhere (63 sources)`). The 36 `4.0.0-beta` lines in 26 files outside the lockfiles (`effect-beta-files.txt`) are: the fixtures above and the migrate tests that assert the detector reports them (`packages/migrate/test/{Detect,Scan,flow/Archive}.test.ts`, `flows/pack.test.mjs`); the vendor-fork attribution `effect@4.0.0-beta.102` in `THIRD_PARTY_NOTICES.md`, `packages/{engine,flow}/THIRD_PARTY_NOTICES.md`, `packages/engine/VENDOR.md`, `docs/pages/comparisons.md` and its llms renderings; the migration record (`docs/migration/{disposition-ledger,rc-contract}.*`, the in-tree evidence file); and historical changelog entries. The 22 lockfile lines (`effect-beta-lock.txt`) are third-party peer ranges (`@distilled.cloud/*`, `@alchemy.run/*`, `alchemy` declare `effect: '>=4.0.0-beta.104 || >=4.0.0'` or `beta.105`), not resolutions.

### 3.3 `0.35.0`

161 lines in 55 files outside `vendor/` and the lockfiles (`v0350-files.txt`); neither lockfile mentions `0.35.0` (`rg -c` exits 1 on both). Every hit is intentional product or record content: the operator message `bunx smthrs@0.35.0 ps` in `packages/cli/src/{Legacy,Project}.ts` and the tests that pin it (`packages/cli/test/{Legacy,Project}.test.ts`, `scripts/normalize-bunx.{ts,test.ts}`); `packages/cli/test/Update.test.ts`, which asserts that an rc.0 install is not told to downgrade to the `latest` tag that stays on 0.35.0; `docs/pages/changelogs/0.35.0.mdx`, its route rows in `docs/pages/routes.md`, `docs/pages/changelogs/index.md`, `docs/llms-operations.txt`, `scripts/docs-routes.test.mjs`, `scripts/generate-llms.test.mjs`, and its two path entries in `known-files.d.ts`; `packages/smthrs-deprecation/README.md` dist-tag notes; `docs/releases/1.0.0-rc.0.md`, `docs/migration/publish-runbook.md`, and `docs/internal/release-runbook.md` naming the `latest` tag; `docs/pages/migration/{1.0,migrate-tool}.md` (the 0.x command operators run); the migrate tool's version tables (`packages/migrate/src/{Detect,Constructs,internal/Semver,internal/FacadeExports}.ts`); `apps/bug-worker` sample payloads (`README.md`, `tests/smithersBugPayload.test.ts`); the migration ledger, plan, and evidence files.

### 3.4 Removed package names

`smithers-orchestrator`, `@smithers-orchestrator/*`, `@smthrs/graph`, `@smthrs/scheduler`, `@smthrs/driver`, `@smthrs/react-reconciler`, `@smthrs/components`: both lockfiles resolve none of them (`rg` over `pnpm-lock.yaml` and `bun.lock` exits 1). The only unscoped `smthrs` entries in the lockfiles are the workspace deprecation stub (`bun.lock:375,1676,5373`, `smthrs@workspace:packages/smthrs-deprecation`).

402 textual lines in 65 files outside `vendor/` and the lockfiles (`old-names.txt`), the same counts as the prior run, by class:

- Migration tool function (205 lines in `packages/migrate`, plus `flows/migrate-smithers-v1/**` and `skills/migrate-smithers-v1/SKILL.md:14`): `src/{internal/FacadeExports,Detect,Inventory,Constructs,Mapping,flow/Archive}.ts`, their tests, and the 0.x fixtures under `test/fixtures/{plue-pack,mixed-api,batch-issues}`.
- Enforcement literals (10): `scripts/docs-contract.mjs:265-270` (the banlist naming all six), `scripts/docs-contract.test.mjs:236-237`, `scripts/normalize-bunx.ts:39` (`stalePackages`), `scripts/normalize-bunx.test.ts:9`.
- Guard tests asserting absence (2): `apps/status-site/tests/rcSurfaces.test.ts:10,45` (`expect(text).not.toContain("smithers-orchestrator")`).
- Migration record and guidance (129 lines in `docs/migration`, 20 in `docs/pages`, plus `PLAN.md`, `CHANGELOG.md`, `docs/llms-full.txt`, `docs/llms-migration.txt`, `packages/cli/docs/llms-full.txt`, `skills/smithers/llms-full.txt`, and the plugin skills' "if the project still depends on `smthrs` or `smithers-orchestrator`" pointer at `claude-plugin/skills/smithers/SKILL.md` and `codex-plugin/skills/smithers/SKILL.md`).
- Historical render fixture (2): `packages/build-cli/test/fixtures/github-render/originals/coordinate.yaml:59` and `packages/build-cli/test/GithubRender.test.ts:659`, a 0.x-era workflow YAML in a private package's test data.

`node scripts/docs-contract.mjs` exits 0, so the docs pages are clean against the banlist.

## 4. Obsolete-import scan: PASS

### 4.1 Import-position and JSX-runtime sweeps

```
rg -n "(from ['\"]|require\(['\"]|import\(['\"]|import ['\"])(smithers-orchestrator|smthrs['\"/]|@smthrs/(graph|scheduler|driver|react-reconciler|components)|@smithers-orchestrator/)" --glob '!vendor/**' --glob '!packages/migrate/test/fixtures/**' --glob '!flows/migrate-smithers-v1/test/fixtures/**' . < /dev/null
rg -n 'smthrs/jsx(-dev)?-runtime|smithers-orchestrator/jsx(-dev)?-runtime|jsxImportSource["'"'"':= ]*["'"'"']?(smthrs|smithers-orchestrator)' --glob '!vendor/**' . < /dev/null
rg -n "(from ['\"][^'\"]*legacy/|require\(['\"][^'\"]*legacy/|import\(['\"][^'\"]*legacy/)" --glob '!vendor/**' . < /dev/null
```

Import-position sweep (`import-a.txt`): 43 lines, 40 in `docs/`, `PLAN.md`, `CHANGELOG.md`, or `research/` (migration ledger and contract prose, `docs/migration/feature-parity-audit.md` code listings, historical changelogs, `research/xstate-integration.md`). The three outside documentation:

| Hit | Classification |
| --- | --- |
| `packages/migrate/src/flow/Contract.ts:132` `import { closeSingleRunnerRuntime, createSmithers, runWorkflow } from "smthrs"` | inside the `old:` template-string literal of a captured 0.x example |
| `packages/migrate/test/Detect.test.ts:465` | a string literal fed to the detector |
| `apps/ui/src/bun/Repos.test.ts:45` | a string the test writes into a scratch `PACKAGE.ts` to exercise workspace detection |

JSX-runtime sweep (`import-b.txt`): 121 lines; 44 in `docs/migration`, 11 in `docs/pages`, 12 in the `docs/llms-*.txt` renderings, 1 in `docs/releases`, 31 in `packages/migrate` (source, tests, and 0.x fixtures), 6 in `packages/cli/docs/llms-full.txt`, 1 in `packages/smthrs-deprecation/README.md`, 7 in `skills/`, 3 in the `flows/migrate-smithers-v1` fixture, 2 in `scripts/docs-contract.mjs` (the banlist), and the `README.md` and `PLAN.md` sentences stating that the runtime does not exist. After excluding those classes the residue is empty. The only `jsxImportSource` settings in JSON files are `react` in `packages/ui/tsconfig.json:9`, `@opentui/react` in `apps/tui/tsconfig.json:14`, and the 0.x fixture tsconfigs (`flows/migrate-smithers-v1/test/fixtures/smithers-0x-hello`, `packages/migrate/test/fixtures/{jsx-single,persisted-db,plue-pack/.smithers}`). No live module carries a JSX pragma or runtime import.

`legacy/` import sweep (`import-c.txt`): 0 hits. A wider `legacy/` word sweep over non-Markdown files outside `docs/` (`import-d.txt`, 16 lines) finds only the gate itself (`scripts/check-legacy-absent.mjs`), the `exclude` entries in `BUILD.ts` and generated `tsconfig.json` with their pins in `packages/targets/test/GeneratedRootFiles.test.ts` and `packages/flows/test/vitestCoverageIsolation.test.ts`, `scripts/check-local-smithers.test.mjs` (asserts nothing under `legacy/` is scanned), a comment in `apps/ui/src/mainview/chain/deps.test.ts:134`, and the sentence at `smithers-ui.json:158` (formerly `.smithers/UI.json:158`).

`node scripts/check-local-smithers.mjs` exits 0.

### 4.2 Removed-package imports in Plue

Out of scope for this lane; the `plue-cutover` gate owns those scans.

### 4.3 Prior blocker closed: no tracked `.smithers/` at the repository root

`git ls-files .smithers` prints nothing at `41bfdcb06f`. `git check-ignore -v .smithers/UI.json` answers `.gitignore:98:/.smithers/*`, so a stray file at the old location can no longer be committed by accident. The 97 tracked paths that still contain a `.smithers/` segment are all below the root, inside 0.x fixtures (`packages/migrate/test/fixtures/*`, `flows/migrate-smithers-v1/test/fixtures/smithers-0x-hello`), the private build-system fixtures and templates (`packages/build-cli/test/fixtures/force-spec`, `packages/create-app/template/{default,aomi}`), and the UI Playwright fixture (`apps/ui/e2e/fixtures/repo-plugin/{,tools/}.smithers/WORKSPACE.ts`). `legacyState` (`packages/cli/src/Project.ts:200-217`) walks from `cwd` upward only, so none of them is visible from the repository root.

Reproduction, exactly the prior run's shape but at `41bfdcb06f`. Both clones were created with `git clone --shared <checkout> <parent>/scans-fresh-clone-N` (parent `.../migration/`), verified at HEAD `41bfdcb06f0fa3a7d01b0b9e0242c663802d0f78`, installed with `env -u SMITHERS_HOME corepack pnpm install --frozen-lockfile --offline` (exit 0; `git status --porcelain` empty afterwards; `.flows` absent before the first command), and probed with the clone's own `packages/cli/bin/smithers.mjs`. Both clones were removed after the probes.

Clone 1, first command:

```
$ git ls-files .smithers | wc -l
0
$ env -u SMITHERS_HOME node packages/cli/bin/smithers.mjs ls
exit=0
stderr: (0 bytes)
stdout: { "_tag": "flows", "items": [ ...10 create-flow/* and create-skill/* flows... ] }
```

`grep -c 'Smithers 0.x'` over stdout and stderr is 0. `.flows/` exists after the command; a second `ls` is also silent (`fc1-ls2.err`, 0 bytes).

Clone 2, first command:

```
$ env -u SMITHERS_HOME node packages/cli/bin/smithers.mjs doctor
exit=0
stderr: (0 bytes)
stdout:
smithers doctor — <clone-2>
warn registry: <clone-2>/flows holds no flow.ts or flow.mdx; discovery finds nothing
ok   state: <clone-2>/.flows
ok   database <clone-2>/.flows/control.db: 4 migrations applied, latest 1002
ok   database <clone-2>/.flows/engine.db: 8 migrations applied, latest 4001
ok   node: v24.18.0
ok   jj: /opt/homebrew/bin/jj
ok   providers: OPENAI_API_KEY, CEREBRAS_API_KEY
```

No `smithers 0.x` row; `grep -c -i '0\.x'` over stdout and stderr is 0. The `warn registry` row is expected: the repository's `flows/` holds `migrate-smithers-v1`, which is a directory of test fixtures and a `pack.test.mjs`, not a `flow.ts`.

Control comparison (the prior run's minimal-project probe, CLI from the checkout's `packages/cli/bin/smithers.mjs`, each project holding `package.json`, `flows/`, and a `git init` so the walk stops at the project):

| Project shape | stderr | Result |
| --- | --- | --- |
| `.smithers/UI.json` (copy of the committed `smithers-ui.json` at the pre-fix location) | 412 bytes: `Found Smithers 0.x state at .../ui-json-probe/.smithers. ...` | detector still fires on the old layout |
| `smithers-ui.json` at the root (the `41bfdcb06f` layout) | 0 bytes | the fixed layout is silent |
| no manifest | 0 bytes | baseline |

All three exit 0 and print `{"_tag":"flows","items":[]}`. The positive control proves the silence in the clones is the moved manifest and not a disabled detector.

Install warnings in both clones are the ones `00-clean-install.md` already classifies: the `kernel`/`platform-browser` cyclic workspace dependency, `Failed to create bin ... smithers-migrate` (twice; the bin lives under an unbuilt `dist/`), and the soft `apps/ui postinstall: ensure-devkit: electrobun prepare exited by signal (continuing ...)`.

### 4.4 Informational findings, not blockers

1. The private build system keeps `.smithers/WORKSPACE.ts` as a workspace-declaration location. `packages/build-cli/src/PackageDiscovery.ts:42` documents `workspaceFile` as "`.smithers/WORKSPACE.ts`, or the root `WORKSPACE.ts` fallback", line 144 probes both names, `apps/ui/src/bun/Targets.ts:288,312` probe the same path in consumer repositories, and `packages/create-app/template/{default,aomi}/.smithers/{WORKSPACE.ts,agents.ts,sandbox.ts}` scaffold it. A copy of `packages/create-app/template/default` with `git init` prints the section 6 notice on its first `smithers ls` (`template-probe-ls.err`, 413 bytes). This does not fail the gate because nothing on the rc.0 public surface creates that layout: `@smthrs/create-app` and `@smthrs/build-cli` are `private: true` at `0.1.0`, `smithers init` writes `flows/<name>/flow.mdx` and `.flows/` only (`packages/cli/src/Init.ts:137-150`), and this repository's own root declares `BUILD.ts` with no `.smithers/`. It becomes a blocker the day either package is published or `init` adopts the template; the fix is the same choice the prior run named (move the marker, or narrow `legacyMarkers` to the artifacts 0.x actually wrote).
2. `.gitignore:96-98` still carries the comment "The repository's own UI plugin manifest ... is source, not run state" and the `!/.smithers/` plus `/.smithers/*` pair that once framed the deleted `!/.smithers/UI.json` exception. The net effect is a fully ignored directory (`git check-ignore -v .smithers/anything` answers `.gitignore:98:/.smithers/*`); the comment is stale.

## 5. `legacy/` absence: PASS

| Command | Exit | Result |
| --- | --- | --- |
| `node scripts/check-legacy-absent.mjs` | 0 | `check-legacy-absent: legacy/ is empty; every 0.x path has been ported or dropped` |
| `test -e legacy` | 1 | directory absent |
| `git ls-files -- legacy` | 0 paths | nothing tracked |

## Verdict

PASS. At `41bfdcb06f` the secret sweep finds only test placeholders, upstream jj fixtures, and evidence quotations; `known-files.d.ts`, `.github/workflows/ci.yml`, and `tsconfig.json` regenerate byte-identical with `vendor/jj` initialized and `pnpm exec smithers-build lint '//:knownFiles'` and `lint '//:ci'` exit 0; every documentation artifact gate is current; every public manifest is `1.0.0-rc.0` on `effect@4.0.0-rc.108` with no removed package name resolved by either lockfile; no live module imports a removed package, a 0.x JSX runtime, or `legacy/`; and `legacy/` is absent. The one blocker carried from `163fdf4bf5` is closed: the repository tracks nothing under `.smithers/`, and a fresh clone's first `smithers ls` and first `smithers doctor` print no 0.x notice and no `smithers 0.x` row, while the old layout still trips the detector in the control. The checkout is pristine after evidence capture (`git status --porcelain` empty) and both scratch clones are removed.
