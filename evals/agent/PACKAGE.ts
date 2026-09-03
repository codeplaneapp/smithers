/**
 * Targets for the offline agent evaluation suite.
 *
 * The suite is a program whose exit code is the verdict — it scores the agent
 * against `baseline.json` and fails on drift — so it is a test target, and its
 * own typecheck is a build target. Both run through the declared toolchain:
 * the suite under the declared Bun runtime, the typecheck through the declared
 * package manager, so neither `bun` nor `npx` is spelled anywhere.
 */
import { Smithers } from "@smthrs/targets"
import { bunRuntime, packageManager } from "../../PACKAGE.ts"

const cwd = "evals/agent"

/** The suite, its subject, and the committed baseline it gates on. */
const sources = [Smithers.glob("//evals/agent/*.ts"), Smithers.file("//evals/agent/baseline.json")]

/**
 * Runs the evaluation suite and gates it on the committed baseline.
 *
 * The run is offline: the only replaced pieces are the model behind the seat
 * resolver and the route it seals against, so no API key, network access, or
 * global CLI install is involved and every score is reproducible.
 *
 * @since 0.1.0
 * @category test
 */
const suite = Smithers.NodeTest({
  runtime: bunRuntime,
  runner: Smithers.entrypoint(Smithers.file("//evals/agent/run.ts")),
  srcs: sources,
  deps: []
})

/**
 * Checks the suite's own sources against its tsconfig.
 *
 * @since 0.1.0
 * @category build
 */
const types = Smithers.Typecheck({
  packageManager,
  srcs: sources,
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

export const Package = Smithers.Package({
  targets: { suite, types }
})
