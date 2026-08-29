# Changelog

## [Unreleased]

### Added

- Added the Schema-first `Flow` and pipeable `Node` builders, placement and
  effect annotations, markdown lowering, graph introspection, and digest-free
  key-material handoff.

### Fixed

- Replaced the provisional `skill_parser_not_implemented` failure with complete
  Agent Skills YAML parsing. Callers now receive the stable
  `skill_missing_frontmatter`, `skill_invalid_frontmatter`,
  `skill_missing_name`, and `skill_missing_description` error codes.
