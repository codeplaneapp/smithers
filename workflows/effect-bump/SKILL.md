# Effect pin bump

Move the repository's single Effect compatibility pin to the exact requested
release. This is a release-contract change, not an ordinary dependency update:
the guard constant, every covered manifest, both lockfiles, and rc-contract
section 9 must agree in one candidate.

## Inputs

- `version` is the exact published Effect version to adopt. Ranges, tags such
  as `latest`, and inferred versions are invalid.

## Procedure

1. Read `scripts/check-single-effect-version.mjs` and section 9 of
   `docs/migration/rc-contract.md`. Inventory all workspace manifests before
   editing; do not rely on a remembered package list.
2. Change `EXPECTED_EFFECT_VERSION` to `version`.
3. In every covered manifest, replace exact pins for `effect` and the Effect
   packages section 9 binds to the same release:
   `@effect/platform-node`, `@effect/platform-node-shared`,
   `@effect/platform-bun`, `@effect/sql-sqlite-node`,
   `@effect/opentelemetry`, and `@effect/vitest`. Preserve dependency sections,
   peer metadata, key ordering, and unrelated versions. Do not change
   `@effect/language-service`; section 9 pins it independently.
4. Update the Effect row and compatibility statement in rc-contract section 9
   so the supported range is exactly `version`. Update no unrelated contract
   decision.
5. Refresh both lockfiles from the edited manifests:

   ```sh
   pnpm install --lockfile-only
   bun install --lockfile-only
   ```

   Inspect the result and reject unrelated dependency upgrades or package
   membership churn.
6. Run the two governing gates:

   ```sh
   pnpm exec smithers-build test '//scripts:effectVersion'
   pnpm exec smithers-build test '//scripts:lockfilePair'
   ```

7. Search again for the previous exact pin in the guard, covered manifests,
   lockfiles, and section 9. A remaining old pin is a failure unless section 9
   explicitly gives that package an independent version.

## Decline conditions

Decline without edits when `version` is missing, is not an exact release, or
cannot be resolved by both package managers; the requested release would
require a mixed Effect graph; a manifest needs a range or compatibility
decision not already made by section 9; or regenerating either lockfile causes
unexplained dependency movement. Never hand-edit lockfile resolution records,
leave one lockfile stale, or relax either gate.
