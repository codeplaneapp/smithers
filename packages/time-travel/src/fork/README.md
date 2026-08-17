# fork/

Forking a run from a snapshot checkpoint.

- `forkRunEffect.js` copies a parent snapshot into a child run (new UUID at
  frame 0), patches durability metadata into `configJson`, and persists the
  snapshot + run + branch row in one transaction.
- `listBranchesEffect.js` / `getBranchInfoEffect.js` read the
  `_smithers_branches` rows back.
- `index.js` wraps the three Effects in Promise facades and re-exports the
  Effect variants — this is the public `time-travel/fork` surface; do not flip
  the Promise signatures.
- `_helpers.js` (`expandResetSet`) computes which snapshot node keys to reset
  on fork: **only the nodes the caller names**, never their downstream
  dependents (snapshot rows carry no dependency edges, and a fork may target an
  edited workflow whose edges differ). It is imported directly by
  `tests/rewindAuditHelpers.test.ts`, which pins that contract along with
  `tests/fork.test.js` — do not inline or rename it, and do not widen the reset
  set without changing both tests deliberately.

Dual write paths throughout: PostgreSQL goes through
`adapter.internalStorage.upsert`, SQLite through drizzle `onConflictDoUpdate`
against the tables in `../schema.js`.
