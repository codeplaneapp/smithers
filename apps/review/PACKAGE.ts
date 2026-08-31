import { Smithers as S } from "@smthrs/targets"

const srcs = S.Filegroup({
  srcs: [
    ...S.glob([
      "src/**/*.ts",
      "action/src/**/*.ts",
      "bin/*.mjs",
      "tests/**/*.ts",
      "tests/**/fixtures/*"
    ]),
    S.file("action/action.yml"),
    S.file("alchemy.run.ts")
  ]
})

const check = S.Shell.Test({
  bin: S.PackageManager.bin,
  args: ["--filter", "@smthrs/review", "exec", "tsc", "-p", "tsconfig.json", "--noEmit"],
  data: [srcs, S.file("tsconfig.json")]
})

const checkTests = S.Shell.Test({
  bin: S.PackageManager.bin,
  args: ["--filter", "@smthrs/review", "exec", "tsc", "-p", "tsconfig.test.json", "--noEmit"],
  data: [srcs, S.file("tsconfig.json"), S.file("tsconfig.test.json")]
})

const unitTests = S.Shell.Test({
  bin: S.Host.bin("bun"),
  args: ["test", "apps/review/tests"],
  data: [srcs],
  sandbox: { network: true }
})

const ci = S.Suite({ tests: [check, checkTests, unitTests] })

export const Package = S.Package({
  targets: { srcs, check, checkTests, unitTests, ci }
})
