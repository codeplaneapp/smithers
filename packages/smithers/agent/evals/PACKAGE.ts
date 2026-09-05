import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
import { Smithers } from "@smthrs/targets"

const standard = BuildAndCheckTypeScriptPackage({ cwd: "packages/smithers/agent/evals" })

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = standard

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test }
})
