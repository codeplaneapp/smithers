import { Smithers } from "@smthrs/targets"

const standard = Smithers.StandardPackage({ cwd: "packages/smithers/mcp" })

const { check, circular, docs, fmt, lib, lint, test } = standard

export const Package = Smithers.Package({
  targets: { check, circular, docs, fmt, lib, lint, test }
})
