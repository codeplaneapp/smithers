# Phase 7 verdict at 341c8fa87e (final audit pass, 2026-08-31)

ready=true

This verdict supersedes `verdict-cd14388ed7.md`. It audits the full gate set at
`341c8fa87e2dadbe80d0f0d3258dae112a7d03d3` (`v1/rc0-migration`, `docs(release):
consumer overrides note and the browser-contract list's new home`) from the
clean checkout `migration/clean-checkout-4`, which sits at that commit with
`vendor/jj` at `47589ada70` and a frozen offline install. Every audit command
below ran on 2026-08-31 16:48 to 17:00 UTC at 1-minute load 2.2 to 6.6 (under
the 40 bound), Node v24.18.0, pnpm 11.21.0 via corepack 0.35.0, Bun 1.4.0.
The maintainer tree `/Users/williamcory/smithers` is at the same commit with
`git status --porcelain` empty and `jj st` reporting no working-copy changes;
no `apps/ui/**` files from another session are present.

## Gate roll-up: 17 of 17 PASS

Eleven gates were re-run at `341c8fa87e` and their evidence files supersede the
cd14388ed7 run: 00-clean-install, browser-bundling, cli-e2e, consumer-fixtures,
docs-generation-links, exports-types-sync, format-lint-typecheck, npm-pack,
scans, smoke, unit-tests. Six gates stand on their cd14388ed7 evidence:
dependency-cycles-names, examples, integrations-real-backend, migration-tool,
plue-cutover, sqlite-persistence-crash. The diff `cd14388ed7..341c8fa87e`
(15 commits, 75 files, +6924/-2807) touches only surfaces a re-run gate covers
or release artifacts and evidence copies; the two paths that graze a standing
gate (`examples/src/09-browser-use.ts` and the dependency graph of the changed
`packages/{cli,agent,control}` sources) were re-verified directly by this audit
(section "Standing gates" below), so no gate's surface changed without
re-validation.

## Audit re-runs, one or more commands per PASS gate

All from `clean-checkout-4` at `341c8fa87e` unless a path says otherwise.

| Gate | Command re-run by this audit | Result |
| --- | --- | --- |
| 00-clean-install | `env -u SMITHERS_HOME corepack pnpm install --frozen-lockfile --offline` | exit 0, `Already up to date`, `Done in 273ms`; `git status --porcelain` 0 lines after |
| browser-bundling | `corepack pnpm run browser` | exit 0, `browser contract holds: 28 browser entry points, 7 Node-only.` |
| cli-e2e | `SMITHERS_HOME=<scratch> node packages/cli/src/bin.ts ui` from an empty directory; `corepack pnpm exec smithers --version` | refusal sentence with `#ui` anchor, exit 1, `find` counts 0 files created in cwd and SMITHERS_HOME; `smithers v1.0.0-rc.0` exit 0 |
| consumer-fixtures | fixture logs re-read (`node-quickstart-2.log`, `node22-quickstart-2.log`, `bun-quickstart.log` all end `Hello, Ada.`); the install path independently re-proven by `smithers-build test '//scripts:releaseSmoke' --no-cache` | exit 0 (releasePack 16.8 s, releaseSmoke 23.7 s): every tarball packs, installs into a scratch project outside the repository, and imports ESM and CJS. The fixtures' `node_modules` and tarball copies were removed by the gate per the documented disk constraint, so the recorded logs plus this target are the confirmation |
| docs-generation-links | `node scripts/check-docs.mjs`; `node scripts/check-llms.mjs`; `node scripts/docs-contract.mjs`; `smithers-build test '//scripts:docsUnit' --no-cache` | all exit 0: 17/17 checks, `✓ 12 documentation artifact(s) are current`, docsUnit `0 failed` in 27.4 s fresh at load 2.7; committed `docs/llms-full.txt` carries 7 `<Task` (all migration-guide quotations) and 0 `smithers oneshot` |
| exports-types-sync | `smithers-build lint '//:knownFiles'`; `//scripts:releaseSmoke` (imports all public entry points) | both exit 0, `ok: true` |
| format-lint-typecheck | `smithers-build lint '//packages/cli/...'`; `packages/agent` `pnpm run check` (tsc -b + test tsconfig) | exit 0 (fmt Dprint + lint EsLint ran), exit 0 |
| npm-pack | `node --test scripts/pack-release.test.mjs` | 16 pass, 0 fail (grew from 12 with the wave-8 packing cases) |
| scans | `node scripts/check-legacy-absent.mjs`; `node scripts/check-single-effect-version.mjs`; ripgrep for `react-reconciler`, `smthrs/jsx-runtime`, `"jsx"` manifest keys, `<Task` in `packages/*/src`, `apps/*/src`, `examples/src`, `flows` | all clean: `legacy/ is empty`, `effect@4.0.0-rc.108 everywhere (63 sources)`, the only reconciler and jsx-runtime mentions are `packages/migrate`'s detection tables, `apps/tui`'s React-for-TUI imports, and a `ReactNode` type in `packages/create-app`, each classified by the scans gate |
| smoke | direct sqlite3 read of `phase7/smoke-db/.flows/engine.db` | all 10 recorded runs terminal (`run-1` failed, `run-6`/`run-8` cancelled, the rest completed), every row `finished_at_ms` set and `owner_pid` NULL, `count(*) where status='accepted' or owner_pid=0` = 0. Real persisted data matches the evidence's final-state table |
| unit-tests | `packages/agent` `vitest run test/AgentSessionFailures.test.ts` (the wave-8 settle-failed surface); `packages/control` covered by the same fan-out | 34/34 pass |

