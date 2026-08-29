# @smthrs/plugin

## [Unreleased]

### Added

- Added `cacheEnvironment` startup options for complete layer,
  configuration, and capability identity in sealed activity keys.

### Fixed

- Kept plugin-built sealed keys run-local while capability identity is
  unknown.
- Trimmed the base hook catalog to the configuration lifecycle that the shared
  kernel dispatches; cell hosts declare their own bounded hook catalog.

## [0.1.0] - 2026-08-05

### Added

- Added the Vite-style typed plugin kernel: plugin definition and
  construction, the `FlowsHooks` declaration-merging surface, hook
  resolution and ordering, plugin config execution, and structured
  `PluginError` failures.
