# @smthrs/targets

## [Unreleased]

### Added

- Added opt-in compile-time validation for `Smithers.file` paths. A generated
  `KnownFile` declaration uses the workspace input scan and existing
  generated-file drift checks while ungenerated workspaces retain `string`.
