/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  deps: [],
  cwd: "packages/smithers/agent/memory"
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, fmt, lib, lint, test }
})
