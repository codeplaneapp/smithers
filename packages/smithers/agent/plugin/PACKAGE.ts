import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  testData: ["test/fixtures/*.mjs", "test/fixtures/*.cjs"],
  cwd: "packages/smithers/agent/plugin"
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test }
})
