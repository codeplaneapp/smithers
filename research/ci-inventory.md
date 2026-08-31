# CI and gate inventory

Source snapshot: `84ac43ad1e0c6ec6f880d2a55876ee0a1ce93bf3`, 2026-08-31.

## Generated-file drift gates

- `.github/workflows/ci.yml` is itself generated from root `BUILD.ts`
  (`pnpm exec smithers-build build '//:ci'`) and drift-checked with
  `pnpm exec smithers-build lint '//:ci'` (CLAUDE.md Commands; BUILD.ts).
- Known-file registry: `Smithers.Generate` at `BUILD.ts:12`, CI step
  "Known-file registry drift" at `BUILD.ts:146` (`//:knownFiles`). Added
  in cb2ae764ad after ten standalone regen chores (see
  `research/history.md`).
- `tsconfig.json` is generated from the `Smithers.Tsconfig` declaration at
  `BUILD.ts:25`, but `grep -n tsconfig .github/workflows/ci.yml` finds no
  drift lint for it. Hand edits exist: 6ff3c3c334, 65b2bf8c2f. `git log
  --oneline -- tsconfig.json | wc -l` reports 51 commits. Gap.

## Script gates (`scripts/check-*.mjs`, declared in `scripts/BUILD.ts`)

`ls scripts/check-*.mjs`:

- `check-docs.mjs` — 14 checks over the vocs page tree (file header line 5;
  `grep -c 'fail(' scripts/check-docs.mjs` = 14); 196 commits of history.
  Runner declared at `scripts/BUILD.ts:290`.
- `check-llms.mjs` — llms bundle parity; runner at `scripts/BUILD.ts:304`.
- `check-single-effect-version.mjs` — hand constant
  `EXPECTED_EFFECT_VERSION = "4.0.0-rc.108"` at line 30.
- `check-npm-dedupe.mjs`, `check-dependency-boundaries.mjs`,
  `check-test-pins.mjs`, `check-legacy-absent.mjs` (Phase 7 gate),
  `check-local-smithers.mjs`.
- `check-lockfile-pair.mjs` exists untracked on this branch (`git status
  --short`) — the `//:lockfilePair` gate this branch introduces; no prior
  gate paired `pnpm-lock.yaml` with `bun.lock` in the rc tree (the 0.x
  gate 340ca5461c was lost in migration).
- Release targets live in `scripts/BUILD.ts` alongside the gates.

## CI jobs (root `BUILD.ts`)

`requiredJobs` at `BUILD.ts:86`: test, apps-e2e, rust, wasm-repro, bun,
browser, node-macos, node-windows. `wasm-repro` byte-compares
`flows_jj.wasm` via `//crates/flows-jj:wasmReproducibility`
(`BUILD.ts:188-202`). actionlint runs over the workflow tree (declared in
the BUILD graph; workflows in `.github/workflows/`: apps-deploy, canary,
ci, docs-deploy, pr-review, release).

## Agentic lints (`lint/BUILD.ts`)

All run over `Smithers.gitDiff("origin/main")` (`lint/BUILD.ts:12`):

- `durableIdentityGuard` (`lint/BUILD.ts:28`, `failOn: "error"`, line 60)
  — includes the "new migration file required" rubric.
- `docsReferenceSync` (`lint/BUILD.ts:69`, `failOn: "warning"`, line 93).
- `jsdocTruthfulness` (`lint/BUILD.ts:102`, `failOn: "warning"`, line 123).

## Other automation

- `pr-review.yml` and `canary.yml` in `.github/workflows/`.
- `factory/queue/` holds 12 queued factory items (`ls factory/queue`);
  `factory/README.md` documents the queue driver, which is not yet a
  tracked flow.
