/**
 * Targets for the review seeded-bug suite.
 *
 * Two targets, because the suite has two halves that fail for different
 * reasons. `scorer` is the corpus-integrity and scoring-math suite: pure, fast,
 * and independent of the review app. `suite` runs the real review flow over all
 * sixteen fixtures and gates the result on `baseline.json`; it is offline
 * because its reviewing seat is `deterministicReviewer.ts` rather than a model,
 * so it spends nothing and answers the same way twice.
 *
 * @since 1.0.0
 */
import { Smithers } from "@smthrs/targets"
import { bunRuntime, packageManager } from "../../BUILD.ts"

const cwd = "evals/review-seeded-bugs"

/** The suite's own sources, the corpus it reads, and the baseline it gates on. */
const sources = [
  Smithers.glob("//evals/review-seeded-bugs/*.ts"),
  Smithers.glob("//evals/review-seeded-bugs/corpus/**/*"),
  Smithers.file("//evals/review-seeded-bugs/baseline.json")
]

/**
 * Runs every fixture through the real review flow and gates on the baseline.
 *
 * A red run means the pipeline moved: diff ingestion, per-file fan-out,
 * scoping, anchoring, de-duplication, or the scorer's matching. The model's own
 * score is what `run.ts --live` measures, and it is never a gate.
 *
 * @since 1.0.0
 * @category test
 */
export const suite = Smithers.NodeTest({
  runtime: bunRuntime,
  runner: Smithers.entrypoint(Smithers.file("//evals/review-seeded-bugs/run.ts")),
  srcs: sources,
  deps: []
})

/**
 * The corpus-integrity and scoring-math suite.
 *
 * @since 1.0.0
 * @category test
 */
export const scorer = Smithers.NodeTest({
  runtime: bunRuntime,
  runner: Smithers.testSuite(["score.test.ts", "deterministicReviewer.test.ts"]),
  srcs: sources,
  deps: [],
  cwd
})

/**
 * Checks the suite's own sources against its tsconfig.
 *
 * @since 1.0.0
 * @category build
 */
export const types = Smithers.Typecheck({
  packageManager,
  srcs: sources,
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})
