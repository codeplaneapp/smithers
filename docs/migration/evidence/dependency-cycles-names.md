# Gate: dependency-cycles-names

Verdict: PASS

PLAN.md Phase 7 item: "dependency-cycle and duplicate-package-name checks".
Contract reference: rc-contract.md section 9 pins `madge 8.0.0` (`circular`)
as the tooling baseline. PLAN.md Phase 3 requires "package names are unique".

## Environment

- Checkout: /Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout
- HEAD: 9c464343f0cfada6aa36f0a08144ed7cf1f0ce14 (branch v1/rc0-migration)
- Node v24.18.0, pnpm 11.21.0 (via corepack), Bun 1.4.0, madge 8.0.0
- Date: 2026-08-30, macOS arm64 (Darwin 25.2.0)

## Dependency-cycle check

Command (from the checkout root):

```sh
corepack pnpm run circular
```

Exit code: 0.

The root script runs `pnpm --recursive --if-present run circular` over
"Scope: 62 of 63 workspace projects" (the root project is excluded from the
recursive scope). 51 projects define a `circular` script; each runs
`node scripts/circular.mjs`, which invokes madge on `src` with
`fileExtensions: ["ts"]`, the package `tsconfig.json`, and
`skipTypeImports: true`, and sets exit code 1 when `result.circular()` is
non-empty. All 51 printed `circular: Done`; none reported
"Circular dependencies found". Final output lines:

```
packages/cli circular: Done
packages/build-cli circular: Done
```

11 workspace projects have no `circular` script and are skipped by
`--if-present`: apps/bug-worker, apps/review, apps/server, apps/shared,
apps/status-site, apps/tui, apps/ui, examples, packages/build/infra,
packages/ui, packages/ui-styleguide. These are private apps, the examples
project, the build-cache Worker, and the two retained 0.x UI kits; none is a
publishable rc.0 library, and the skip matches the checked-in scripts on the
gated revision, so it is not a defect of this gate.

## Package-name uniqueness

Command:

```sh
corepack pnpm m ls --json --depth -1
```

then grouping every project path by its `package.json` `name`.

- Projects enumerated: 63 (62 workspace projects plus the root `smithers`).
- Unnamed projects: 0.
- Duplicate names: 0. Every name maps to exactly one path.

Names observed: 57 under the `@smthrs/*` scope (packages/* including
`@smthrs/build-infra` at packages/build/infra, plus apps/bug-worker,
apps/review, apps/status-site, and examples), the unscoped `smithers` (root),
`smithers-server`, `smithers-shared`, `smithers-tui`, `smithers-ui`
(apps/*), and `smthrs` (packages/smthrs-deprecation). `legacy/` is outside
the `pnpm-workspace.yaml` patterns (`packages/*`, `packages/build/infra`,
`examples`, `apps/*`) and contributes no names, as required by the workspace
invariants.

## Verdict

PASS. `corepack pnpm run circular` exits 0 with zero cycles across all 51
projects that declare the check, and all 63 workspace project names are
unique with zero duplicates.
