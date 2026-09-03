---
status: queued
anchor: head
priority: p1
---

# README backfill: crypto and keys

Bring the two packages failing the DocsParity gate up to the colocated-docs
contract (the "Colocated Docs" spec), then enable the `docs` kind in CI.

- At landing time of item 0002, `smthrs docs //...` fails exactly two
  packages: `packages/smithers/flows/crypto` (53 prose characters) and `packages/smithers/flows/keys`
  (64), both below the 120-character prose floor. Every other package
  passes.
- Write each README as the package's contract: what it is, its invariants,
  its design rationale, how it relates to its neighbors. Standalone
  markdown, relative links only, no wikilinks.
- `packages/smithers/flows/engine`, `packages/smithers/flows/flow`, and `packages/smithers/flows/plan` have explicit
  `PACKAGE.ts` files destructuring `{ lib, test, lint }` from
  `StandardPackage`; add `docs` to those destructurings so they gain the
  target.
- When `smthrs docs //...` is green, add the `docs` kind to the CI
  generator declaration in the root `PACKAGE.ts` (read the current
  `GithubCiGen` shape first; the file has grown) and regenerate the CI
  workflow, so doc drift becomes a red check from then on.
