# smthrs

## [1.0.0-rc.0]

- The package becomes a migration notice. Importing it throws and names the
  `@smthrs/*` packages that replace it.
- Removed: the JSX authoring API, the React reconciler and renderer, the
  workflow components, `createSmithers`, `runWorkflow`, the `jsx-runtime` and
  `jsx-dev-runtime` exports, the MDX plugin, and the `smithers` binary. The
  binary is owned by `@smthrs/cli` at 1.0.
- The Node floor is deliberately `>=14`, not the repository's `>=22.19.0`.
  This package never runs the durable engine, and an `engine-strict` install on
  the Node version an unmigrated 0.x project uses today would replace the
  migration notice with an `EBADENGINE` complaint.
- The notice text and removal recipe are owned by
  `packages/smthrs-deprecation/docs/` and projected into the migration guide.
  `test/notice.test.ts` pins every copy to one string.
