# snapshot/

Capturing and reading run snapshots (the fork/replay/timeline source of truth).

- `captureSnapshotEffect.js` serializes nodes/outputs/ralph/input, sha256s them
  into `contentHash`, writes the raw fields once in
  `_smithers_snapshot_contents`, and atomically upserts compact snapshot
  metadata plus `_smithers_snapshot_payload_refs`.
- `loadSnapshotEffect.js` joins metadata/reference/content in one statement for
  exact/latest reads; `listSnapshotsEffect.js` reads the lightweight metadata
  index.
- The exported `smithersSnapshots` Drizzle object maps the physical metadata
  table. New compact rows intentionally expose empty JSON marker fields there;
  consumers that need full state must use `loadSnapshot`/`loadLatestSnapshot`.
  Direct inline writes remain supported for compatibility.
- `parseSnapshot.js` converts a raw row into a `ParsedSnapshot` (nodes keyed
  `nodeId::iteration`, ralph keyed `ralphId`); `parseSnapshotJson.js` turns
  malformed JSON columns into a `SmithersError` instead of a raw `SyntaxError`.
- `index.js` is the Promise facade over the Effects plus the `parseSnapshot`
  re-export; the `@smithers-type-exports` block there is tool-managed.

Lifecycle triggers keep reference counts correct for replacement, rewind, and
direct deletion on SQLite and PostgreSQL. Legacy inline rows remain readable;
an unreleased local gzip prototype is hydrated only through its compatibility
branch.
