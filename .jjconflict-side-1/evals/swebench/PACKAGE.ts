/**
 * Targets for the SWE-bench benchmark rig.
 *
 * One target only: the typecheck of the rig's own TypeScript, run from this
 * directory, which is a workspace member (`@smthrs/eval-swebench`) so `tsc`
 * reads the toolchain the manifest pins. The benchmark itself is deliberately
 * not a target. It spends real API tokens, needs docker and multi-gigabyte
 * images, and takes tens of minutes per instance, so it is operator-run — a
 * gate that cannot run without a funded key and a warm docker cache is not a
 * gate. `verify.sh` is the offline check that the scorecard still computes what
 * it claims, and it is run by hand for the same reason: it exists to defend an
 * operator workflow, not to hold the tree.
 *
 * There is no `lint` or `fmt` target. Most of this directory is captured
 * evaluator output — `baseline/`, `reports/`, `fixtures/` — whose bytes are
 * evidence of what a wave measured, and a formatting gate would rewrite them.
 */
import { Smithers } from "@smthrs/targets"

const cwd = "evals/swebench"

/**
 * Checks the scorecard generator and its price table against their tsconfig.
 *
 * @since 0.1.0
 * @category build
 */
const check = Smithers.Typecheck({
  srcs: [Smithers.glob("//evals/swebench/*.ts")],
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

export const Package = Smithers.Package({
  targets: { check }
})