## Standing gates re-verified at 341c8fa87e

| Gate (evidence at cd14388ed7) | Surface delta since cd14388ed7 | Audit action | Result |
| --- | --- | --- | --- |
| dependency-cycles-names | new `packages/cli/src/Unsupported.ts`, edits in `packages/{cli,agent,control}/src` | full `corepack pnpm run circular` at `341c8fa87e` | exit 0, 51 packages `circular: Done`, 0 failed; no package was added or renamed, so the duplicate-name half needs no re-count |
| examples | `examples/src/09-browser-use.ts` (+6/-4, browser-contract comments) | `node src/09-browser-use.ts` direct execution; the unit-tests fan-out at `341c8fa87e` re-ran the examples vitest suite (58 passed, 1 environmental) | exit 0 |
| integrations-real-backend | `README.md` and `test/ReadmeCommands.test.ts` only; `git diff cd14388ed7..341c8fa87e -- packages/integrations/src` empty | `GITHUB_TOKEN="$(gh auth token)" vitest run test/GitHubLive.test.ts --coverage.enabled=false` against api.github.com | 4/4 pass; the new ReadmeCommands test ran green in the 341c8fa87e fan-out (309 passed) |
| migration-tool | `git diff cd14388ed7..341c8fa87e -- packages/migrate flows` empty | `vitest run test/Detect.test.ts test/Mapping.test.ts` | 78/78 pass; the `smithers migrate` verb path re-ran in cli-e2e and the fan-out |
| sqlite-persistence-crash | `git diff` empty for `packages/{journal,run-store,engine-store,time-travel,testing}` and `e2e` | `vitest run test/FaultMatrix.test.ts test/HardKillReclaim.test.ts test/UnencodableSettlement.test.ts` in `packages/engine-store` | 16/16 pass |
| plue-cutover | Smithers-side deltas (AgentSession settle-failed, ControlLive, CLI) are re-proven at `341c8fa87e` by the smoke item 1a, the cli-e2e lifecycle, and the fan-out; Plue itself unchanged | `migration/plue-clean-cutover` confirmed at `976a170a6`; ripgrep for `smithers-orchestrator` over go/ts/tsx/js/zig | 0 hits; ENV-SKIP preconditions re-confirmed below |

## ENV-SKIP and environmental-failure confirmations

- Telegram: `TELEGRAM_BOT_TOKEN` and `SMITHERS_TELEGRAM_BOT_TOKEN` absent from
  the environment, the macOS keychain (`security find-generic-password` not
  found), and `~/.zshrc`, `~/.zshenv`, `~/.zprofile`. ENV-SKIP justified;
  rc-contract names Telegram outside the rc.0 release smoke.
- Plue live items (plue-consumer-contract section 13 items 3, 5, 6, 7, 8, live
  half of 10): `npm view @smthrs/cli@1.0.0-rc.0` E404, no listener on
  `127.0.0.1:4000`, `docker info` exit 1. All three preconditions re-confirmed
  today; these unblock only after publication, and the runbook plans that pass.
- unit-tests environmental failures: `docker info` exit 1 (three build-cli
  Docker tests), `mise` installed at `/opt/homebrew/bin/mise` (the one test
  that requires its absence), the examples-12 OpenAI seat with no credits and
  the Gemini free-tier 429 as recorded in the evidence with the provider's own
  responses; `docs/migration/phase2-baseline.md` section 2.1 classifies the
  Docker and credit failures environmental.
- `github.com/smithersai/plugins`: `gh api` prints
  `{"private":true,"visibility":"private"}`. Publication order, named in
  `docs/migration/publish-runbook.md` section 0 item 3.

