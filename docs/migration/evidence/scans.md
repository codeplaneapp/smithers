# Phase 7 gate: scans

Verdict: PASS

This run supersedes the run at `cd14388ed7` (preserved as `scans-prev-cd14388ed7.md`, logs in `scans-logs-prev-cd14388ed7/`) and re-proves the gate at `341c8fa87e`, the tip after the wave-7 (docs-served-llms, cli-refuse-before-boot), wave-8 (polish-2, init-scaffold-launch), and release-artifact commits landed (`git log cd14388ed7..341c8fa87e`: 15 commits, 75 files, +6924 -2807). The secret scan, the generated-file scan, the stale-version scan, the obsolete-import scan, and the `legacy/` check pass with every hit classified. A fresh shared clone's first `smithers ls` and `smithers doctor` print nothing on stderr and no `0.x` or legacy-marker row, and a removed verb refuses before the control plane boots without creating any file, which covers the wave-7 CLI surface from this gate's vantage. Every classification from the `cd14388ed7` run that this run re-verified is carried forward below, updated to the new commit.

## Environment

| Item                    | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Checkout                | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-4`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| HEAD                    | `341c8fa87e2dadbe80d0f0d3258dae112a7d03d3` (2026-08-31 09:12:47 -0700, `docs(release): consumer overrides note and the browser-contract list's new home`), detached at the `v1/rc0-migration` tip                                                                                                                                                                                                                                                                                                                                                                                                    |
| Submodule               | `vendor/jj` at `47589ada70c12b3e829b5c98ab32503abad49eac` (`v0.25.0-3759-g47589ada7`), initialized                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Node                    | v24.18.0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Bun                     | 1.4.0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| pnpm                    | 11.21.0 (`corepack pnpm` for the clone install)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| git                     | 2.50.1 (Apple Git-155)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ripgrep                 | 14.1.1; `gitleaks` and `trufflehog` are not installed, so the secret scan is a pattern sweep                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Tracked files           | 4783 (`git ls-files \| wc -l`; the prior run's 4773 plus the wave-7 and wave-8 files)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Install                 | the frozen install already present in the checkout (`node_modules` from the `00-clean-install` gate); no install step ran in the checkout. The scratch clone received `corepack pnpm install --frozen-lockfile --offline`                                                                                                                                                                                                                                                                                                                                                                            |
| `apps/ui/.hutch/devkit` | present in the checkout (electrobun 2.0.1, gitignored, copied in from `/Users/williamcory/smithers/apps/ui/.hutch/devkit` because `electrobun prepare` blocks on a hutch lock another session holds; the documented setup state for this validation series). Absent in the clone, where the postinstall printed the soft `ensure-devkit: electrobun prepare exited by signal (continuing ...)` warning and exited 0                                                                                                                                                                                  |
| Date                    | 2026-08-31, 09:16:00 to 09:28:31 -0700                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Load                    | 3.37 at the start, 6.71 before the drift targets, 33.75 during the clone step, 9.61 at the end; every command ran under load 40                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Concurrency             | one other Phase 7 gate ran in this checkout during the run (`ps` at 09:18 showed `tsc -p tsconfig.test.json` under `packages/targets` and a `smithers skills --help` probe). Every scan below is read-only except `check-llms.mjs`, which regenerates, compares, and restores in one second; the in-place regeneration of `known-files.d.ts`, `.github/workflows/ci.yml`, and `tsconfig.json` was again not performed because a concurrent gate could read a half-written root file. The `smithers-build lint` drift targets, which are the CI gates for those three files, ran instead and exited 0 |

`SMITHERS_HOME` was unset for every `smithers`, `smithers-build`, and `pnpm` invocation (`env -u SMITHERS_HOME`).

`git status --porcelain` was empty at the start, after the drift targets, before and after `check-llms`, after the documentation gates, and at the end (`porcelain-start.txt`, `porcelain-after-lint.txt`, `porcelain-before-llms.txt`, `porcelain-after-llms.txt`, `porcelain-after-docs.txt`, `porcelain-end.txt` are all zero bytes). HEAD was `341c8fa87e` at the start and at the end.

Tooling note: under this harness `rg` with no positional path blocks reading its stdin pipe; every `rg` below passes `.` and `< /dev/null`.

Raw logs: `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/phase7/scans-logs/` (50 files, copied from the session scratchpad `scans-6/`).

## Summary of commands

All commands ran from the checkout root unless a directory is named.

| Command                                                                                                                                                                 | Exit      | Final line                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------- |
| `env -u SMITHERS_HOME corepack pnpm exec smithers-build lint '//:knownFiles'`                                                                                           | 0         | `"//:knownFiles",Generate,ran,1186.31...,453ab08d3d...` (`ok: true`, `failed: 0`)         |
| `env -u SMITHERS_HOME corepack pnpm exec smithers-build lint '//:ci'`                                                                                                   | 0         | `"//:ci",GithubCiGen,ran,23.56...,4a520a7aa0...` (`ok: true`)                             |
| `env -u SMITHERS_HOME corepack pnpm exec smithers-build lint '//:tsconfig'`                                                                                             | 0         | `"//:tsconfig",Tsconfig,ran,24.01...,2e1f2f9242...` (`ok: true`)                          |
| `node scripts/check-llms.mjs`                                                                                                                                           | 0         | `✓ 12 documentation artifact(s) are current`                                              |
| `node scripts/generate-docs-pages.mjs --check`                                                                                                                          | 0         | `✓ 43 generated docs pages are current`                                                   |
| `node scripts/docs-contract.mjs`                                                                                                                                        | 0         | (silent)                                                                                  |
| `node --experimental-strip-types scripts/generate-theme-registry.ts --check`                                                                                            | 0         | (silent)                                                                                  |
| `node scripts/check-docs.mjs`                                                                                                                                           | 0         | `✓ the browser tables and counts match the 28 entry points the gate bundles`              |
| `node scans-logs/manifest-audit.mjs`                                                                                                                                    | 0         | `manifests=84 public=42 private=42`, `findings=6` (all 0.x fixtures, section 3.1)         |
| `node scripts/check-single-effect-version.mjs`                                                                                                                          | 0         | `check-single-effect-version: effect@4.0.0-rc.108 everywhere (63 sources)`                |
| `node scripts/check-local-smithers.mjs`                                                                                                                                 | 0         | `check-local-smithers: internal scripts run the Smithers working tree`                    |
| `node scripts/check-legacy-absent.mjs`                                                                                                                                  | 0         | `check-legacy-absent: legacy/ is empty; every 0.x path has been ported or dropped`        |
| `test -e legacy`                                                                                                                                                        | 1         | directory absent; `git ls-files -- legacy` lists 0 paths                                  |
| `git ls-files .smithers`                                                                                                                                                | 0         | 0 paths                                                                                   |
| `git clone --shared <checkout> <parent>/scans-fresh-clone-6` + `git submodule update --init` + `env -u SMITHERS_HOME corepack pnpm install --frozen-lockfile --offline` | 0 / 0 / 0 | `Done in 3m 0.8s using pnpm v11.21.0`                                                     |
| `env -u SMITHERS_HOME node packages/cli/bin/smithers.mjs ls` in the clone (first command)                                                                               | 0         | stderr 0 bytes; stdout the 10-flow `{"_tag":"flows",...}` listing                         |
| `env -u SMITHERS_HOME node packages/cli/bin/smithers.mjs doctor` in the clone (second command)                                                                          | 0         | stderr 0 bytes; 7 report rows, none mentioning `0.x` or a legacy marker                   |
| `env -u SMITHERS_HOME node <clone>/packages/cli/bin/smithers.mjs graph` in an empty scratch directory                                                                   | 1         | `smithers graph was removed in 1.0.0-rc.0: ...`; the directory holds 0 entries afterwards |

## 1. Secret scan: PASS

Pattern sweep from the checkout root. `rg` honors `.gitignore`, so `node_modules/`, `dist/`, `.flows/`, and `apps/ui/.hutch/` are excluded; `vendor/jj` is included.

Token patterns (Anthropic `sk-ant-`, OpenAI `sk-`/`sk-proj-`, GitHub `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`/`github_pat_`, AWS `AKIA`/`ASIA`, Slack `xox[baprs]-`, Google `AIza`, npm `npm_`, GitLab `glpat-`, Stripe `sk_live_`/`rk_live_`, SendGrid `SG.`, Hugging Face `hf_`, xAI `xai-`, Groq `gsk_`, Perplexity `pplx-`, PEM private-key headers, three-segment JWTs; the pattern file is `scans-logs/token-patterns.txt`). One `rg` invocation, exit 0, 13 hits in 6 files (`secret-tokens.txt`), the identical set the `cd14388ed7` run classified:

| Hit                                                                                                                                                      | Classification                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `apps/ui/src/mainview/state/seams/KeysSeam.test.ts:60` (`sk-ant-api03-THE-WHOLE-UNMASKED-SECRET-VALUE`)                                                  | masking test placeholder; the test asserts it never reaches the client                                               |
| `packages/journal/test/Redaction.test.ts:36,93` (`sk-ant-api03-abcdefgh`)                                                                                | redaction test input                                                                                                 |
| `packages/cli/test/Bug.test.ts:13,20-23` (`ghp_abcdefghijklmnopqrstuvwxyz...`, `github_pat_abcdef...`, `AKIAIOSFODNN7EXAMPLE`, `xoxb-1234567890-abcdef`) | `Bug.scrubText` inputs, each asserted to become `[REDACTED]`; `AKIAIOSFODNN7EXAMPLE` is AWS's documented example key |
| `vendor/jj/lib/tests/test_gpg.rs:19`, `vendor/jj/lib/tests/test_ssh_signing.rs:29` (PGP and OpenSSH private key blocks)                                  | upstream jj signing test fixtures in the pinned submodule                                                            |
| `docs/migration/evidence/scans.md:66-68`                                                                                                                 | the in-tree copy of the prior run of this gate quoting the rows above                                                |

Generic patterns (`(api|auth|access|secret|client|private)[_-]?(key|token|secret)` assigned a quoted value of 24 or more `[A-Za-z0-9_\-/+=.]` characters, `scheme://user:password@host` with an alphanumeric character after the `@`, `password` assigned a quoted value of 8 or more characters), case-insensitive, excluding `vendor/` and the lockfiles: 25 hits in 14 files (`secret-generic.txt`). All are test or documentation literals whose credential is `password`, `secret`, `pass`, `hunter2`, `test`, `header-password`, `query-password`, `body-password`, `response-password`, or `step-key-password`: `packages/build/terraform/modules/cache/service/test/{config,server,protocol,postgres}_test.js`, `packages/build/infra/worker/test/protocol-hardening.test.ts:728`, `packages/build/docs/workspace/remote-caching.md:222`, `packages/build-cli/test/Cache.test.ts:153`, `packages/artifacts/test/RemoteArtifacts.test.ts:99`, `packages/integrations/test/ListenerRegistry.test.ts:146`, `packages/model/test/{RequestExecutor,Endpoint,Route}.test.ts`, `packages/cli/test/Bug.test.ts:11-13`, and the in-tree evidence file. The prior run counted 27 hits in 15 files with a looser URL pattern; the two lines this run's pattern does not match were re-checked by hand and stay clean: `packages/build/terraform/modules/cache/main.tf:23-26` is a `format("postgres://%s:%s@%s...")` template whose password comes from `var.postgres_password`, and `packages/build/terraform/modules/cache/service/test/config_test.js:85` is the placeholder `postgres://user:secret@/database` with no host after the `@`.

Credential files: `git ls-files` matches no `.env*`, `.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `.keystore`, `.asc`, `.gpg`, `.netrc`, `.pypirc`, `id_rsa*`, `id_ed25519*`, or `service-account*.json`. The 16 name matches (`secret-files.txt`; this run's name pattern also includes the words `credential` and `secret`) are TypeScript source and test files: `apps/review/{action/src,tests/action}/materializeInferenceCredentials*.ts`, `e2e/faults/case22-secret-never-in-journal.test.ts`, `e2e/fixtures/secretChild.ts`, `packages/build-cli/test/Credentials.test.ts`, `packages/control/src/{Credential,CredentialCipher,CredentialStore,SqlCredentialStore}.ts` and their two tests, `packages/targets/src/{Secret,SecretProxy}.ts` and `test/Secret.test.ts`, and `packages/ui/{src/artifacts/SecretField.tsx,tests/coding-artifacts-secrets.test.tsx}`. `.npmrc` holds comments only (printed in `npmrc.txt`).

No real secret in the tree.

## 2. Generated-file scan: PASS

### 2.1 Root files generated from `PACKAGE.ts`

All three drift targets exit 0 with status `ran` (not a cache hit) and `ok: true`, with `vendor/jj` initialized:

```
$ env -u SMITHERS_HOME corepack pnpm exec smithers-build lint '//:knownFiles'
  "//:knownFiles",Generate,ran,1186.3088750000002,453ab08d3d56e417...   ok: true
$ env -u SMITHERS_HOME corepack pnpm exec smithers-build lint '//:ci'
  "//:ci",GithubCiGen,ran,23.557375000000093,4a520a7aa07528c2...        ok: true
$ env -u SMITHERS_HOME corepack pnpm exec smithers-build lint '//:tsconfig'
  "//:tsconfig",Tsconfig,ran,24.007000000000062,2e1f2f9242299f19...     ok: true
```

`git status --porcelain` is empty after the three targets. `known-files.d.ts` declares 4677 workspace files (header line 2; the prior run's 4667 plus the wave-7 and wave-8 files, regenerated in `5cc98912d0`), contains zero `vendor/jj` entries, carries the paths `//smithers-ui.json` (line 4703) and `//apps/ui/e2e/fixtures/repo-plugin/smithers-ui.json` (line 413), and has no `.smithers/UI.json` entry.

The manual in-place regeneration (`node scripts/generate-known-files.mjs`, `smithers-build build '//:ci'`, `smithers-build build '//:tsconfig'` followed by `git diff --exit-code`) was skipped for the concurrency reason in the Environment table, the same ruling as the prior run. The lint verb renders the same output and compares it to the tracked file, so the drift proof is the same.

### 2.2 Documentation artifacts

| Generated artifact                                                                                                                                                                                                           | Gate                                                                          | Result                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 12 llms bundles and `packages/cli/docs/SKILL.md`                                                                                                                                                                             | `node scripts/check-llms.mjs` (regenerates, compares bytes, restores)         | current; `git status --porcelain` empty before and after                                                                                                                                                                                                                                 |
| Served bundles under `docs/dist/public`                                                                                                                                                                                      | the same script's served-site half, new in wave 7 (`510621c763`)              | no-op here: `docs/dist` does not exist in the checkout, the state the script documents for CI, where the gate runs before `vocs build`. The served-drift logic is unit-tested by the new `scripts/check-llms.test.mjs`, and the built-site path is exercised by the docs-generation gate |
| 43 pages under `docs/pages/{cli,control,release,routes}`                                                                                                                                                                     | `node scripts/generate-docs-pages.mjs --check` (also run by `check-docs.mjs`) | current                                                                                                                                                                                                                                                                                  |
| `docs/pages/**` against the removed-surface banlist                                                                                                                                                                          | `node scripts/docs-contract.mjs`                                              | clean                                                                                                                                                                                                                                                                                    |
| `packages/ui-styleguide/src/themes/*.ts` (7 files)                                                                                                                                                                           | `node --experimental-strip-types scripts/generate-theme-registry.ts --check`  | current                                                                                                                                                                                                                                                                                  |
| Placeholders, route plan, sidebar reach, compatibility promise (3 places), package counts (40 names), moved trees, 74 migration-guide anchors, and the new browser table check (28 entry points, from polish-2 `6f4f2bacf9`) | `node scripts/check-docs.mjs`                                                 | all checks pass; the final line is the new `✓ the browser tables and counts match the 28 entry points the gate bundles`                                                                                                                                                                  |

### 2.3 Other files that declare themselves generated

The marker sweep (`Generated by`, `@generated`, `Do not edit`, `DO NOT EDIT`, `AUTO-GENERATED`, `auto-generated`) over tracked non-Markdown files outside `vendor/` finds the same 38 files as the prior run (`generated-markers.txt`; `diff` against the prior list shows only a path-prefix difference). The classification from `scans-prev-cd14388ed7.md` section 2.3 stands unchanged: the emitters and their tests, the gated files from sections 2.1 and 2.2, `Cargo.lock` (consumed by the required `rust` and `wasm-repro` CI jobs), `packages/migrate/src/internal/FacadeExports.ts` (a fixed catalog of the 0.x export graph by design), the create-app templates whose scaffolded `//:routes` target checks drift, the build-cli render fixtures, and one comment each in `apps/review/src/walkthrough/renderWalkthroughHtml.ts` and `factory/flows/review-docs.ts` that describe generated output rather than marking the file. `packages/ui/src/adapters/markdown-editor/crepeTheme.generated.ts` still names the untracked generator `scripts/generate-ui-themes.ts` (informational finding 3). `packages/jj/wasm/flows_jj.wasm` is a binary artifact with its own reproducibility gate (`wasm-repro`) and is outside a text scan.

## 3. Stale-version scan: PASS

### 3.1 Manifests

`manifest-audit.mjs` (the prior run's script, re-run unchanged) parsed all 84 tracked `package.json` files: 42 public (no `"private": true`), 42 private. Every public workspace manifest is versioned `1.0.0-rc.0` with `effect` pinned at exactly `4.0.0-rc.108` (the `smthrs@1.0.0-rc.0` deprecation stub has no `effect` dependency). No public manifest carries `0.35.0` or `0.1.0`. The two remaining "public" manifests are `packages/build-cli/test/fixtures/viem-node-spec/{,src/}package.json` (`viem-fixture@1.0.0`, `viem@1.0.0`), test fixtures inside a private package and outside the workspace globs. The two manifests this commit range touched audit clean: `packages/memory/package.json` (now packs `src/**/*.sql`, a polish-2 files-array fix) and `packages/smthrs-deprecation/package.json`.

The eight manifests at `0.1.0` (`@smthrs/{build,build-cli,chain,create-app,fs,scorers,targets,triggers}`) are all `private: true` per rc-contract section 3.2 and never pack (`manifests-0.1.0-0.35.0.txt`). No manifest is at `0.35.0`.

The six findings are the same 0.x fixtures the migration tool transforms, which is their function: `packages/migrate/test/fixtures/batch-issues/package.json` (`smithers-orchestrator ^0.32.0`), `packages/migrate/test/fixtures/{mixed-api,plue-pack}/.smithers/package.json` (`smithers-orchestrator 0.32.0`), and `packages/migrate/test/fixtures/{jsx-single,persisted-db}/package.json` plus `flows/migrate-smithers-v1/test/fixtures/smithers-0x-hello/package.json` (`smthrs 0.35.0`, `effect 4.0.0-beta.105`). Fixtures do not ship: `@smthrs/migrate` `files` is `["src/**", "dist/**", LICENSE, README, CHANGELOG]`, and fixture directories are outside the pnpm workspace globs.

### 3.2 Effect

`check-single-effect-version` exits 0 (`effect@4.0.0-rc.108 everywhere (63 sources)`). `pnpm-lock.yaml` has no `effect@4.*` line other than `rc.108`, and `bun.lock` has one `effect` resolution, `effect@4.0.0-rc.108` (line 4041). The 36 `4.0.0-beta` lines in 26 files outside the lockfiles (`effect-beta-files.txt`) are the identical file list as the prior run (`diff` of the file lists is empty): the fixtures above and the migrate tests that assert the detector reports them, the vendor-fork attribution `effect@4.0.0-beta.102` in the `THIRD_PARTY_NOTICES.md` files, `packages/engine/VENDOR.md`, `docs/pages/comparisons.md` and its llms renderings, the migration record, and historical changelog entries. The 22 lockfile lines (`effect-beta-lock.txt`, 14 in `pnpm-lock.yaml`, 8 in `bun.lock`) are third-party peer ranges (`>=4.0.0-beta.104 || >=4.0.0` and `>=4.0.0-beta.105 || >=4.0.0` from `@distilled.cloud/*`, `@alchemy.run/*`, `alchemy`), not resolutions.

### 3.3 `0.35.0`

173 lines in 61 files outside `vendor/` and the lockfiles (`v0350-files.txt`); neither lockfile mentions `0.35.0` (`rg -c` exits 1 on both). The file-list delta against the prior run is entirely inside `docs/migration/evidence/`: `dependency-cycles-names.md` and `docs-generation-links.md` no longer mention `0.35.0` after their `0156f2458e` refresh, and the preserved `plue-cutover-prev-20b32c6316.md` now does. Every hit is intentional product or record content, the classes `scans-prev-cd14388ed7.md` section 3.3 lists: the operator message `bunx smthrs@0.35.0 ps` in `packages/cli/src/{Legacy,Project}.ts` and its pinning tests, `packages/cli/test/Update.test.ts`, the `0.35.0` changelog page and its route registrations, the deprecation stub README, the release and publish runbooks naming the `latest` tag, the migration guides, the migrate tool's version tables, `apps/bug-worker` sample payloads, the fixtures, and the migration ledger, plan, contract, and evidence files.

### 3.4 Removed package names

`smithers-orchestrator`, `@smithers-orchestrator/*`, `@smthrs/graph`, `@smthrs/scheduler`, `@smthrs/driver`, `@smthrs/react-reconciler`, `@smthrs/components`: both lockfiles resolve none of them (`rg` over `pnpm-lock.yaml` and `bun.lock` exits 1, `old-names-lock.txt` is zero bytes).

411 textual lines in 66 files outside `vendor/` and the lockfiles (`old-names.txt`; the file-list delta against the prior run is again only evidence transcripts: `npm-pack.md` dropped its mention, `plue-cutover-prev-20b32c6316.md` added one). The residue after excluding `docs/`, `PLAN.md`, `CHANGELOG.md`, `README.md`, `research/`, `packages/migrate`, `flows/migrate-smithers-v1`, and `skills/` is 21 lines (`old-names-residue.txt`), all in known classes: the enforcement literals (`scripts/docs-contract.mjs:265-270` banlist, `scripts/docs-contract.test.mjs:270-271`, `scripts/normalize-bunx.ts:39` `stalePackages`, `scripts/normalize-bunx.test.ts:9`), the guard test asserting absence (`apps/status-site/tests/rcSurfaces.test.ts:10,45`), the plugin-skill migration pointers (`claude-plugin/skills/smithers/SKILL.md:167`, `codex-plugin/skills/smithers/SKILL.md:131`), the migration-guide text rendered into `packages/cli/docs/llms-full.txt` (5 lines, kept current by `check-llms`), and the historical render fixture (`packages/build-cli/test/fixtures/github-render/originals/coordinate.yaml:59` with `packages/build-cli/test/GithubRender.test.ts:659`). `node scripts/docs-contract.mjs` exits 0, so the docs pages are clean against the banlist.

## 4. Obsolete-import scan: PASS

### 4.1 Import-position and JSX-runtime sweeps

The three sweeps from the prior run, re-run verbatim (`import-a.txt`, `import-b.txt`, `import-c.txt`).

Import-position sweep: 46 lines (the prior run's 44 plus evidence-transcript churn; the per-file diff shows only `docs/migration/evidence/` lines moving). The three hits outside `docs/`, `PLAN.md`, `CHANGELOG.md`, and `research/` are unchanged:

| Hit                                                                                                                          | Classification                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `packages/migrate/src/flow/Contract.ts:132` `import { closeSingleRunnerRuntime, createSmithers, runWorkflow } from "smthrs"` | inside the `old:` template-string literal of a captured 0.x example                  |
| `packages/migrate/test/Detect.test.ts:465`                                                                                   | a string literal fed to the detector                                                 |
| `apps/ui/src/bun/Repos.test.ts:45`                                                                                           | a string the test writes into a scratch `PACKAGE.ts` to exercise workspace detection |

JSX-runtime sweep: 122 lines. After excluding `docs/`, `PLAN.md`, `CHANGELOG.md`, `README.md`, `research/`, `packages/migrate`, `flows/migrate-smithers-v1`, `skills/`, `packages/cli/docs/`, `packages/smthrs-deprecation/`, and the `scripts/docs-contract` banlist pair, the residue is empty. No live module carries a JSX pragma or a 0.x JSX-runtime import.

`legacy/` import sweep: 0 hits, `rg` exits 1. The wider `legacy/` word sweep over non-Markdown files outside `docs/` (`import-d.txt`) finds the prior run's 16-line set exactly: the gate itself (`scripts/check-legacy-absent.mjs`), the `exclude` entries in `PACKAGE.ts` and the generated `tsconfig.json` with their pins in `packages/targets/test/GeneratedRootFiles.test.ts` and `packages/flows/test/vitestCoverageIsolation.test.ts`, `scripts/check-local-smithers.test.mjs`, a comment in `apps/ui/src/mainview/chain/deps.test.ts`, and the sentence in `smithers-ui.json`.

`node scripts/check-local-smithers.mjs` exits 0.

### 4.2 Removed-package imports in Plue

Out of scope for this lane; the `plue-cutover` gate owns those scans.

### 4.3 Fresh-clone probes: no 0.x notice, no legacy warning, refusal before boot

`git ls-files .smithers` prints nothing at `341c8fa87e`. `git check-ignore -v .smithers/UI.json` answers `.gitignore:98:/.smithers/*`. The tracked paths containing a `.smithers/` segment remain below the root inside the 0.x fixtures, the private build-system fixtures and templates, and the UI Playwright fixture; `legacyState` (`packages/cli/src/Project.ts`) walks from `cwd` upward only, so none is visible from the repository root.

Reproduction in one fresh clone. `git clone --shared <checkout> <parent>/scans-fresh-clone-6`, verified at HEAD `341c8fa87e2dadbe80d0f0d3258dae112a7d03d3`, `git submodule update --init` (checked out `47589ada70`), installed with `env -u SMITHERS_HOME corepack pnpm install --frozen-lockfile --offline` (exit 0, `Done in 3m 0.8s`; `git status --porcelain` empty afterwards; `.flows` absent before the first command). The clone was removed after the probes (09:28).

First command:

```
$ env -u SMITHERS_HOME node packages/cli/bin/smithers.mjs ls
exit=0
stderr: (0 bytes)
stdout: { "_tag": "flows", "items": [ ...10 create-flow/* and create-skill/* flows... ] }
```

`grep -c -i '0\.x'` over stdout and stderr is 0.

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

No `smithers 0.x` row and no legacy-marker warning; `grep -c -i '0\.x\|legacy'` over stdout and stderr is 0. The `warn registry` row is expected: the repository's `flows/` holds `migrate-smithers-v1`, a directory of test fixtures and a `pack.test.mjs`, not a `flow.ts`.

Third probe, new this run for the wave-7 `cli-refuse-before-boot` surface (`a506d60231`): in an empty scratch directory, the clone CLI's removed verb `smithers graph` exits 1 with `smithers graph was removed in 1.0.0-rc.0: time travel is a library API (@smthrs/time-travel) and worktree lanes are deferred. See https://smithers.sh/migration/1.0#graph`, and the directory holds 0 entries afterwards: the refusal created no `.flows` state. As a control, the live verb `smithers ps` in the same kind of scratch directory exits 0 and does create `.flows`, which is the boot behavior shipped verbs keep.

Install warnings in the clone are the ones `00-clean-install.md` already classifies: the `kernel`/`platform-browser` cyclic workspace dependency, `Failed to create bin ... smithers-migrate` (twice; the bin lives under an unbuilt `dist/`), and the soft `apps/ui postinstall: ensure-devkit: electrobun prepare exited by signal (continuing ...)`.

### 4.4 Informational findings, not blockers

Carried from the `cd14388ed7` run, re-checked and unchanged:

1. The private build system keeps `.smithers/WORKSPACE.ts` as a workspace-declaration location (`packages/build-cli/src/PackageDiscovery.ts`, `apps/ui/src/bun/Targets.ts`, and the `packages/create-app/template/{default,aomi}/.smithers/` scaffold). Nothing on the rc.0 public surface creates that layout: `@smthrs/create-app` and `@smthrs/build-cli` are `private: true` at `0.1.0`, `smithers init` writes `flows/<name>/flow.mdx` and `.flows/` only, and this repository's own root declares `PACKAGE.ts` with no `.smithers/`. It becomes a blocker the day either package is published or `init` adopts the template.
2. `.gitignore:96-98` still carries the comment "The repository's own UI plugin manifest ... is source, not run state" and the `!/.smithers/` plus `/.smithers/*` pair that once framed the deleted `!/.smithers/UI.json` exception. The net effect is a fully ignored directory; the comment is stale.
3. `packages/ui/src/adapters/markdown-editor/crepeTheme.generated.ts` names an untracked generator (section 2.3).
4. `gitleaks` and `trufflehog` are not installed on this host, so the secret scan is the pattern sweep in section 1 rather than an entropy scan.

## 5. `legacy/` absence: PASS

| Command                                | Exit    | Result                                                                             |
| -------------------------------------- | ------- | ---------------------------------------------------------------------------------- |
| `node scripts/check-legacy-absent.mjs` | 0       | `check-legacy-absent: legacy/ is empty; every 0.x path has been ported or dropped` |
| `test -e legacy`                       | 1       | directory absent                                                                   |
| `git ls-files -- legacy`               | 0 paths | nothing tracked                                                                    |

## Verdict

PASS. At `341c8fa87e` the secret sweep finds only test placeholders, upstream jj fixtures, and evidence quotations; `known-files.d.ts` (4677 files), `.github/workflows/ci.yml`, and `tsconfig.json` pass their `smithers-build lint` drift targets with `vendor/jj` initialized; every documentation artifact gate is current, including the wave-8 browser-contract check in `check-docs` and the wave-7 served-bundle half of `check-llms`; every public manifest is `1.0.0-rc.0` on `effect@4.0.0-rc.108`, no public manifest is at `0.35.0` or `0.1.0`, and neither lockfile resolves a removed package name or a beta Effect; no live module imports a removed package, a 0.x JSX runtime, or `legacy/`; and `legacy/` is absent. A fresh clone's first `smithers ls` and `smithers doctor` print no 0.x notice and no legacy-marker row, and a removed verb refuses before the control plane boots without creating any file. The checkout is pristine after evidence capture (`git status --porcelain` empty, HEAD unchanged) and the scratch clone and probe directories are removed.
