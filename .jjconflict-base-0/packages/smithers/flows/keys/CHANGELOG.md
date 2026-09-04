# @smthrs/keys

## [1.0.0-rc.0] - 2026-08-31

### Added

- Added explicit `KeyV1` and `StoredKey` schemas for identity-preserving
  validation of persisted keys.
- Added typed derivation through `deriveKey` with stable, cause-preserving
  `KeyDerivationError` codes.
- Added package-owned documentation and frozen `key1_` wire vectors.

### Changed

- Reject unsupported future version markers instead of guessing their payload
  representation.
- Redact derivation input from schema diagnostics and document domain,
  canonicalization, and memory requirements.
- Retain `Key` as the one-way derivation compatibility schema with discoverable
  `derive`, `StoredKey`, and `KeyV1` properties.
- Move cache, invocation, environment, and filesystem policy to the engine;
  this package owns only generic key derivation and wire validation.

## [0.1.0] - 2026-08-05

### Added

- Added canonical serialization, injected SHA-256 digests, cache keys, and
  invocation keys.
