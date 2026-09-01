The package-owned [`@smthrs/plan` suite](/api/plan) pins the step-key compiler
and its collision cases: prototype-named dependencies, forged digest inputs,
projected values resolved as own data properties only, adversarial projection
corpora, and a memo whose leader is interrupted while a waiter is parked on it.
Payload tests prove the authoring AST is a JSON mirror, so distinct `Date` and
`URL` payloads never share a key and no function survives into a stored plan.
Plan tests cover topological order, conflict annotation and the ordering edges
it infers, reader-after-writer edges, append across generations, diff
attribution for every hashed field, draft validation, immutability of a
compiled plan, and bounded-resource compilation of a large chain in both
declaration orders. The store suite runs real SQLite: append-only triggers,
compare-and-swap on the plan generation, ordinal uniqueness, and every refusal
code. Property suites cover file-set globbing, overlap, and Unicode
normalization.
