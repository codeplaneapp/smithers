# smthrs

## [1.0.0-rc.0]

- The package becomes a migration notice. Importing it throws and names the
  `@smthrs/*` packages that replace it.
- Removed: the JSX authoring API, the React reconciler and renderer, the
  workflow components, `createSmithers`, `runWorkflow`, the `jsx-runtime` and
  `jsx-dev-runtime` exports, the MDX plugin, and the `smithers` binary. The
  binary is owned by `@smthrs/cli` at 1.0.
