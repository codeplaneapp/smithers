import { Smithers as S } from "@smthrs/targets"

const srcs = S.Filegroup({
  srcs: [
    ...S.glob([
      "src/**/*.ts",
      "src/**/*.tsx",
      "src/**/*.css",
      "scripts/**/*.ts",
      "e2e/**/*.ts"
    ]),
    S.file("vite.config.ts"),
    S.file("tailwind.config.js"),
    S.file("postcss.config.js"),
    S.file("electrobun.config.ts"),
    S.file("hutch.config.ts"),
    S.file("playwright.config.ts")
  ]
})
const cwd = "apps/ui"

const check = S.Shell.Test({
  bin: S.PackageManager.bin,
  args: ["--filter", "smithers-ui", "run", "check"],
  cwd,
  data: [srcs, S.file("tsconfig.json")],
  sandbox: { network: true }
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