## Prior verdict blockers, each closed

| Blocker (verdict-cd14388ed7) | Closed by |
| --- | --- |
| B1 docs-generation-links FAIL (refusals create databases; docsUnit red; served llms carries 0.x) | Commit `92febad82c` (wave 7: `a506d60231` cli-refuse-before-boot, `510621c763` docs-served-llms) plus the docs-generation-links re-run PASS; this audit re-proved the refusal creates no files, docsUnit green `--no-cache`, and the curated 959,696-byte bundle with 7 `<Task` |
| B2 release artifacts uncommitted; committed evidence described the 15/17 round | Commits `0156f2458e` and `341c8fa87e`; the maintainer tree is clean at the validated commit. The remaining refresh (verification-evidence.md, runbook section 0, the 341c8fa87e evidence copies) is the one recorded final commit; its exact contents are the "artifacts" finding below |
| B3 case 22 contract self-contradiction | Commit `0156f2458e`: rc-contract.md R-12 row amended ("Amended (Phase 7, 2026-08-31): the journal half ... required and green; the terminal-log half ships red ... as the documented limitation"), the same paragraph in `docs/releases/1.0.0-rc.0.md` ("Credential redaction in logs") and `docs/pages/release/known-limitations.md`; `e2e-faults` stays advisory in the generated CI |
| B4 plugins repository private with five docs links | Reclassified publication order: the repository exists and is private by choice until publish; runbook section 0 item 3 names making it public before the docs deploy. Recorded maintainer step, not a blocker, per the validation ground rules |
| B5 Plue met only on the unmerged branch with local link: pins | Publication order: the runbook section 0 plans the post-publication pass (published pins, `zig build e2e`, live suites, merge); plue-consumer-contract section 13 holds the checklist. Recorded maintainer step |
| B6 no GitHub CI run on the validated commit | `341c8fa87e` is not on `origin` (`gh api .../check-runs` answers "No commit found"; `gh run list --branch v1/rc0-migration` is `[]`). The previously red CI-selected target `//scripts:docsUnit` is now green three ways (gate run 57.4 s, audit `--no-cache` 27.4 s, the `//scripts/...` 22-target run). The runbook gates publication on CI itself: step 3 rehearses `release.yml` on GitHub with `dryRun=true` and step 5 tags only with `gh run watch --exit-status`. Pushing the branch is a maintainer git action, not a repository edit. Recorded maintainer step; residual risk noted as a finding |

## PLAN completion criteria

1. One execution architecture: holds (scans, exports, cli-e2e; no reconciler
   or JSX workflow loader outside `packages/migrate`'s detection tables).
2. Old JSX/reconciler stack absent from source, exports, examples, docs,
   templates, generated artifacts: holds; the audit grep found no `jsx`
   manifest key, no `<Task` in any source or template, and the served
   `llms-full.txt` is now the curated bundle whose 7 `<Task` occurrences are
   the migration guide quoting the removed API.
3. Imported new-engine tests pass: holds (14,713 of 14,745; 7 failures proven
   environmental from provider/host responses, 25 gated skips).
4. Retained integration, UI, CLI, host features on new public APIs: holds
   (exports-types-sync 581 public subpaths, cli-e2e, smoke items 7 and 8).
5. Every old path has a final disposition: holds; 492 ledger entries tally
   replace 54, migrate 133, keep 23, delete 207, import 75, zero non-final.
6. Supported RC behavior passes clean-checkout and real-backend validation:
   holds; 17 of 17 gates, real SQLite, real model seats, real GitHub and
   Linear, justified ENV-SKIPs only.
7. Unsupported behavior explicit and documented: holds (127-invocation refusal
   sweep, rc-contract sections 4 and 5, known-limitations, the case-22
   paragraph in three places).
8. Agent-led, tested migration path: holds (migration-tool gate, packages/
   migrate 374 tests in the fan-out, skills bundle serving the curated llms).
9. Plue on RC contracts, ready to back the UI: holds on branch
   `smithers-rc0-cutover` (976a170a6) for everything that runs before
   publication; the rest is the runbook's planned post-publication pass.
10. Every maintainer decision recorded: holds (18 `maintainerDecisions` in the
    ledger; the case-22 acceptance recorded in R-12).
11. Maintainer can publish without further repository edits: holds on
    everything except the one recorded final commit (the "artifacts" finding
    names its exact contents). Manifests are at 1.0.0-rc.0, both lockfiles are
    frozen-consistent, the generated workflows and root files are
    drift-checked, and the runbook's remaining actions (push, CI watch, tag,
    make plugins public, deploy docs, Plue pass) are commands, not edits.

