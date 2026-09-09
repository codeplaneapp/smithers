import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd: "packages/smithers/agent/fs"
})

// The manifest augments Route's types, so it needs its own compilation.
const checkTypes = Smithers.Typecheck({
  srcs: [
    Smithers.glob("src/**/*.ts"),
    Smithers.glob("type-tests/**/*.ts"),
    Smithers.file("tsconfig.json"),
    Smithers.file("tsconfig.test.json")
  ],
  deps: [lib],
  tsconfig: Smithers.file("tsconfig.types.json"),
  buildMode: false,
  incremental: false,
  cwd: "packages/smithers/agent/fs"
})

export const Package = Smithers.Package({
  targets: { check, checkTypes, circular, docs, docsFiles, fmt, lib, lint, test }
})
