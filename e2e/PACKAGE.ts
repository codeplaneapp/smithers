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
// Two restrictions land on this matrix. harness/dropWebSocket.test.ts and
// harness/serveProcess.ts bind 127.0.0.1:0, which the default profile refuses
// with "listen EPERM"; the loopback profile answers that one. The decisive
// one is harness/killProcess.ts, whose `parentPid` reads the machine's
// process table through /bin/ps. /bin/ps is setuid root, and a sandboxed
// process may never gain privileges, so sandbox-exec refuses the exec under
// every profile, including one that allows everything. That is an exec
// restriction, not a network one, so no `network` value reaches it and "none"
// is the only declaration that runs the matrix. It is also the only safe one:
// `parentPid` catches the failure and returns undefined, which reads as "the
// process is gone", so under a sandbox the orphan assertions in
// harness/killProcess.test.ts and case31 either invert or pass for the wrong
// reason.
const faults = S.Shell.Test({
  bin: S.NodeModule.Bin("vitest"),
  args: ["run", "--coverage.enabled=false"],
  cwd,
  sandbox: "none",
  data: [harness, tests, S.file("vitest.config.ts")]
})

// `check` only. Two gates in the matrix are red by design and owned elsewhere
// (case 22's redaction requirement, and the durable park), so `faults` runs in
// its own advisory workflow rather than inside a required suite.
const ci = S.Suite({ tests: [check] })

export const Package = S.Package({
  targets: { harness, tests, check, faults, ci }
})
