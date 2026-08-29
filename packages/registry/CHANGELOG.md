# /registry

## [Unreleased]

### Added

- Recognised the `effort` frontmatter key on markdown flows.

- Added portable flow descriptors, progressive discovery, markdown skill compatibility, and the refreshable registry service.
- Added inline JSON Schema references that round-trip with every tagged schema reference through flow descriptors.

### Fixed

- Target module discovery at the default Flow export and conservatively classify regex-bearing, agent, and external-write declarations.
- Validate Agent Skills frontmatter leniently with field-specific warnings.
- Conservatively classify module spreads, computed properties, and unscoped writes; parse skill frontmatter with failsafe scalar and space-separated `allowed-tools` semantics.
- Preserve CJS constructor identity across root and subpath exports.
- Project the real `Flow.make` effects contract and retain conservative schema references for unprojectable object members.
- Keep Agent Skills tool preapproval separate from authority, disclose skill resource roots on activation, and sanitize frontmatter to serializable JSON.
- Cover registry loading with an unmodified, provenance-pinned Agent Skills
  fixture from Anthropic.
