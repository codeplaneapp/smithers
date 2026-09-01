import { Smithers as S } from "@smthrs/targets"

const srcs = S.Filegroup({ srcs: [S.glob("src/**/*.ts")] })
const tests = S.Filegroup({ srcs: [S.glob("tests/**/*.ts")] })
const cwd = "packages/ui-styleguide"

const unitTests = S.Shell.Test({
  bin: S.Host.bin("bun"),
  args: ["test", "tests"],
  cwd,
  data: [srcs, tests]
})

const ci = S.Suite({ tests: [unitTests] })

export const Package = S.Package({
  targets: { srcs, tests, unitTests, ci }
})
