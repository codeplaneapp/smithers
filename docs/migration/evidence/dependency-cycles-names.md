# Phase 7 gate: dependency-cycles-names

Verdict: PASS

`corepack pnpm run circular` exits 0 with zero import cycles across the 51
workspace projects that declare the check (888 modules, 1,613 edges), and all
64 workspace project names are unique. `legacy/` is absent from the tree, so no
retired package can contribute a name.

PLAN.md Phase 7 item: "dependency-cycle and duplicate-package-name checks".
Contract reference: rc-contract.md section 9 pins `madge 8.0.0` (`circular`) as
the tooling baseline, and the `@smthrs/targets` `PackageDefaults` synthesizes a
`circular` target for every `packages/*` directory. phase3-validation.md row
"Circular dependencies" records the same command at exit 0 for Phase 3.

This file supersedes the 2026-08-30 evidence taken at `9c464343f0` in
`migration/clean-checkout` (that directory no longer exists).

## Environment

| Item | Value |
| --- | --- |
| Host | macOS 26.2 (25C56), Darwin 25.2.0, arm64 |
| Date | 2026-08-31 06:57 to 07:02 UTC (2026-08-30 23:57 to 2026-08-31 00:02 PT) |
| Node | v24.18.0 |
| corepack | 0.35.0 |
| pnpm (via corepack, `packageManager: pnpm@11.21.0`) | 11.21.0 |
| Bun | 1.4.0 (`bun --version`; canary 1.4.0-canary.1+6618e7f7e) |
| madge | 8.0.0, one copy in the pnpm store (`madge@8.0.0_supports-color@10.2.2_typescript@6.0.3`); `require("madge/package.json").version` prints `8.0.0` from `packages/flow`, `packages/cli`, `packages/build-cli`, and `packages/engine` |

`SMITHERS_HOME` was unset (`env -u SMITHERS_HOME`) for every pnpm invocation.

## Checkout

Clean checkout at
`/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-2`,
HEAD `20b32c6316487497301db74ec70cbe951428ef53` on `v1/rc0-migration`, the same
commit as `/Users/williamcory/smithers` HEAD at gate time. Dependencies were
installed by the clean-install gate (`00-clean-install.md`). `git status --short`
was empty before and after this gate; the gate wrote nothing into the checkout.

Logs: `dependency-cycles-names-logs/` next to this file (`circular.log`,
`circular.exit`, `circular.start`, `circular.end`, `pnpm-m-ls.json`,
`check-unique-names.mjs`, `unique-names.txt`, `all-package-json.txt`,
`tree-wide-names.txt`, `madge-module-counts.txt`, `positive-control.txt`).

## 1. Dependency-cycle check

Command, from the checkout root:

```sh
env -u SMITHERS_HOME corepack pnpm run circular
```

Exit code: 0. Wall time: 14 s (06:57:53Z to 06:58:07Z).

The root script is `pnpm --recursive --if-present run circular`. pnpm printed
`Scope: 63 of 64 workspace projects` (the private root is excluded from the
recursive scope). 51 projects define `"circular": "node scripts/circular.mjs"`.
Each script calls `madge("src", { fileExtensions: ["ts"], tsConfig:
"./tsconfig.json", detectiveOptions: { ts: { skipTypeImports: true } } })` and
sets exit code 1 with `Circular dependencies found` when `result.circular()`
is non-empty. `circular.log` contains 51 `circular: Done` lines and zero
`Circular dependencies found`, `ELIFECYCLE`, or `ERR_PNPM` lines. Final output
lines:

```
packages/cli circular: Done
packages/build-cli circular: Done
```

12 of the 63 recursive projects have no `circular` script and are skipped by
`--if-present`: `apps/bug-worker`, `apps/review`, `apps/server`, `apps/shared`,
`apps/status-site`, `apps/tui`, `apps/ui`, `e2e`, `examples`,
`packages/build/infra`, `packages/ui`, `packages/ui-styleguide`. These are the
private apps, the e2e and examples projects, the build-cache Worker, and the two
retained 0.x UI kits. None is a publishable rc.0 library, and the skip matches
the checked-in scripts at the gated revision.

### 1.1 Graph sizes (proof the check parsed real graphs)

The same madge options were run once more per package, printing
`Object.keys(result.obj()).length` (modules), the summed adjacency length
(edges), and `result.circular().length`. Full table:
`dependency-cycles-names-logs/madge-module-counts.txt`.

