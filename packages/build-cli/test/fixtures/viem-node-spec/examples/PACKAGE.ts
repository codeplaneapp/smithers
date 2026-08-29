/// <reference path="../smithers.d.ts" />
import { Smithers as S } from "@smthrs/targets"
import { Package as src } from "../src/PACKAGE.js"

const srcs = S.Filegroup({
  srcs: S.glob(["**"]),
})

// Upstream CI does not cover the examples; knip ignores them. They should
// be covered: each example workspace type-checks against the local emit,
// so a breaking API change fails here before a user's tutorial does.
const check = S.Shell.Test({
  bin: S.PackageManager.bin,
  args: ["--filter", "./examples/*", "exec", "tsc", "--noEmit"],
  data: [srcs, src.build],
})

export const Package = S.Package({
  targets: { check, srcs },
})
