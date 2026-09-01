import { Smithers as S } from "@smthrs/targets"

const srcs = S.Filegroup({
  srcs: S.glob(["flows/**/*.ts", "queue/**/*.md", "README.md"])
})
const cwd = "factory"

const test = S.Shell.Test({
  bin: S.Host.bin("bun"),
  args: ["test", "flows/harness.test.ts"],
  cwd,
  data: [srcs, S.pnpmWorkspace("//pnpm-workspace.yaml")]
})

const ci = S.Suite({ tests: [test] })

export const Package = S.Package({
  targets: { srcs, test, ci }
})
