import { Smithers as S } from "@smthrs/targets"

const srcs = S.Filegroup({
  srcs: [
    ...S.glob(["*.ts", "corpus/**/*"]),
    S.file("baseline.json")
  ]
})

const suite = S.Shell.Test({
  bin: S.Host.bin("bun"),
  args: ["evals/review-seeded-bugs/run.ts"],
  data: [srcs]
})

const scorer = S.Shell.Test({
  bin: S.Host.bin("bun"),
  args: [
    "test",
    "evals/review-seeded-bugs/score.test.ts",
    "evals/review-seeded-bugs/deterministicReviewer.test.ts"
  ],
  data: [srcs]
})

const types = S.Shell.Test({
  bin: S.NodeModule.Bin("typescript", "tsc"),
  args: [
    "-p",
    "evals/review-seeded-bugs/tsconfig.json",
    "--noEmit",
    "--lib",
    "ES2024,DOM"
  ],
  data: [srcs, S.file("tsconfig.json"), S.file("//tsconfig.base.json")]
})

const ci = S.Suite({ tests: [suite, scorer, types] })

export const Package = S.Package({
  targets: { srcs, suite, scorer, types, ci }
})
