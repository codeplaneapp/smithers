# devtools/

One type per file for the DevTools tree protocol:

- `DevToolsNodeType.ts` — the JSX-ish node kinds a tree node can be.
- `DevToolsNode.ts` — a tree node plus optional task metadata.
- `DevToolsSnapshot.ts` — the full tree at a frame/seq.
- `DevToolsDeltaOp.ts` / `DevToolsDelta.ts` — incremental tree operations.
- `DevToolsEvent.ts` — the `snapshot | delta` stream union.

Every payload carries a literal `version: 1` that must match
`DEVTOOLS_PROTOCOL_VERSION` in `../devtools.js` — bump them together.

These are type-only `.ts` sidecars: each is re-exported from `../index.ts`
(the tsup dts entry) and typedef'd in `../devtools.js` for JSDoc consumers.
Adding a type means touching both entries; the typedef block in `devtools.js`
is tool-managed (`@smithers-type-exports-begin/end`) — do not hand-edit it.
