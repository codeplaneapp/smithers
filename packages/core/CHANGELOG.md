# Changelog

## [Unreleased]

### Added

- Added the Schema-first `Flow` and pipeable `Node` builders, placement and
  effect annotations, markdown lowering, graph introspection, and digest-free
  key-material handoff.
- Added `Node.priority` and the `Annotations.Priority` key, carried onto the
  graph node and inherited lexically. Priority stays out of key material.
- Added `Node.catch`, which recovers a node's typed failures with a statically
  planned arm, and `Node.fail`, which re-raises from one.

### Fixed

- Replaced the provisional `skill_parser_not_implemented` failure with complete
  Agent Skills YAML parsing. Callers now receive the stable
  `skill_missing_frontmatter`, `skill_invalid_frontmatter`,
  `skill_missing_name`, and `skill_missing_description` error codes.
