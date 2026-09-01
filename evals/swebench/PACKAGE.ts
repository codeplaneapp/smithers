import { Smithers as S } from "@smthrs/targets"

const srcs = S.Filegroup({ srcs: [S.glob("*.ts")] })
const cwd = "evals/swebench"

const types = S.Shell.Test({
  bin: S.NodeModule.Bin("typescript", "tsc"),
  args: [
    "-p",
    "tsconfig.json",
    "--noEmit",
    "--lib",
    "ES2024,DOM"
  ],
  cwd,
  data: [srcs, S.file("tsconfig.json"), S.file("//tsconfig.base.json")]
})

const ci = S.Suite({ tests: [types] })

export const Package = S.Package({
  targets: { srcs, types, ci }
})
