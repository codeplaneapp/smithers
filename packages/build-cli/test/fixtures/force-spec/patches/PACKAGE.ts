/// <reference path="../smithers.d.ts" />
import { Smithers as S } from "@smthrs/targets"

const patches = S.Filegroup({
  srcs: S.glob(["**"]),
})

const prepare = S.Shell.Run({
  bin: S.NodeModule.Bin("patch-package"),
  data: [patches],
})

export const Package = S.Package({
  targets: { patches, prepare },
})
