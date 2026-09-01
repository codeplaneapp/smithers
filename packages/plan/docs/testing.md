The package-owned [`@smthrs/plan` suite](/api/plan) pins the step-key compiler
and its collision cases: prototype-named dependencies, forged digest inputs,
projected values resolved as own data properties only, adversarial projection
corpora, and a memo whose leader is interrupted while a waiter is parked on it.
Payload tests prove the authoring AST is a JSON mirror, so distinct `Date` and
`URL` payloads never share a key, no function survives into a stored plan, and
a `toJSON` returning its own receiver refuses on both the clone and the input
rather than keying as an empty object. Plan tests cover topological order,
conflict annotation and the ordering edges it infers, reader-after-writer
edges, append across generations, diff attribution for every hashed field,
draft validation, and bounded-resource compilation of a large chain in both
declaration orders. Immutability is pinned by mutating the caller's `Date`,
`URL`, and custom-`toJSON` objects after compiling and asserting the stored
material and the plan digest do not move, and by proving an effect edit re-keys
its node instead of moving the approval digest silently. The store suite runs
real SQLite: append-only triggers including the plan-id pin, compare-and-swap
on the plan generation, the persisted-prefix check that rolls back an append
grown from a divergent branch, ordinal uniqueness, and every refusal code.
Property suites cover file-set globbing, overlap, and Unicode normalization.
