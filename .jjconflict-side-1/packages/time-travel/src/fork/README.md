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
  on fork. It is imported directly by `tests/rewindAuditHelpers.test.ts`, so
  its behavior is pinned — do not inline or rename it.

Dual write paths throughout: PostgreSQL goes through
`adapter.internalStorage.upsert`, SQLite through drizzle `onConflictDoUpdate`
against the tables in `../schema.js`.
