# @smthrs/plan

## [1.0.0-rc.0] - 2026-08-31

### Added

- The persisted plan: `Plan` (compile, append, conflict annotation),
  `PlanStore` (append-only SQL, migration block `4000`), `PlanDiff`, and the
  `KeyMaterial` to `StepKey` compiler revived from the module deleted at
  `f5f3dda`, now producing `@smthrs/keys` `Key` values rather than a second
  digest format.
- Added `Node.priority`, which attaches a scheduling priority to a node, and
  `Node.declaredPriority`, which reads one back. The value is a plain JSON
  field on the AST rather than a `Context` annotation, so a stored plan keeps
  it. `Plan.compile` copies it from `NodeDraft.priority` onto the plan node and
  folds it into the plan digest a human approves; it never enters a node's key
  material, so raising a priority reorders work without re-keying a step. A
  priority that is not a safe integer is a `GraphBuildError` with the new
  `invalid_priority` code.
- Added package-owned documentation. `packages/plan/docs` and the public JSDoc
  in `src` are the single source for the published API page.

### Breaking Changes

- Plan approval digests now include each node's conflict and runtime
  strategies. This moves plan digests without moving step keys. A running run
  pinned to the old digest needs a new approval before it can use the changed
  plan.
- A node payload is now cloned as its JSON mirror, so a payload carrying a
  `toJSON`, such as a `Date` or a `URL`, keys as the value it serializes to
  rather than as an empty object. Payloads of that shape re-key once.
- A flow call's `KeyMaterial.body` no longer has a body-less shape. `Flow.make`
  requires `body`, so `@smthrs/flow` never records `declaration.body:
  undefined` for a call whose declaration survived beside its AST.
  `StepKey.content` therefore folds a body digest into every such node, and the
  keys `Plan.compile` derives for the flow calls that previously carried none
  move with it.
- `StepKey.EnvironmentIdentity` is now a discriminated union. A declared
  environment may not carry a `runScope` and an undeclared one must, which
  `StepKey.dispatchIdentity` also enforces at run time with the new
  `invalid_environment` code.

### Fixed

- `PlanStore.append` now advances the stored plan row with a compare-and-swap
  on the previous generation, so appending a skipped generation is refused
  instead of persisting node rows whose dependencies are missing and which the
  append-only triggers then forbid removing. Node ordinals are derived from the
  store rather than from the caller's array, `PlanStore.record` refuses
  anything that is not generation 0, and an append with no new nodes is
  refused rather than advancing the generation for nothing.
- A node payload no longer keeps live functions, and different `Date`, `URL`
  or other `toJSON` payloads no longer share one step key.
- `StepKey.fromKeyMaterial` resolves dependency digests as own properties, so a
  dependency named `toString` or `constructor` is a `missing_dependency`
  refusal rather than a colliding key.
- A `StepKey.DigestMemo` waiter no longer inherits the leader's interruption;
  it recomputes its own digest instead.
- `StepKey.project` resolves only own data properties, so a projection path
  through `toString`, `constructor` or `__proto__` yields `undefined` as
  documented and no getter runs during key derivation.
- The conflict pass now decides orderedness against the live edge set, so a
  writer pair a dependency path already orders is neither annotated, nor given
  a redundant edge, nor refused with `overlap_forbidden`.
- `Plan.compile` no longer recurses per dependency edge and no longer
  materializes a transitive closure, so a large graph compiles in bounded
  memory instead of raising an untyped `RangeError`.
- `Plan.compile` and `Plan.append` validate drafts before keying, with the new
  `invalid_node` code, so an empty plan id, an unsafe-integer priority, or a
  key material version this release does not know is refused at the plan rather
  than at the store.
- `PlanDiff` attributes a key move caused by `nondeterministic` or `placement`,
  and `Node.capture` refuses a capture nested past its documented limit with a
  path-bearing error rather than overflowing the stack.
- Filesystem declarations containing C0 controls or DEL are now rejected as
  `invalid_effects` during planning instead of reaching a host filesystem, and
  path comparison is Unicode NFC normalized, so two spellings of one name are
  detected as an overlap.
- `Planned.reference` validates the reference shape, so a forged carrier can no
  longer inject a fabricated projection path into a payload.
- Compiled and appended plans now keep the exact material and filesystem
  authority that their keys and approval digest cover, even if caller-owned
  draft objects are later mutated.
- Persisted plans can no longer be deleted or have their flow and creation time
  rewritten, and node order is now unique and deterministic within each plan.
