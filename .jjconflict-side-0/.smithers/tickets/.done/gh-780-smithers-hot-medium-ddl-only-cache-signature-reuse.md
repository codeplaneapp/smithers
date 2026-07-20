# 🐛 smithers(hot): [medium] DDL-only cache signature reuses stale Zod validators

GitHub: https://github.com/smithersai/smithers/issues/780

_via 2026-07 full-codebase audit_

## Summary

Hot mode hashes generated SQL DDL and reuses the entire cached Smithers API. Zod changes that preserve column types can therefore keep old refinements, defaults, transforms, and descriptions.

## Where

- `packages/smithers/src/create.js:42-55 — signature hashes DDL only`
- `packages/smithers/src/create.js:366-375 — equal signature returns cached.api`
- `packages/smithers/src/create.js:437-453 — validators live in the cached API`

## Failure scenario / repro

Create a hot API with z.string().min(1), then recreate it for the same DB with min(5). The second API still accepts a one-character value.

## Impact

Hot-reloaded workflows can validate against old business rules while source shows new rules, without a schema-change warning.

## Suggested fix

Separate physical DDL compatibility from semantic schema identity. Rebuild validators whenever schema semantics change, or fail closed and require restart when a stable semantic fingerprint is unavailable.

## Tests

- Cover min(1) to min(5), changed defaults/transforms, and unchanged equivalent schemas
- Assert changed semantics apply or are explicitly rejected

## Dedupe notes

No matching issue or PR.


> Closed by ticket-fleet: landed on main in 65e397854932aaf3a22eda22212c023bfd29e525.
