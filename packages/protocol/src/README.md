# @smithers-orchestrator/protocol — src

Zero-dependency Smithers wire contracts: the DevTools tree protocol types and
the gateway error-code tuples/unions consumed by `packages/server` and
`packages/pi-plugin`.

Layout:

- `index.js` — the runtime entry (values only, re-exports from `devtools.js`
  and `errors/index.js`).
- `index.ts` — the TYPE entry. It looks like a duplicate of `index.js`, but it
  is the tsup dts entry (`tsup.config.ts` → `dts: { only: true }`,
  `outDir: "src"`) that produces the committed `src/index.d.ts`. Keep the two
  entries in sync; never delete or move `index.ts`.
- `devtools.js` — `DEVTOOLS_PROTOCOL_VERSION` plus JSDoc typedefs for the
  devtools types.
- `devtools/`, `errors/` — one type per file (see their READMEs).

Gotchas:

- The `// @smithers-type-exports-begin/end` blocks in `devtools.js` and
  `errors/index.js` are tool-managed — never hand-edit them.
- Error codes are triple-maintained in identical member order (the
  `errors/index.js` tuples, the `errors/*.ts` unions, and the committed
  `index.d.ts`); `tests/protocol-contracts.test.js` fails on any drift,
  including a reorder.
