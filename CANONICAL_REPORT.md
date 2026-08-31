# Canonical productionization report

## Result

`@smthrs/canonical` now exposes a digest-safe, iterative RFC 8785 serializer with stable located errors, JSON.stringify parity for supported inputs, explicit non-plain rejection, a 10,000-level bound, root-export and built-artifact coverage, and 100% statement/branch/function/line coverage.

Commits could not be created in this managed worktree. Git needs to create `/Users/williamcory/smithers/.git/worktrees/canonical-prod/index.lock`, but that Git directory is outside the writable sandbox. The attempted authored commit failed with `fatal: Unable to create .../index.lock: Operation not permitted`. All changes remain in the working tree for commit with `-c user.name="William Cory" -c user.email="willcory10@gmail.com"` once Git metadata is writable.

## Digest impact

| Decision | Previous result | New result | Digest consequence |
| --- | --- | --- | --- |
| `toJSON(key)` | Called without a key | Receives `""`, property key, or stringified array index | Key-sensitive `toJSON` values can produce different bytes. |
| Boxed Number/String/Boolean | Walked as objects (`{}` or index members) | Unboxed like JSON.stringify | All boxed primitive digests change to their primitive representation. |
| Boxed invalid numbers/BigInt | Could collapse to an object form | Stable rejection | No digest is emitted for invalid wrappers. |
| Sparse arrays | Could fail after producing invalid comma forms | Holes become `null` | Sparse-array bytes become valid JSON.stringify-compatible bytes. |
| Map/Set/WeakMap/WeakSet | Usually `{}` | Stable rejection naming the constructor | Populated and empty collections can no longer collide. |
| ArrayBuffer/typed arrays/RegExp/Error | `{}` or index-keyed object | Stable rejection naming the constructor | Host objects can no longer collide with plain objects. |
| Other non-plain instances | Enumerable-member object | Stable rejection naming the constructor | Class instances must be converted to plain JSON before digesting. |

Error-code/path improvements, deterministic depth rejection, getter/proxy cause wrapping, and the iterative traversal do not change bytes for previously supported values within the bound.

## Red-first evidence

The new direct contract suite was run before implementation:

> `Test Files  1 failed (1)`  
> `Tests  31 failed (31)`

After the first implementation, the two remaining red cases exposed traversal semantics:

> `Tests  2 failed | 29 passed (31)`  
> `expected [ '0', 'x' ] to deeply equal [ '', '0', 'x' ]`  
> `expected '{"a":1,"b":2}' to be '{"a":1}'`

The first whole-package run identified old pins that required explicit restatement:

> `Tests  27 failed | 113 passed (140)`

Coverage was then red until meaningful exception paths were added:

> `ERROR: Coverage for statements (99.32%) does not meet global threshold (100%)`

The consumer run found one old error-text pin:

> `Tests  1 failed | 231 passed (232)`  
> `Expected: "NaN is not allowed"`  
> `Received: "SchemaError(canonical_nan: NaN at $.input)"`

The flows conformance suite caught an incompatible package-script edit:

> `expected 'vitest && pnpm run test:dist' to be 'vitest'`

The built smoke was moved to `pretest`/`test:dist`, preserving the frozen `test: vitest` pin.

## Restated pins

- Top-level undefined/symbol/function: old generic `The value is not valid JSON`; now `canonical_unsupported_value` at `$`.
- NaN/Infinity: old unlocated prose; now `canonical_nan` or `canonical_non_finite` with exact value and path.
- Circular references: old unlocated prose; now `canonical_circular` at the re-entry path, including `.toJSON()`.
- Boxed Number/String: old `{}`/index-keyed behavior; now JSON.stringify-compatible primitive bytes.
- Uint8Array, Map, and Set: old collision-prone bytes; now constructor-named rejection.
- Recursion: old host `Maximum call stack size exceeded`; now deterministic `canonical_depth_exceeded` at 10,001.
- Sparse arrays: old schema failure from invalid output; now holes are `null`.
- Control consumer: old canonical prose assertions; now stable code and path assertions.

## Map/Set decision

Map, Set, WeakMap, WeakSet, ArrayBuffer, typed arrays, RegExp, Error, and other non-plain instances are rejected with `canonical_unsupported_value`. Strict JSON.stringify parity is unsafe here: populated Map/Set values stringify to `{}`, colliding with empty collections and plain empty objects, while typed arrays stringify like ordinary index-keyed objects. A digest library must not silently erase type-owned data. Date is the exception because its standard inherited `toJSON` produces an explicit ISO string.

## Gates

| Gate | Result |
| --- | --- |
| `pnpm --filter @smthrs/canonical run check` | PASS |
| `pnpm --filter @smthrs/canonical run test` | PASS: built CJS/ESM smoke plus 160 Vitest tests; 100% statements, branches, functions, lines |
| `pnpm --filter @smthrs/canonical run lint` | PASS |
| `node scripts/check-docs.mjs` | PASS |
| `pnpm run docs:llms` | PASS: 12 artifacts written, 0 changed |
| `node scripts/check-llms.mjs` | PASS: 12 artifacts current |
| `node scripts/generate-known-files.mjs` | PASS |
| `pnpm exec smithers-build lint '//:knownFiles'` | PASS |
| `@smthrs/targets` consumer | PASS: 769 tests |
| `@smthrs/step-cache` consumer | PASS: 75 tests, 100% coverage |
| `@smthrs/core` consumer | PASS: 104 tests |
| `@smthrs/control` consumer | PASS: 232 tests |
| `@smthrs/keys` consumer | PASS: 25 tests |
| `@smthrs/flows` consumer | BLOCKED: 386 passed; 16 process-host tests fail because `uv_uptime` returns EPERM. The relevant CI-conformance file passes all 264 tests with coverage disabled for the focused run. |
| `@smthrs/build-cli` consumer | BLOCKED: 760 passed, 1 skipped; 60 process/Docker/sandbox tests fail because nested `sandbox-exec`, sysmon, pgrep, Docker state, and host operations are forbidden. |
| `smithers-ui` consumer | BLOCKED: 1,208 passed; 18 target-graph integration tests fail because nested `sandbox-exec` returns operation-not-permitted. |

The blocked consumer failures are host-sandbox failures, not canonical output or assertion failures. The environment also prevents the requested Git commits, as noted above.
