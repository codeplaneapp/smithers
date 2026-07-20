# timeline/

Derives a run's execution timeline from its snapshot and branch rows.

- `buildTimelineEffect.js` joins `listSnapshots` + `listBranches` into a flat
  `RunTimeline` (frames annotated with fork points).
- `buildTimelineTreeEffect.js` recurses into every forked child run to build a
  `TimelineTree`.
- `formatTimelineForTui.js` renders the tree with picocolors;
  `formatTimelineAsJson.js` is the structured equivalent.
- `index.js` exposes Promise facades over the two builders and re-exports the
  formatters.

The timeline is derived purely from snapshot + branch rows — rewind/revert
deleting snapshots prunes the timeline automatically.
