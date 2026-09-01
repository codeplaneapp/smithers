# @smthrs/chain

## [Unreleased]

## 0.1.0

The version the manifest has carried since the package moved into
`packages/`. Everything below shipped under it.

### Breaking Changes

- Renamed the package to `@smthrs/chain`, the scope every unreleased
  Smithers package carries.
- `Outcome.to` re-derives the successor's digest from its text and discards
  whatever the caller passed, and `Chain.run` journals the re-derived script.
  A script chooses the text it hands on, never the replay identity that text
  is keyed by. A caller that relied on passing a digest through unchanged now
  gets the digest of the text.
- `Catalog.withSystem` appends the system entries instead of prepending
  them, matching `RegistryCatalog.make` and `SubChains.make`. Because
  `Catalog.make` indexes last-wins, a host entry named `sys/now` or
  `sys/random` no longer shadows the journaled clock and generator that
  replay determinism rests on. The advertised order of the catalog block
  changes with it.
- Both runner bindings now put the script's OUTCOME through the same JSON
  boundary as a call payload. `done(NaN)`, `done(Infinity)`, a function or
  `undefined` property, and a `toJSON` hook were silently rewritten by the
  QuickJS binding's own `JSON.stringify` and are now a typed
  `invalid_outcome` in both runners.
- `Prompt.catalogBlock` truncates entry names at `Prompt.maxEntryName` (64)
  and descriptions at `Prompt.maxEntryDescription` (200), strips backticks,
  and drops a leading list or heading marker.

### Added

- `QuickJsRunner`: the production sealed interpreter. A fresh QuickJS-WASM
  realm per link, no host globals, `Date` and `Math.random` deleted, and
  `ctx.call` as the only bridge.
- `Authorize`: gate 4, the per-call authorization seam, with `layerRules`,
  `layerAllowAll`, and `layerNoop`.
- `SubChains`: sub-agents as one ordinary catalog entry, running a nested
  chain in the same journal under a derived child id.
- `Steering`: the root chain's inbound instruction channel, drained at a
  link and ordinal boundary and journaled.
- `MemoryEntries` and `RegistryCatalog`: durable memory and
  repository-discovered flows as catalog entries.
- `AuthorDeclaration` is exported from the barrel, and
  `Chain.authorCapability` re-exports the model seat's claim, so an operator
  can write a policy rule against it without hardcoding the string.
- `QuickJsRunner.Limits.stackBytes`, defaulting to `stackCeiling`
  (256 KiB).
- `ScriptRunner.maxJsonDepth` (128) and `ScriptRunner.maxJsonSize` (8 MiB).

### Fixed

- A QuickJS realm with no stack limit let deep recursion exhaust the HOST
  WebAssembly stack: `evalCode` threw an error the realm could not catch and
  disposal aborted the module, escaping `Chain.run` as an untyped defect
  that journaled nothing, so the resumed link replayed the same script and
  died the same way forever. The realm now carries a 256 KiB stack limit and
  raises its own catchable `stack overflow`; disposal is best-effort; and
  any remaining defect degrades to a journaled `runtime` script failure.
- `Authorize.layerRules` re-implemented permission evaluation with
  `Capability.subsumes`, which is documented to answer `false` for
  relationships it cannot prove. A single-`*` deny degraded to an approval
  prompt and a single-`*` allow parked forever. A claim naming one exact
  capability is now decided by `@smthrs/capability`'s own
  `Permission.evaluate`; a claim naming a set keeps the pattern path, where
  an `allow` must prove coverage and a `deny` fires unless it is provably
  disjoint.
- `ScriptRunner.jsonBoundary` validated one read of a value and then
  serialized a second, so an accessor that changed its answer between reads
  smuggled an unvalidated subtree across, and a throwing accessor, a
  throwing proxy trap, a cycle introduced on the second read, or a deeply
  nested value escaped as an untyped defect. The walk now builds the copy as
  it validates, reads every property exactly once, and refuses instead of
  throwing.
- `Chain.run` re-derived `expectedPosition` from a fresh read before every
  append, so the journal's compare-and-swap could not detect the condition
  it exists for: two concurrent runs both reported `Done`, settled one call
  ordinal twice, and journaled two `LinkEnded` events for one link. A run
  now tracks the events in its own chain scope and fails with
  `journal_conflict` when another writer advances it, while a sub-chain
  writing its own scope still appends freely.
- `Catalog.make`, `Journal.layerMemory`, and `Steering.layerMemory` retained
  the caller's array by reference. They copy it now, so a later mutation
  cannot move the advertised catalog away from the dispatched one.
- The QuickJS bridge's host-side `JSON.stringify` could throw inside a
  synchronous realm callback. It settles a refusal instead.

### Changed

- Promoted the package out of `apps/mvp/vendor/smthrs/chain` into
  `packages/chain` as a first-class workspace member: real workspace
  dependency specifiers in place of the vendored `file:` and `*` references,
  `effect` moved from `4.0.0-beta.102` to the workspace pin `4.0.0-rc.108`,
  and the sibling `tsconfig.json`, `tsconfig.test.json`, `eslint.config.js`,
  `dprint.json`, `vitest.config.ts`, and build scripts restored.
- Rewrote the import specifiers `smthrs/capability` used to carry to the
  scoped `@smthrs/capability`.
- The package owns its documentation. `docs/api.md` and `docs/contract.md`
  replace the `docs/specs/Concepts/` directory that nineteen modules cited
  as their governing design and that never came across with the package;
  `test/Docs.test.ts` fails when a namespace, a default, or a citation
  drifts from them.
- `ScriptRunner.layerInProcess` is documented as providing NO isolation. It
  builds the script body in global scope, where `globalThis`, `process`, and
  dynamic `import()` are reachable; `QuickJsRunner.layer()` is the only
  sandbox for model-authored scripts.
- `Chain.Options.envelope` is documented as what it is: opaque run identity
  pinned into `ChainStarted` and compared on resume, journaled verbatim and
  never a policy input.

## 0.0.0

- Initial slice: journal event vocabulary, call keys, trampoline outcomes,
  in-memory journal, catalog, mock author seat, in-process script runner,
  and the chain trampoline with gates 1–3 and prefix replay.
