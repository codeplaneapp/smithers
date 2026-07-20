# frame-codec/

Delta codec for persisted workflow frames (`_smithers_frames.xml_json`).

- `encodeFrameDelta` diffs two canonical XML-JSON snapshots into path-based
  set/insert/remove ops; `applyFrameDelta` / `applyFrameDeltaJson` replay them.
- `parseFrameDelta` / `serializeFrameDelta` handle the JSON wire form.
- `FRAME_KEYFRAME_INTERVAL` (50) is how often a full keyframe is written between
  deltas; `normalizeFrameEncoding` maps unknown/legacy `encoding` column values
  to `"full"`.
- Ops carry an optional `nodeId` inferred from an element's `props.id`, so
  consumers can attribute changes to workflow nodes.
- `FRAME_DELTA_VERSION` is intentionally duplicated in `encodeFrameDelta.js` and
  `parseFrameDelta.js` and must stay in lockstep — parse rejects any other
  version. The small `isRecord`/clone helpers are likewise deliberately
  duplicated per file rather than shared (a new `src/` module would become
  public API via the package's `"./*"` export).
- `../frame-codec.js` (sibling file, separate ownership) is the public re-export
  surface for this directory.
