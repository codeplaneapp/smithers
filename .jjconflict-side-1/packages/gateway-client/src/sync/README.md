# sync/

The row/tree vocabulary shared by the data collections and UIs. Most files are
`Gateway*Row` types mirroring gateway RPC responses, each documenting field
provenance against the server tables/handlers.

Tree pipeline: `snapshotToGatewayRunNode` maps a `getDevToolsSnapshot` payload
to a nested `GatewayRunNode` tree (null for the empty-root sentinel) →
`flattenGatewayRunNode` walks it into flat `parentId`/`childIds` rows →
`reconcileSnapshotNodes` diffs previous vs next rows into
insert/update/delete writes (`withoutVirtualFields` normalizes the previous
row before the deepEquals comparison).

Identity rule: `GatewayRunNode.key` (via `runNodeKey`) is the unique
structural row key; the logical `id` (+ `iteration`) is what
`getNodeOutput`/`getNodeDiff`/approval RPCs speak. `parentId`/`childIds` link
by key, never by id — keying by id would collapse loop/retry attempts into one
row.

Gotcha: every file here is a public npm subpath via the package's `./*`
export — never move, rename, or delete a module.
