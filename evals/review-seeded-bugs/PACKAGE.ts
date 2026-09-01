import { Smithers as S } from "@smthrs/targets"

const srcs = S.Filegroup({
  srcs: [
    ...S.glob(["*.ts", "corpus/**/*"]),
    S.file("baseline.json")
  ]
})
const cwd = "evals/review-seeded-bugs"

const suite = S.Shell.Test({
  bin: S.Host.bin("bun"),
  args: ["run.ts"],
  cwd,
  data: [srcs]
})

const scorer = S.Shell.Test({
  bin: S.Host.bin("bun"),
  args: [
    "test",
    "score.test.ts",
    "deterministicReviewer.test.ts"
  ],
  cwd,
  data: [srcs]
})

const types = S.Shell.Test({
  bin: S.NodeModule.Bin("typescript", "tsc"),
  args: [
    "-p",
    "tsconfig.json",
    "--noEmit",
    "--lib",
    "ES2024,DOM"
  ],
  cwd,
  data: [srcs, S.file("tsconfig.json"), S.file("//tsconfig.base.json")]
})

const ci = S.Suite({ tests: [suite, scorer, types] })

export const Package = S.Package({
  targets: { srcs, suite, scorer, types, ci }
})
