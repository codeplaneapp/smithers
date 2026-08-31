import { Smithers as S } from "@smthrs/targets"

const srcs = S.Filegroup({
  srcs: [S.glob("*.ts"), S.file("baseline.json")]
})

const suite = S.Shell.Test({
  bin: S.Host.bin("bun"),
  args: ["evals/agent/run.ts"],
  data: [srcs]
})

const types = S.Shell.Test({
  bin: S.NodeModule.Bin("typescript", "tsc"),
  args: ["-p", "evals/agent/tsconfig.json", "--noEmit", "--lib", "ES2024"],
  data: [srcs, S.file("tsconfig.json"), S.file("//tsconfig.base.json")]
})

const ci = S.Suite({ tests: [suite, types] })

export const Package = S.Package({
  targets: { srcs, suite, types, ci }
})
