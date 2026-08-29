# @smthrs/plan

## [Unreleased]

### Breaking Changes

- A flow call's `KeyMaterial.body` no longer has a body-less shape. `Flow.make`
  requires `body` under `docs/specs/Concepts/Unified Flow Authoring.md`, so
  `@smthrs/flow` never records `declaration.body: undefined` for a call whose
  declaration survived beside its AST. `StepKey.content` therefore folds a body
  digest into every such node, and the keys `Plan.compile` derives for the flow
  calls that previously carried none move with it.

### Added

- The persisted plan: `Plan` (compile, append, conflict annotation),
  `PlanStore` (append-only SQL, migration block `4000`), `PlanDiff`, and the
  `KeyMaterial` → `StepKey` compiler revived from the module deleted at
  `f5f3dda` — now producing `@smthrs/keys` `Key` values rather than a second
  digest format.
- Added `Node.priority`, which attaches a scheduling priority to a node, and
  `Node.declaredPriority`, which reads one back. The value is a plain JSON
  field on the AST rather than a `Context` annotation, so a stored plan keeps
  it. `Plan.compile` copies it from `NodeDraft.priority` onto the plan node and
  folds it into the plan digest a human approves; it never enters a node's key
  material, so raising a priority reorders work without re-keying a step. A
  priority that is not a safe integer is a `GraphBuildError` with the new
  `invalid_priority` code.
