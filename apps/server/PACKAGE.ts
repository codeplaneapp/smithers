import { Smithers as S } from "@smthrs/targets"

const srcs = S.Filegroup({
  srcs: S.glob(["src/**/*.ts", "scripts/**/*.ts"])
})

const check = S.Shell.Test({
  bin: S.PackageManager.bin,
  args: ["--filter", "smithers-server", "exec", "tsc", "-p", "tsconfig.json", "--noEmit"],
  data: [srcs, S.file("tsconfig.json")]
})

const unitTests = S.Shell.Test({
  bin: S.Host.bin("bun"),
  args: ["test", "apps/server/src", "apps/server/scripts"],
  data: [srcs],
  sandbox: { network: true }
})

const ci = S.Suite({ tests: [check, unitTests] })

export const Package = S.Package({
  targets: { srcs, check, unitTests, ci }
})
