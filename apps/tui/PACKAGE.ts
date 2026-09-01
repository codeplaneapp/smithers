import { Smithers as S } from "@smthrs/targets"

const srcs = S.Filegroup({
  srcs: S.glob(["src/**/*.ts", "src/**/*.tsx", "scripts/**/*.ts"])
})
const cwd = "apps/tui"

const check = S.Shell.Test({
  bin: S.PackageManager.bin,
  args: ["--filter", "smithers-tui", "exec", "tsc", "-p", "tsconfig.json", "--noEmit"],
  cwd,
  data: [srcs, S.file("tsconfig.json")]
})

const unitTests = S.Shell.Test({
  bin: S.Host.bin("bun"),
  args: ["test", "src"],
  cwd,
  data: [srcs],
  sandbox: { network: true }
})

const ci = S.Suite({ tests: [check, unitTests] })

export const Package = S.Package({
  targets: { srcs, check, unitTests, ci }
})
