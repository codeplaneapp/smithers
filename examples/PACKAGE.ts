import { Smithers as S } from "@smthrs/targets"

const srcs = S.Filegroup({
  srcs: S.glob(["src/**/*.ts", "src/**/*.mdx"])
})

const tests = S.Filegroup({ srcs: [S.glob("test/**/*.ts")] })
const cwd = "examples"

const check = S.Shell.Test({
  bin: S.NodeModule.Bin("typescript", "tsc"),
  args: ["-p", "tsconfig.json", "--noEmit"],
  cwd,
  data: [srcs, tests, S.file("tsconfig.json")]
})

const suite = S.Shell.Test({
  bin: S.PackageManager.bin,
  args: ["--filter", "@smthrs/examples", "exec", "vitest", "run"],
  cwd,
  data: [srcs, tests, S.file("vitest.config.ts")],
  sandbox: { network: true }
})

const ci = S.Suite({ tests: [check, suite] })

export const Package = S.Package({
  targets: { srcs, tests, check, suite, ci }
})
