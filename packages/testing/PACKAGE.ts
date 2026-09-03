import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

const standard = Smithers.StandardPackage({ packageManager, cwd: "packages/testing" })

const { check, circular, docs, fmt, lib, lint, test } = standard

export const Package = Smithers.Package({
  targets: { check, circular, docs, fmt, lib, lint, test }
})
