/**
 * Targets for the command-recommender eval.
 *
 * Two test targets, because the suite has two halves that fail for different
 * reasons. `test` is the scoring-math and program-behaviour suite: pure,
 * fast, and offline. `suite` scores the checked-in fixture and gates the
 * result on `baseline.json`, so a red run means the scorer moved. Neither
 * touches the network: the live pull (`run.ts --live`) is an operator command
 * that reads an admin token from the environment, and it has no target.
 *
 * Both run from this directory, which is a workspace member
 * (`@smthrs/eval-recommend`), so `bun` and `tsc` read the toolchain the
 * manifest pins.
 *
 * There is no `lint` or `fmt` target. `baseline.json` is the canonical JSON
 * `run.ts --update` writes byte for byte, and `fixtures/sample.jsonl` is one
 * JSON object per line; a formatter would rewrite both.
 *
 * @since 1.0.0
 */
import { Smithers } from "@smthrs/targets"

const cwd = "evals/recommend"

/** The suite's own sources, the fixture it scores, and the baseline it gates on. */
const sources = [
  Smithers.glob("//evals/recommend/*.ts"),
  Smithers.file("//evals/recommend/fixtures/sample.jsonl"),
  Smithers.file("//evals/recommend/baseline.json")
]

/**
 * Scores the fixture and gates on the baseline.
 *
 * @since 1.0.0
 * @category test
 */
const suite = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.entrypoint(Smithers.file("//evals/recommend/run.ts")),
  srcs: sources,
  deps: [],
  cwd
})

/**
 * The scoring-math and program-behaviour suite.
 *
 * @since 1.0.0
 * @category test
 */
const test = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.testSuite(["score.test.ts", "run.test.ts"]),
  srcs: sources,
  deps: [],
  cwd
})

/**
 * Checks the suite's own sources, including its two `bun:test` files, against
 * its tsconfig.
 *
 * @since 1.0.0
 * @category build
 */
const check = Smithers.Typecheck({
  srcs: sources,
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

export const Package = Smithers.Package({
  targets: { check, suite, test }
})
