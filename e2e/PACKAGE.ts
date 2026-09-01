// Package-mode port of e2e/BUILD.ts, the fault-injection matrix.
//
// The matrix is one job because its cases are not independent: they spawn
// processes, bind ephemeral ports, and kill process groups, all of which are
// machine-global. `e2e/vitest.config.ts` runs them without file parallelism,
// and this declaration keeps the whole thing addressable as `//e2e:faults`.
//
// It stays on the Node lane. Bun's `node:sqlite` binds the host SQLite, built
// without extension loading, which the storage layer every crash case runs on
// requires.
import { Smithers as S } from "@smthrs/targets"

// Every target runs from this directory so vitest and tsc read the matrix's
// own configuration rather than the workspace root's.
const cwd = "e2e"

/** The fault primitives and the programs they spawn. */
const harness = S.Filegroup({ srcs: [S.glob("harness/**/*.ts"), S.glob("fixtures/**/*.ts")] })

/** The cases themselves, the manifest reader, and the budgets they enforce. */
const tests = S.Filegroup({
  srcs: [S.glob("faults/**/*.ts"), S.glob("ci/**/*.ts"), S.glob("budgets/**/*"), S.file("fault-matrix.json")]
})

const check = S.Shell.Test({
  bin: S.NodeModule.Bin("typescript", "tsc"),
  args: ["-p", "tsconfig.json", "--noEmit"],
  cwd,
  data: [harness, tests, S.file("tsconfig.json"), S.file("vitest.config.ts")]
})

// Not cacheable in any useful sense: the cases kill processes and read the
// machine's process table, so the suite re-runs on every invocation. That is
// the point of the tier. Coverage stays off because the matrix asserts
// process-level behavior, not line reach.
const faults = S.Shell.Test({
  bin: S.NodeModule.Bin("vitest"),
  args: ["run", "--coverage.enabled=false"],
  cwd,
  data: [harness, tests, S.file("vitest.config.ts")]
})

// `check` only. Two gates in the matrix are red by design and owned elsewhere
// (case 22's redaction requirement, and the durable park), so `faults` runs in
// its own advisory workflow rather than inside a required suite.
const ci = S.Suite({ tests: [check] })

export const Package = S.Package({
  targets: { harness, tests, check, faults, ci }
})
