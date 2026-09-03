# Executor lane report

## Changed

- Moved target-body execution and its complete Effect layer stack into shared `TargetExecution.ts`; both declaration loaders use it.
- Removed the rule allowlist and generic refusal. Unhandled rules now execute their declared target body with schema validation, declared-output checks, sandboxing, caching, scheduling, and reporting.
- Planned verb-effective attrs, outputs, cacheability, gates, and `Target.subtree` dependency selectors from target metadata. Bumped `PACKAGE_EXECUTION_FORMAT` to `2`.
- Routed `docs`, merged `ci`, and root `Install` execution through the `PACKAGE.ts` index while retaining the existing `BUILD.ts` loader unchanged.
- Added a real fixture covering Vitest, Typecheck, NodeTest, EsLint, Dprint, Tsconfig, TsBuild, GithubCiGen, Install, Lockfile, Generate, DocsParity, Filegroup, and `Target.subtree`, including aggregate verbs and a cache hit.
- Removed the obsolete refusal text from the touched implementation and tests.

## Gates

- `pnpm --filter @smthrs/build-cli run check` — pass:
  ```text
  $ tsc -b tsconfig.json && tsc -p tsconfig.test.json --noEmit
  ```
- `pnpm --filter @smthrs/build-cli run lint` — pass:
  ```text
  $ eslint src --max-warnings=0 && dprint check
  ```
- `pnpm --filter @smthrs/build-cli test` — pass:
  ```text
  Test Files  64 passed (64)
       Tests  1044 passed | 2 skipped (1046)
  Statements   : 87.13% ( 9757/11198 )
  Branches     : 77.21% ( 5827/7546 )
  Functions    : 90.47% ( 1368/1512 )
  Lines        : 89.88% ( 8773/9760 )
  ```
- Focused real-fixture rerun — pass:
  ```text
  Test Files  1 passed (1)
       Tests  1 passed | 50 skipped (51)
  Duration  12.36s
  ```
- `pnpm run circular` — pass:
  ```text
  packages/chain circular: Done
  packages/create-app circular: Done
  packages/evals circular: Done
  packages/build-cli circular$ node scripts/circular.mjs
  packages/build-cli circular: Done
  ```
- `node scripts/generate-known-files.mjs` — pass with no output; `known-files.d.ts` changed from 5,494 to 5,511 discovered files.

Intermediate attempts caught and fixed formatting, typing, and assertion issues:

```text
Found 3 not formatted files. Run dprint fmt to fix.
Exit status 20
```

```text
src/Cli.ts(873,42): error TS2339: Property 'cache' does not exist on type '{ workspace: string; cacheDir?: string | undefined; }'.
Exit status 1
```

```text
Test Files  1 failed | 2 passed (3)
     Tests  1 failed | 64 passed (65)
  Duration  52.18s (transform 15.61s, setup 0ms, import 24.03s, tests 57.20s, environment 0ms)
```

```text
Test Files  1 failed (1)
     Tests  1 failed | 50 skipped (51)
  Duration  11.16s (transform 4.49s, setup 0ms, import 5.55s, tests 5.45s, environment 0ms)
```

The assertions now match the stable quoted plan and a genuinely cacheable DocsParity target. One staged-tree full-suite attempt also encountered a transient host Docker failure:

```text
FAIL  test/ChainExecution.test.ts > Docker package execution > builds an OCI archive through CAS and restores it on a cache hit
ERROR: failed to build: OCI exporter is not supported for the docker driver.
Test Files  1 failed | 63 passed (64)
Tests  1 failed | 1043 passed | 2 skipped (1046)
```

The isolated Docker test immediately passed (`1 passed | 9 skipped`), then the complete suite passed as recorded above. No gate remains red.

## Decisions and remaining verification

- `Install` uses the existing install runtime directly, validates the target's declared success schema, and still runs after its graph dependencies. Its nested Flow call cannot be interpreted by the generic outer-target runtime.
- The requested converted `packages/canonical` scratch commands could not run in this lane because neither `.smithers/WORKSPACE.ts` nor `packages/canonical/PACKAGE.ts` exists here; the conversion is owned by the sibling lane. The equivalent real fixture runs the target families plus `test`, `ci`, `docs`, and `install` successfully.
- The package's configured coverage gate uses measured floors rather than 100%; the unmodified thresholds passed. No threshold was lowered.
