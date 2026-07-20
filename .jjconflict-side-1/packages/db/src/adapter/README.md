# adapter/

Type sidecars and bounds constants for the `SmithersDb` adapter, one export per
file.

- Row shapes (`RunRow`, `AttemptRow`, `AlertRow`, `NodeRow`, `SignalRow`, …) and
  query option types (`EventHistoryQuery`, `SignalQuery`) describe what the
  adapter reads and writes.
- `DB_*` constants (max lengths, allowed status/severity lists) encode the
  bounds that the `assert*.js` validators in `src/` enforce on writes.
- `AlertSeverity` / `AlertStatus` are derived from the
  `DB_ALERT_ALLOWED_SEVERITIES` / `DB_ALERT_ALLOWED_STATUSES` arrays, so widening
  an enum means editing the constant array, not the type.
- `SmithersDb.js` is a re-export shim only — the adapter implementation lives in
  `../adapter.js`; the shim keeps the historical
  `@smithers-orchestrator/db/adapter` subpath stable.
- `index.js` is the barrel. Its `// @smithers-type-exports-begin/end` typedef
  block is tool-managed — never hand-edit it. It intentionally lists only the
  typedefs the tool emitted; `NodeDiffCacheRow.ts` is imported directly where
  needed (e.g. `../cache/nodeDiffCache.js`).
