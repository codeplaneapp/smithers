# errors/

Error-code contracts for the gateway DevTools / node-output / node-diff /
jump-to-frame RPCs: runtime `as const` tuples in `index.js` plus a matching
string-union `.ts` sidecar per code family (`DevToolsErrorCode.ts`,
`NodeOutputErrorCode.ts`, `NodeDiffErrorCode.ts`, `JumpToFrameErrorCode.ts`).

MEMBER ORDER IS PART OF THE CONTRACT: `tests/protocol-contracts.test.js`
compares the tuple, the union, and the committed `../index.d.ts` declaration
with ordered equality — a reorder in one place that is not mirrored in the
others fails CI by design.

To add a code, append it in the same position to all three places:

1. the tuple in `index.js`,
2. the union in the sibling `.ts` file,
3. the committed `src/index.d.ts`.

The typedef block at the top of `index.js` is tool-managed
(`@smithers-type-exports-begin/end`) — do not hand-edit it.
