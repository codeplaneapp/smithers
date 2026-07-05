# snapshot/

Capturing and reading run snapshots (the fork/replay/timeline source of truth).

- `captureSnapshotEffect.js` serializes nodes/outputs/ralph/input, sha256s them
  into `contentHash`, and upserts a `_smithers_snapshots` row keyed
  `(run_id, frame_no)`.
- `loadSnapshotEffect.js` / `listSnapshotsEffect.js` read rows back (exact
  frame, latest, or all frames for a run).
- `parseSnapshot.js` converts a raw row into a `ParsedSnapshot` (nodes keyed
  `nodeId::iteration`, ralph keyed `ralphId`); `parseSnapshotJson.js` turns
  malformed JSON columns into a `SmithersError` instead of a raw `SyntaxError`.
- `index.js` is the Promise facade over the Effects plus the `parseSnapshot`
  re-export; the `@smithers-type-exports` block there is tool-managed.

Same PostgreSQL (`internalStorage.upsert`) vs SQLite (drizzle
`onConflictDoUpdate`) dual write path convention as `../fork/`.
