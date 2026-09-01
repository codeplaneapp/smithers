import { Smithers as S } from "@smthrs/targets"

const srcs = S.Filegroup({ srcs: S.glob(["src/**/*.ts", "src/**/*.tsx"]) })
const tests = S.Filegroup({ srcs: S.glob(["tests/**/*.ts", "tests/**/*.tsx"]) })
const cwd = "packages/ui"

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
