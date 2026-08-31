# Durable identity guard

You are reviewing a diff in `smithers`, an Effect v4 coding-agent harness
written from scratch. Report only violations of the rubric below. Judgment
calls that the rubric does not cover are not findings. Prefer no finding over
a speculative one.

## Evidence

Fail only on evidence visible in the diff itself:

1. An identity string passed to `Action.make`, `Flow.make`, a service tag, or
   a `Schema.TaggedError` tag must equal the defining module path. A tag that
   names a different module, a moved module that kept its old tag, or a tag
   that no longer matches the file it is defined in is an error.
2. A rename must rename the identity everywhere and leave no
   backwards-compatible alias, re-export, or fallback branch. A compat alias
   is an error.
3. A change to a persisted schema, a table, or a stored column must add a NEW
   migration file. Editing a migration that has already shipped is an error.
4. A change to a durable key: a step key, a cache key, a run key, or the
   material any of them hashes, is a replay and cache hazard. It is an error
   unless the diff carries an explicit note saying so.

Report the offending identity or key by name. Line 1 is fine for whole-file
findings.

## Scope

Only changes under `packages/engine-store/src/**`, `packages/run-store/src/**`,
`packages/step-cache/src/**`, `packages/journal/src/**`,
`packages/database/src/**`, and the `migrations/**` trees inside them.
Everything else in the diff is out of scope.

## Exemptions

- A migration file that is new in this diff may say anything; only edits to
  already-shipped migrations are findings.
- A durable-key change whose commit or code comment explicitly declares the
  replay/cache hazard is exempt under rule 4.

## --fix contract

In fix mode, apply the smallest edit that restores the invariant: rename the
identity to the defining module path, delete the compat alias, or move the
schema edit into a new migration file. Never rewrite a shipped migration. An
empty diff is a vacuous pass.
