# 🐛 fix(gateway): [medium] openapi-gen emits digit-only string examples unquoted, corrupting them into YAML numbers

GitHub: https://github.com/smithersai/smithers/issues/703

_via ultracode (Opus multi-agent) review_

## Summary
`scalarToYaml()` emits any digit-only / numeric-looking string as a bare YAML scalar, so string-typed examples in the published `openapi.yaml` re-parse as numbers, contradicting their own `type: string`.

## Location
- `packages/gateway/scripts/generate-openapi.ts:379` — returns the string unquoted whenever it matches `/^[A-Za-z0-9_./:-]+$/` and is not literally `"true"`/`"false"`/`"null"`. No guard for strings that are valid YAML numbers.

## Failure scenario (confirmed in the shipped artifact)
- `packages/gateway/openapi.yaml:11492, 11874, 12245`: `contentHash: 0000…0` (64 zeros), declared `type: string` (schema at `openapi.yaml:5665`, `:11464`). A YAML 1.1/1.2 parser loads it as integer `0`.
- `packages/gateway/openapi.yaml:4599`: `schemaVersion: 0016`, declared `type: string`. PyYAML loads it as integer `14` (octal); other parsers give `16`.
- Verified: `yaml.safe_load('x: 0000…0') -> {'x': 0}` and `yaml.safe_load('x: 0016') -> {'x': 14}`.

Any future digit-only string example or enum (numeric codes, zero-padded ids, all-digit hashes) is silently coerced to a number.

## Why it matters
`openapi.yaml` is a published artifact (listed in `packages/gateway/package.json` `files`, line 31) that downstream codegen/validation tools treat as the source of truth. Emitting a `type: string` value as a YAML number makes the contract lie about its own types and breaks strict validators/codegen.

## Fix
In `scalarToYaml`, also `JSON.stringify` (quote) any string that would round-trip as a YAML number, bool, or null — e.g. reject values matching the YAML int/float regex in addition to `true`/`false`/`null`.
