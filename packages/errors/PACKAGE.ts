/** Standard package targets. */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  deps: [],
  cwd: "packages/errors"
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, fmt, lib, lint, test }
})
