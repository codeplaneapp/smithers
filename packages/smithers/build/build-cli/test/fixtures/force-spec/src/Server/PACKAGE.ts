/// <reference path="../../smithers.d.ts" />
import { Smithers as S } from "@smthrs/targets"

const srcs = S.Filegroup({
  srcs: S.glob(["**"]),
})

const test = S.Shell.Test({
  bin: S.NodeModule.Bin("jest"),
  args: ["--config", "jest.config.js", "src/Server"],
  data: [
    S.ImportClosure({ entries: srcs }),
    S.file("//jest.config.js"),
    S.file("//jest.envSetup.ts"),
    S.file("//tsconfig.json"),
  ],
})

export const Package = S.Package({
  targets: { srcs, test },
})
