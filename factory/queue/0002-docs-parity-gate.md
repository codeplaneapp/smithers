---
status: landed
anchor: head
priority: p0
---

# Docs parity gate as a smithers build rule

Implement the parity gate from the "Colocated Docs" spec as a smithers build
rule wired into `PACKAGE.ts`, so package documentation is a declared build input
and doc drift is a cache miss.

- A `DocsParity` rule per package: README.md present and non-trivial, every
  exported symbol carries JSDoc with `@since`/`@category` (the effect repo
  convention; `eslint.jsdoc.js` is the existing lint half).
- Declare each package's README as an input to its check targets via the
  Bazel-style `file()` declarations that landed in commit `04b9367`.
- Prior art to read first: the documentation checks from the Smithers 0.x DDD
  pack under `.smithers/lib/ddd/`, which the 1.0 migration removed.
- Resolve the open question in the Colocated Docs note (which export kinds
  require JSDoc; whether a change may declare "no doc impact") in the note,
  with how it was decided, before merging the rule.

## Landed

Shipped as `packages/smithers/build/targets/src/DocsParity.ts` and emitted by
`StandardPackage` as a fourth target beside `lib`, `test`, and `lint`.

- The rule owns README presence and quality only: the file exists, carries a
  level-one title, and holds at least `minimumProseCharacters` (default 120)
  of prose once badges, link targets, headings, lists, tables, and fenced code
  are stripped. The README is declared attrs, so editing prose re-keys the
  target.
- JSDoc parity is deliberately not duplicated. The root `eslint.jsdoc.js`
  already requires a description, `@since`, and `@category` on every exported
  declaration, and `StandardPackage` runs it under `lint`.
- The rule participates in a new `docs` kind, invoked with `smthrs docs
  //...`. `ciKinds` keeps `build`, `test`, and `lint`, so the gate does not
  turn CI red before the README backfill.
- The Colocated Docs note records the resolved surface and how it was decided.

Failing parity at landing time, from the rule's own policy over
`packages/*`:

- `packages/smithers/flows/crypto` — 53 prose characters, below the 120 floor
- `packages/smithers/flows/keys` — 64 prose characters, below the 120 floor

Every other package passes. `packages/smithers/flows/engine`, `packages/smithers/flows/flow`, and
`packages/smithers/flows/plan` have explicit `PACKAGE.ts` files that destructure
`{ lib, test, lint }`, so they gain a `docs` target only once those three
lines also destructure `docs`; all three already pass the policy.

Enabling `docs` in CI waits on the README backfill, which is separate queued
work.
