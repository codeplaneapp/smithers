# delegation/

The `<DelegationChain>` composite and its phase components — the recursive
delegation-chain workflow (spec: simulations/delegation-chain.md). The chain
runs GoalRefinement → DelegationPlanning → DelegationPreview →
BackpressurePlanning → DeriskLoop → DelegationExecution → DelegationScoring
in a Sequence, wrapped in a Parallel with DelegationEditListener.

Key files:

- `delegationSchemas.ts` — single source of truth for every `dc*` output-row
  shape.
- `delegationState.js` — pure render-time fold helpers. Deliberately
  non-React and exported for direct unit testing
  (tests/delegation-components.test.jsx imports them); do not inline them
  into their single call sites.
- `delegationPrompts.js` — all tier/phase prompt text. Lives in-package
  because seeded workflow packs cannot import `.smithers/prompts`.
- `withCommitRange.js` — wraps exec agents with best-effort jj/git
  commit-range capture merged into the dcExec row.

Gotchas:

- Physical node ids are `<idPrefix>:<logicalId>:<phase>` with `/` in the
  logical id encoded as `:` (see `physicalId`). The `smithers ui` delegation
  fold (gateway-react's foldDelegation) only recognizes the default `"dc"`
  prefix.
- Everything re-derives its slice of the tree from `dc*` rows on each render
  (reactive fan-out): plan rows append and later rows supersede, so replans
  and user edits reshape the tree without restarting the run.