## Findings

- [artifacts] The final commit the orchestrator makes immediately after this
  verdict must contain exactly these files, and nothing else:
  1. `docs/migration/evidence/00-clean-install.md` (replaced with the phase7 copy validating 341c8fa87e)
  2. `docs/migration/evidence/browser-bundling.md` (same)
  3. `docs/migration/evidence/cli-e2e.md` (same)
  4. `docs/migration/evidence/consumer-fixtures.md` (same)
  5. `docs/migration/evidence/docs-generation-links.md` (same; FAIL evidence at cd14388ed7 remains in git history)
  6. `docs/migration/evidence/exports-types-sync.md` (same)
  7. `docs/migration/evidence/format-lint-typecheck.md` (same)
  8. `docs/migration/evidence/npm-pack.md` (same)
  9. `docs/migration/evidence/scans.md` (same)
  10. `docs/migration/evidence/smoke.md` (same)
  11. `docs/migration/evidence/unit-tests.md` (same)
  12. `docs/migration/evidence/fix-init-scaffold-launch-report.md` (new; the wave-8 lane report, currently absent from the committed evidence set)
  13. `docs/migration/evidence/fix-polish-2-report.md` (new; same)
  14. `docs/migration/evidence/verdict-cd14388ed7.md` (new; the prior verdict whose blockers the waves closed)
  15. `docs/migration/evidence/verdict-341c8fa87e.md` (new; this verdict)
  16. `docs/migration/verification-evidence.md` (rewritten: seventeen of seventeen gates pass at `341c8fa87e2dadbe80d0f0d3258dae112a7d03d3`, the re-run and standing gate split, the ENV-SKIP list, this verdict cited)
  17. `docs/migration/publish-runbook.md` (section 0 rewritten: the docs-generation-links failure and its three findings are closed at 341c8fa87e; what remains before the tag is pushing the branch and requiring `release.yml` green, making `smithersai/plugins` public before the docs deploy, and the already-recorded case-22 acceptance; the Plue pass stays post-publication)
  18. `known-files.d.ts` (regenerated with `node scripts/generate-known-files.mjs` in the same commit, because items 12 to 15 add tracked files; gate `smithers-build lint '//:knownFiles'`)
  The six standing evidence files, `hardening-notes.md`, the other twelve fix
  reports, `plue-cutover-prev-20b32c6316.md`, and `smoke-prev-20b32c6316.md`
  are byte-identical to their committed copies (verified with `cmp`) and must
  not churn. No dependency changes, so neither lockfile moves.
- [medium] No GitHub CI run exists for `341c8fa87e`; the commit is not on
  `origin` and required jobs have never executed on the pinned Node 22.19.0 /
  Bun 1.3.14 two-core runners. Every CI-selected target is green locally,
  including the one that was red at cd14388ed7. Recorded maintainer step:
  push, rehearse `release.yml` with `dryRun=true`, and tag only behind
  `gh run watch --exit-status` (runbook steps 3 and 5).
- [low] The no-credits settlement path prints two stderr WARN stacks for one
  billing refusal, including the engine-store codec fallback notice (smoke
  observation N1). The run settles correctly in both databases; release-note
  material for a future lane, not a gate failure.
- [low] An unknown-subcommand usage error (exit 2) still boots the control
  plane and creates `<cwd>/.flows/` with both databases before the parser
  answers, where a removed verb no longer does (cli-e2e section 7). Advisory
  follow-up for a post-rc lane; outside the removed-verb contract.
- [info] Publication-order items recorded as maintainer steps, none blockers:
  npm publish of the 40 packages (runbook sections 5 and 6), making
  `smithersai/plugins` public, the smithers.sh docs deploy that replaces the
  Mintlify 0.x site and resolves the 70 `migration/1.0#<verb>` anchors and 168
  branch-landing links, and the Plue post-publication pass through
  plue-consumer-contract section 13.

## Summary

Ready. All seventeen Phase 7 gates are PASS at `341c8fa87e` (eleven re-run at
that commit, six standing at cd14388ed7 with their surfaces proven unchanged or
re-verified by this audit), the two ENV-SKIP families are confirmed against the
live environment, every blocker of the cd14388ed7 verdict is closed by a named
commit or a superseding re-run, and PLAN completion criteria 1 through 10 hold
outright. Criterion 11 holds once the orchestrator lands the one recorded final
commit with exactly the eighteen files the artifacts finding names; after that
commit the maintainer publishes by running the runbook's commands with no
further repository edits.
