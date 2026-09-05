import { Smithers } from "@smthrs/targets"

const cwd = "packages/repo-targets"
const sources = Smithers.glob("src/**/*.ts")
const check = Smithers.Typecheck({
  srcs: [sources, Smithers.glob("test/**/*.ts")],
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})
const test = Smithers.Vitest({
  tests: [Smithers.glob("test/**/*.test.ts")],
  sources: [sources],
  deps: [],
  config: Smithers.file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  cwd
})

export const Package = Smithers.Package({ targets: { check, test } })
