# @smthrs/errors

## [1.0.0-rc.0] - 2026-08-31

### Added

- Added `hasSmithersErrorShape` for structural refinement across duplicate
  package instances, with validation against the documented code vocabulary.
- Added package-owned documentation generated into
  `docs/pages/reference/errors.md`.

### Changed

- Trimmed the Smithers 0.x registry from 180 codes to the five codes the
  `@smthrs/integrations` trees raise under orchestrator ruling A1 (R-34) in
  `docs/migration/rc-contract.md` §8.2.
- Closed the `SmithersErrorCode` union over the keys of
  `smithersErrorDefinitions`.
- Copy and freeze the top-level `details` record at construction, and freeze
  the definition and known-code tables. Nested detail values remain shared by
  reference and are not deep-frozen.
- Strip the documentation URL suffix from `summary`, match it only as a suffix
  instead of a substring, tolerate trailing and inter-suffix whitespace, and
  skip it when the summary is blank.
- Omit `cause` as an own property when the caller supplies no cause or passes
  `cause: undefined`.
- Remove the unused parameter from `getSmithersErrorDocsUrl`.
