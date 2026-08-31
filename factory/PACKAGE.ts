import { Smithers as S } from "@smthrs/targets"

const srcs = S.Filegroup({
  srcs: S.glob(["flows/**/*.ts", "queue/**/*.md", "README.md"])
})

const test = S.Shell.Test({
  bin: S.Host.bin("bun"),
  args: ["test", "factory/flows/harness.test.ts"],
  data: [srcs, S.pnpmWorkspace("//pnpm-workspace.yaml")]
})

const ci = S.Suite({ tests: [test] })

export const Package = S.Package({
  targets: { srcs, test, ci }
})
