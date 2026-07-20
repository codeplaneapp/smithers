# 🐛 memory: [medium] searchNotes passes raw query to FTS5 MATCH, crashing on ordinary text with FTS metacharacters

GitHub: https://github.com/smithersai/smithers/issues/712

_via ultracode (Opus multi-agent) review_

## Summary
`searchNotesEffect` feeds the caller's raw `query` into an FTS5 `MATCH`, so ordinary free-text containing FTS5 metacharacters (`:`, unbalanced `"`, leading `-`, `(`/`)`, bare `AND`/`OR`/`NOT`/`NEAR`) is parsed as an FTS *expression* and throws instead of matching.

## Location
- `packages/memory/src/store/MemoryStoreLive.js:576-578` — `WHERE _smithers_memory_notes_fts MATCH ${query} AND kind = ${kind}`

The `${query}` is a bound parameter (no SQL injection), but SQLite FTS5 still parses the bound value as a query expression; binding does not escape FTS syntax. There is no tokenization/quoting/escaping of the input anywhere in the function or callees.

## Failure scenario (reproduced against an fts5 table with the same schema)
- `searchNotes('user', 'status: done')` → throws `no such column: status`
- `searchNotes('user', 'timeout "error')` → throws `unterminated string`
- `searchNotes('user', 'retry OR')` → throws `fts5: syntax error near ""`

Each is caught and surfaced as a `DB_QUERY_FAILED` `SmithersError` rather than returning notes whose bodies contain those words. A bare word (`'workflow'`) works.

## Why it matters
`searchNotes` is a public store method whose whole purpose is free-text search over note bodies; callers naturally pass agent- or user-generated text. Perfectly ordinary queries turn a search into a hard error, making the feature unreliable. Existing tests only ever search single bare words (`'zebra'`, `'anything'`, `'x'` in `packages/memory/tests/notes.test.js`), so this path is uncovered.

## Fix
Sanitize before `MATCH` — e.g. split on whitespace and wrap each token in double quotes (escaping embedded quotes) to force literal-term matching — or explicitly document that callers must pass valid FTS5 syntax.
