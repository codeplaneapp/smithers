import { Smithers } from "@smthrs/targets"

const standard = Smithers.StandardPackage({ cwd: "packages/smthrs-deprecation" })

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = standard

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test }
})
