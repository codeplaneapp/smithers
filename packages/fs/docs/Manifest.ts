/** Documentation surfaces owned by the private `@smthrs/fs` package. */
export const Manifest = {
  name: "@smthrs/fs",
  generator: "packages/fs/scripts/docs.mjs",
  readme: {
    source: "docs/README.md",
    target: "packages/fs/README.md"
  },
  exports: {
    target: "packages/fs/docs/exports.md"
  },
  modules: [
    { namespace: "Command", source: "src/Command.ts", specifier: "@smthrs/fs/Command" },
    { namespace: "CommandTree", source: "src/CommandTree.ts", specifier: "@smthrs/fs/CommandTree" },
    { namespace: "Directive", source: "src/Directive.ts", specifier: "@smthrs/fs/Directive" },
    { namespace: "FileRouter", source: "src/FileRouter.ts", specifier: "@smthrs/fs/FileRouter" },
    { namespace: "FlowInvoker", source: "src/FlowInvoker.ts", specifier: "@smthrs/fs/FlowInvoker" },
    { namespace: "FsError", source: "src/FsError.ts", specifier: "@smthrs/fs/FsError" },
    { namespace: "Incur", source: "src/Incur.ts", specifier: "@smthrs/fs/Incur" },
    { namespace: "Route", source: "src/Route.ts", specifier: "@smthrs/fs/Route" }
  ],
  fragments: [
    "packages/fs/docs/README.md",
    "packages/fs/docs/api.md",
    "packages/fs/docs/contract.md"
  ]
} as const
