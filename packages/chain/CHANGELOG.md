# @smthrs/chain

## [Unreleased]

### Breaking Changes

- Renamed the package from `@smthrs/chain` to `@smthrs/chain`, the name
  every unreleased flows package carries until the smithers parity release.

### Changed

- Promoted the package out of `apps/mvp/vendor/smthrs/chain` into
  `packages/chain` as a first-class workspace member: real workspace
  dependency specifiers in place of the vendored `file:` and `*` references,
  `effect` moved from `4.0.0-beta.102` to the workspace pin `4.0.0-rc.108`,
  and the sibling `tsconfig.json`, `tsconfig.test.json`, `eslint.config.js`,
  `dprint.json`, `vitest.config.ts`, and build scripts restored.
- Rewrote the `@smthrs/capability` import specifiers to
  `@smthrs/capability`.

## 0.0.0

- Initial slice: journal event vocabulary, call keys, trampoline outcomes,
  in-memory journal, catalog, mock author seat, in-process script runner,
  and the chain trampoline with gates 1–3 and prefix replay.
