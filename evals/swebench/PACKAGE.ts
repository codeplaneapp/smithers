import { Smithers as S } from "@smthrs/targets"

const srcs = S.Filegroup({ srcs: [S.glob("*.ts")] })

const types = S.Shell.Test({
  bin: S.NodeModule.Bin("typescript", "tsc"),
  args: [
    "-p",
    "evals/swebench/tsconfig.json",
    "--noEmit",
    "--lib",
    "ES2024,DOM"
  ],
  data: [srcs, S.file("tsconfig.json"), S.file("//tsconfig.base.json")]
})

const ci = S.Suite({ tests: [types] })

export const Package = S.Package({
  targets: { srcs, types, ci }
})
