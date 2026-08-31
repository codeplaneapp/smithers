# Lane: canonical-productionize (branch phase7/canonical-productionize, base 84ac43ad1e)

Productionize `packages/canonical` to the standard: clear, stable, located errors; complete
JSON.stringify parity where the docblock promises it; a test suite with no conceivable
non-redundant case missing. Work ONLY in this worktree. TDD: every behavior change lands with
a test that was red before it. Never weaken a test; restate a pin only with a comment naming
the old behavior and why the contract wins. This package is digest-critical: every digest in
the engine is taken over its output, so every OUTPUT-CHANGING decision must be listed in the
final report under "Digest impact" (rc.0 is unpublished, so changes are allowed but must be
enumerated, and the full test suites of every workspace consumer of @smthrs/canonical must
pass afterwards: grep the workspace manifests for the dependency and run each package's
`pnpm --filter <name> run test`).

## 1. Error quality (output bytes unchanged)
Every rejection carries a stable code and a JSON-Pointer-style path to the offending value:
- `canonical_nan` / `canonical_non_finite` (name the actual value, -Infinity vs Infinity),
  `canonical_lone_surrogate` (say whether key or value, include the path),
  `canonical_circular` (path of the re-entered object), `canonical_unsupported_value`
  (top-level undefined/symbol/function through the schema), `canonical_bigint`,
  `canonical_depth_exceeded`, `canonical_tojson_threw` / `canonical_getter_threw`
  (wrap the cause, keep its message, add the path).
Shape: a dedicated error class (e.g. `CanonicalError extends TypeError`) with `code` and
`path` fields and a message like `canonical_non_finite: -Infinity at $.payload.cost`;
exported from the package root; the Canonical schema maps it into its SchemaIssue with the
same message so schema users see identical text. Paths use `$`, `.key` for plain keys,
`["exotic key"]` otherwise, `[3]` for indices, and note when inside a toJSON result
(e.g. `$.x.toJSON()`). Pin every code and path shape with tests, red first.

## 2. Determinism and depth
Replace host-dependent stack exhaustion with an explicit depth counter and a documented
bound (10_000 levels), throwing `canonical_depth_exceeded` with the depth and path prefix.
The existing recursion-depth test is restated to the deterministic bound. Values within the
bound serialize byte-identically to before.

## 3. Parity completion (each red-first; each listed under Digest impact)
- `toJSON(key)`: pass the key exactly as JSON.stringify does ("" at top level, the property
  key, the stringified array index). Pin with a key-sensitive toJSON.
- Boxed primitives: `new Number(1)` -> `1`, `new String("ab")` -> `"ab"`,
  `new Boolean(true)` -> `true` (unbox via the same internal coercion stringify uses; a boxed
  NaN/Infinity then hits the number rejections; a boxed BigInt throws canonical_bigint).
  The current `{}` pins are restated.
- Sparse arrays: holes render as `null` (current code emits invalid `[,]`-style output or
  rejects; align with stringify). Pin `[ ,1]` and a trailing-hole case.
- Map/Set and other non-plain built-ins (WeakMap, WeakSet, ArrayBuffer, typed arrays,
  RegExp, Error): DECIDE with evidence and document in the module docblock. Default
  position to argue against: reject with `canonical_unsupported_value` naming the
  constructor, because stringify's `{}`/`{"0":...}` renderings create digest collisions in a
  digest library; strict parity loses to digest safety here. Whatever you decide, pin every
  listed constructor. Date stays as-is (its toJSON governs).
- Enumerable-getter objects: a getter that throws -> `canonical_getter_threw` with path; a
  getter that mutates siblings during serialization: pin the observed, documented order
  (keys snapshot then serialized in sorted order).
- Proxies: a proxy over a plain object serializes through its traps like stringify; a trap
  that throws maps to `canonical_getter_threw`. Pin both.

## 4. Public surface
Export `canonicalize` (and the error class) from the package root with a full docblock
(parity statement, every rejection code, the depth bound, the digest warning). Update
packages/canonical/README.md if it documents the surface. Direct-serializer tests run
against the ROOT export, not the internal path. Add a built-package test that requires the
CJS build and imports the ESM build of the root entry and calls canonicalize (see how
sibling packages test their dist; if none do, a small node --test script over the built
dist after `pnpm --filter @smthrs/canonical run build` is acceptable and must be wired into
the package's test script or a scripts/BUILD.ts target).

## 5. Test corpus
- RFC 8785 conformance: the RFC's number-serialization vectors (IEEE 754 edge doubles:
  0, -0, 1e21, 1e-7, 333333333.33333329, 9007199254740992, etc. per RFC 8785 section 3.2.2.3
  and its test data), sorting vectors (UTF-16 order incl. "10" before "2", empty key,
  unicode keys), and the canonical example document. Cite each vector's source in a comment.
- Property tests (extend Canonical.property.test.ts): for stringify-safe generated values,
  JSON.parse(canonicalize(x)) deep-equals JSON.parse(JSON.stringify(x)); canonicalize is
  idempotent through JSON.parse; keys always sorted; output always JSON.parse-able.
- Boundary sweep: inherited toJSON; toJSON returning function/symbol/bigint/undefined at
  top level, in arrays, as members; toJSON returning a string with a lone surrogate; NaN
  and -Infinity inside toJSON results; `__proto__` as an own key (JSON.parse round-trip);
  prototype-pollution keys (exists, keep); null-prototype objects; the empty string key;
  a key that is itself a lone surrogate.
Coverage thresholds stay at 100 across the board and must be met by MEANINGFUL cases, not
threshold chasing.

## 6. Gates before you finish
pnpm --filter @smthrs/canonical run check | test | lint (all exit 0); the consumer suites
(section header above); `node scripts/check-docs.mjs` and `pnpm run docs:llms` + check-llms
if any docs page or README changed (regenerate llms bundles); `node scripts/generate-known-files.mjs`
+ `pnpm exec smithers-build lint '//:knownFiles'` if any file was added (vendor/jj is
initialized in this worktree; run `git submodule update --init` if not). Commit in small
conventional commits on this branch. Write the final report to CANONICAL_REPORT.md in the
worktree root: digest-impact table, every red line quoted, every restated pin listed, the
Map/Set decision argument, gate outputs.
