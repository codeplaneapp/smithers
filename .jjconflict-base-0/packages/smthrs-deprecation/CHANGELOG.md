# smthrs

## [1.0.0-rc.0]

- The package becomes a migration notice. Importing it throws and names the
  `@smthrs/*` packages that replace it.
- Removed: the JSX authoring API, the React reconciler and renderer, the
  workflow components, `createSmithers`, `runWorkflow`, the `jsx-runtime` and
  `jsx-dev-runtime` exports, the MDX plugin, and the `smithers` binary. The
  binary is owned by `@smthrs/cli` at 1.0.
- The Node floor stays the repository floor, `>=22.19.0`. Release contract
  section 1 states that minimum as "every `packages/*/package.json`
  `engines.node`", and the published support matrix repeats it, so this
  manifest is one of the facts that claim is made of. Lowering the floor to
  reach an unmigrated 0.x project on older Node would need that contract
  amended first.
- The notice text and removal recipe are owned by
  `packages/smthrs-deprecation/docs/` and projected into the migration guide.
  `test/notice.test.ts` pins every copy to one string.
