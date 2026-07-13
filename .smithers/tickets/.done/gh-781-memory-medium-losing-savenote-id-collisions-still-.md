# 🐛 memory: [medium] losing saveNote ID collisions still add supersession edges

GitHub: https://github.com/smithersai/smithers/issues/781

_via 2026-07 full-codebase audit_

## Summary

saveNote documents same-ID collisions as an idempotent no-op, but only the note-row insert is ignored. Supersession edges from the losing request are still inserted.

## Where

- `packages/memory/src/store/MemoryStoreLive.js:439-467 — note insert uses onConflictDoNothing`
- `packages/memory/src/store/MemoryStoreLive.js:468-472 — requested supersession edges are inserted unconditionally`

## Failure scenario / repro

Save an existing note ID, then re-save that ID with a different body and supersedes:[victim]. The original body wins, but victim becomes hidden because the losing edge was persisted.

## Impact

Retries or concurrent losing writers can hide unrelated accepted knowledge even though their content/provenance did not win.

## Suggested fix

Insert side effects only when the note insert wins. On conflict, make the entire operation a no-op unless the persisted row and requested edge set are proven identical.

## Tests

- Re-save an existing ID with different supersedes and assert graph/visibility is unchanged
- Add a concurrent two-writer variant

## Dedupe notes

#533 and #712/#714 cover unrelated memory behavior.


> Closed by ticket-fleet: landed on main in f8b7bbf420404917971d67b689695248e6cf1d8d.
