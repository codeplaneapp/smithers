import { Smithers as S } from "@smthrs/targets"

const srcs = S.Filegroup({
  srcs: [
    ...S.glob(["src/**/*.ts", "tests/**/*.ts"]),
    S.file("alchemy.run.ts")
  ]
})
const cwd = "apps/bug-worker"

const check = S.Shell.Test({
  bin: S.PackageManager.bin,
  args: ["--filter", "@smthrs/bug-worker", "exec", "tsc", "-p", "tsconfig.json", "--noEmit"],
  cwd,
  data: [srcs, S.file("tsconfig.json")]
})

const unitTests = S.Shell.Test({
  bin: S.Host.bin("bun"),
  args: ["test", "tests"],
  cwd,
  data: [srcs],
  sandbox: { network: true }
})

const ci = S.Suite({ tests: [check, unitTests] })

export const Package = S.Package({
  targets: { srcs, check, unitTests, ci }
})