| Metric | Value |
| --- | --- |
| Packages measured | 51 |
| Total modules | 888 |
| Total edges | 1,613 |
| Packages with `cycles=0` | 51 of 51 |
| Largest graphs | `packages/targets` 82 modules / 351 edges, `packages/flow` 47 / 105, `packages/std` 44 / 138, `packages/build-cli` 42 / 87, `packages/engine-store` 40 / 86 |
| Smallest graphs | `packages/smthrs-deprecation` 1 / 0, `packages/crypto` 2 / 1, `packages/keys` 2 / 1, `packages/canonical` 3 / 2, `packages/capability` 3 / 3 |

### 1.2 Positive control (proof the check is not tautological)

A byte-identical copy of `packages/flow/scripts/circular.mjs` (verified with
`cmp`) was run outside the checkout, in the scratchpad, against two two-file
fixtures with `madge` resolved through a symlink to `packages/flow/node_modules`:

| Fixture | Content | Output | Exit |
| --- | --- | --- | --- |
| `value` | `a.ts` value-imports `b.ts`, `b.ts` value-imports `a.ts` | `Circular dependencies found` then `[ [ 'a.ts', 'b.ts' ] ]` | 1 |
| `typeonly` | the same pair joined only by `import type` | nothing | 0 |

The `value` result shows the script fails on a real cycle. The `typeonly` result
documents the check's scope: `skipTypeImports: true` ignores type-only cycles by
design, because they erase at compile time and cannot cause a runtime
initialization order defect. Output: `dependency-cycles-names-logs/positive-control.txt`.

## 2. Package-name uniqueness

Command, from the checkout root:

```sh
env -u SMITHERS_HOME corepack pnpm m ls --json --depth -1
node dependency-cycles-names-logs/check-unique-names.mjs pnpm-m-ls.json <checkout>
```

The script groups every project path by its manifest `name`, prints the
duplicates, and exits 1 on any duplicate or unnamed project. Exit code: 0.
First output line:

```
projects=64 named=64 unnamed=0 duplicates=0
```

Every one of the 64 names maps to exactly one path (`unique-names.txt` lists the
full mapping). Composition: 58 `@smthrs/*` names (`packages/*` including
`@smthrs/build-infra` at `packages/build/infra`, plus `@smthrs/bug-worker`,
`@smthrs/review`, `@smthrs/status-site`, `@smthrs/e2e`, and `@smthrs/examples`),
the private root `smithers`, `smithers-server`, `smithers-shared`,
`smithers-tui`, `smithers-ui` (`apps/*`), and `smthrs`
(`packages/smthrs-deprecation`). The workspace globs are `packages/*`,
`packages/build/infra`, `e2e`, `examples`, and `apps/*`. The count is 64 rather
than the 63 in the superseded evidence because `e2e` joined the workspace
between `9c464343f0` and `20b32c6316`.

### 2.1 Tree-wide cross-check

`find . -name package.json` outside `node_modules`, `dist`, and `.git` returns
85 manifests: the 64 workspace projects plus 21 non-workspace manifests (test
fixtures under `packages/build-cli`, `packages/migrate`, `packages/harness`,
`apps/ui/e2e`, and `flows/migrate-smithers-v1`; the two `packages/create-app`
templates; `codex-plugin`; `vendor/jj/web/docs`). No non-workspace manifest
reuses a workspace name. Three names are shared only among fixtures and
templates, none of which pnpm or Bun treats as a package:

| Shared name | Paths | Why it is not a defect |
| --- | --- | --- |
| `__APP_NAME__` | `packages/create-app/template/aomi`, `packages/create-app/template/default` | scaffold placeholder that `create-app` rewrites |
| `jsx-single-example` | `packages/migrate/test/fixtures/jsx-single`, `.../jsx-single.migrated`, `.../persisted-db` | migration test fixtures, `.migrated` is the expected output of `jsx-single` |
| `smithers-workflows` | `packages/migrate/test/fixtures/mixed-api/.smithers`, `.../plue-pack/.smithers` | 0.x `.smithers` project fixtures the migrator reads |

`legacy/` does not exist at `20b32c6316` (`git ls-files legacy` returns 0
paths), so the Phase 7 `check:legacy-absent` precondition for this gate holds.

## Verdict

PASS. Zero import cycles across every workspace project that declares the check
(51 of 51, 888 modules), the check demonstrably fails on a real cycle, and all
64 workspace package names are unique with zero duplicates. No fix lane is
needed.
