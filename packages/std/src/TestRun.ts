/**
 * The `test` flow: run the declared suite, and answer with the two facts.
 *
 * Two things this returns that a shell command cannot. First, a *reading*:
 * `{passed, failed}` parsed from the runner's own report, with the raw tail
 * kept for whatever the parse could not carry — a suite's answer is a number
 * and a list of names, not twenty kilobytes of stdout for a model to re-read.
 *
 * Second, `against: "base"`: the same selection also runs against the pristine
 * base commit in a scratch worktree, and the two failure sets are differenced
 * here. That is the whole of attribution, in one call. Without it, agents pay
 * for it in frames — sphinx-8721 spent fourteen frames because a pre-existing
 * failure was never baselined, sympy-13878 spent $0.90 on the same mistake, and
 * django-24970 spent three frames. The rule the harness teaches ("before
 * blaming your own edit, run the same command on the unmodified tree") is only
 * cheap when the tool can do it.
 *
 * @since 0.1.0
 */
import * as Flow from "@smthrs/core/Flow"
import type * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Container from "./Container.ts"
import { capability, envelope } from "./internal/Declaration.ts"
import * as Exec from "./internal/Exec.ts"
import * as TestReport from "./internal/TestReport.ts"
import { MAX_SHELL_OUTPUT_BYTES, truncateBytes } from "./internal/Text.ts"
import * as Probe from "./Probe.ts"
import * as StdError from "./StdError.ts"
import * as TestRunner from "./TestRunner.ts"

/**
 * Registry name for the test flow.
 *
 * @category identifiers
 * @since 0.1.0
 */
export const name = "test"

/**
 * Model-facing description of the test flow.
 *
 * @category descriptions
 * @since 0.1.0
 */
export const description =
  "Run this repository's declared test runner and get {passed, failed[ids]}, not raw output. against:'base' also runs it on the pristine base commit, so a pre-existing failure is named, not investigated."

/**
 * The directory a baseline worktree is checked out into, relative to the
 * repository root, and therefore also relative to the runner's own directory.
 *
 * @category constants
 * @since 0.1.0
 */
export const scratchDirectory = ".flows-test-base"

/**
 * Input schema for the test flow.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Input = Schema.Struct({
  selection: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Test ids, paths or selectors passed to the runner as arguments; all tests when omitted"
  }),
  against: Schema.optional(Schema.Literals(["workspace", "base"])).annotate({
    description:
      "workspace (default) runs the tree as it stands; base also runs the pristine base commit and reports which failures are new"
  }),
  timeoutMs: Schema.optional(Schema.Number).annotate({ description: "Wall-clock timeout in milliseconds" })
})

/**
 * One run's outcome.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Outcome = Schema.Struct({
  command: Schema.String.annotate({ description: "The invocation that ran, quotable as the evidence it is" }),
  exitCode: Schema.Number,
  passed: Schema.Number.annotate({ description: "Tests reported passing; 0 when parsed is false" }),
  failed: Schema.Array(Schema.String).annotate({ description: "Ids of the tests reported failing or erroring" }),
  parsed: Schema.Boolean.annotate({
    description: "Whether the runner's report could be read; when false, tail is all there is"
  }),
  tail: Schema.String.annotate({ description: "The end of the runner's combined output" }),
  // `<field>Truncated` beside `<field>` is the wire convention
  // `@smthrs/harness/TruncatedOutput` reads to refuse a later write of these
  // exact bytes. A tail written over a file replaces it with its own end.
  tailTruncated: Schema.Boolean.annotate({
    description: "Whether the runner printed more than tail carries, leaving tail a fragment that must not be written"
  }),
  tailDroppedBytes: Schema.Number.annotate({ description: "UTF-8 bytes omitted from the start of tail" }),
  invalidProbe: Schema.optional(Probe.InvalidProbe)
})

/**
 * Output schema for the test flow.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Output = Schema.Struct({
  ...Outcome.fields,
  base: Schema.optional(Schema.Struct({
    ...Outcome.fields,
    ref: Schema.String.annotate({ description: "The ref the baseline tree came from" }),
    commit: Schema.String.annotate({ description: "The commit the baseline tree came from" })
  })),
  introduced: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Failing here and not on the base tree: the failures this working tree is responsible for"
  }),
  preexisting: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Failing on both trees: not yours, and not worth investigating"
  }),
  fixed: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Failing on the base tree and passing here"
  })
})

/**
 * Static conservative effect envelope for the test flow.
 *
 * @category effects
 * @since 0.1.0
 */
export const effects = envelope({ tier: "irreversible", mode: "expected", reads: [], writes: [] })

/**
 * Narrows the effect envelope for a decoded invocation.
 *
 * @category effects
 * @since 0.1.0
 */
export const effectsFor = (_input: typeof Input.Type) => effects

/**
 * Capabilities required by the test flow.
 *
 * @category capabilities
 * @since 0.1.0
 */
export const capabilities = [capability("proc:spawn", "*")]

/**
 * Declaration-only test flow.
 *
 * @category flows
 * @since 0.1.0
 */
export const flow = Flow.make({ name, description, input: Input, output: Output, capabilities, effects })

/**
 * The invocation for one run: the declared command line with the selection
 * appended as arguments rather than as text.
 *
 * `bash -lc '<command> "$@"' <command> id…` is how a selection reaches a runner
 * without being quoted into it. A test id holds `::`, `[`, `]`, spaces and
 * shell metacharacters routinely, and every one of them is data here.
 */
const invocation = (
  runner: TestRunner.Runner,
  selection: ReadonlyArray<string>
): { readonly file: string; readonly args: ReadonlyArray<string> } => ({
  file: "bash",
  args: ["-lc", `${runner.command} "$@"`, runner.command, ...selection]
})

const failed = (message: string, code: StdError.Code = "command_failed"): StdError.StdError =>
  new StdError.StdError({ code, message })

/** Runs one invocation, in the container when the declaration names one. */
const execute = (
  runner: TestRunner.Runner,
  transport: Option.Option<Container.Container>,
  options: {
    readonly selection: ReadonlyArray<string>
    readonly cwd: string | undefined
    readonly timeoutMs: number | undefined
  }
): Effect.Effect<typeof Outcome.Type, StdError.StdError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const plan = invocation(runner, options.selection)
    const routed = runner.container === undefined ? plan : Option.isNone(transport)
      ? yield* Effect.fail(Container.unavailable(runner.container))
      : yield* transport.value.exec({
        container: runner.container,
        file: plan.file,
        args: plan.args,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(runner.env === undefined ? {} : { env: runner.env }),
        stdin: false
      })
    const quoted = [routed.file, ...routed.args].join(" ")
    const result = yield* Exec.exec(routed.file, {
      args: [...routed.args],
      ...(options.cwd === undefined || runner.container !== undefined ? {} : { cwd: options.cwd }),
      ...(runner.env === undefined || runner.container !== undefined ? {} : { env: runner.env }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
    }).pipe(
      Effect.mapError((error) =>
        failed(
          `The test runner did not run: ${error instanceof Error ? error.message : String(error)}`,
          typeof error === "object" && error !== null && "code" in error && error.code === "timeout"
            ? "timeout"
            : "command_failed"
        )
      )
    )
    const combined = result.stderr === ""
      ? result.stdout
      : result.stdout === ""
      ? result.stderr
      : `${result.stdout}\n${result.stderr}`
    const tail = truncateBytes(combined, MAX_SHELL_OUTPUT_BYTES, { keep: "tail" })
    const report = TestReport.parse(combined)
    const probe = Probe.classify({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr })
    return {
      command: quoted,
      exitCode: result.exitCode,
      passed: report.passed,
      failed: report.failed,
      parsed: report.parsed,
      tail: tail.text,
      tailTruncated: tail.truncated,
      tailDroppedBytes: tail.droppedBytes,
      ...(probe === undefined ? {} : { invalidProbe: probe })
    }
  })

const git = (
  root: string,
  args: ReadonlyArray<string>
): Effect.Effect<Exec.ExecResult, StdError.StdError, ChildProcessSpawner.ChildProcessSpawner> =>
  Exec.exec("git", { args: ["-C", root, ...args] }).pipe(
    Effect.mapError((error) => failed(`git could not run: ${error.message}`))
  )

/** The commit a baseline runs against, and the ref it was named by. */
const baseCommit = (
  root: string,
  declared: string | undefined
): Effect.Effect<
  { readonly ref: string; readonly commit: string },
  StdError.StdError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function*() {
    // A declared ref that does not resolve is an error rather than a fallback:
    // a baseline against the wrong tree answers the attribution question wrong,
    // which is worse than not answering it.
    const candidates = declared === undefined ? [TestRunner.captureBase, "HEAD"] : [declared]
    for (const ref of candidates) {
      const resolved = yield* git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
      const commit = resolved.stdout.trim()
      if (resolved.exitCode === 0 && commit !== "") return { ref, commit }
    }
    return yield* Effect.fail(
      failed(
        `No pristine base to compare against: ${candidates.join(" and ")} ${
          candidates.length === 1 ? "does" : "do"
        } not resolve in ${root}. Run against the workspace instead.`,
        "not_found"
      )
    )
  })

/**
 * Runs the declared suite, and on request the same suite on the pristine base.
 *
 * The baseline is a detached worktree of the base commit inside the repository,
 * so a runner that reaches the repository through a mount reaches the worktree
 * the same way. It is removed when the call ends, however it ends.
 *
 * @category handlers
 * @since 0.1.0
 */
export const run = Effect.fn("TestRun.run")(function*(
  input: typeof Input.Type
): Effect.fn.Return<
  typeof Output.Type,
  StdError.StdError,
  ChildProcessSpawner.ChildProcessSpawner | TestRunner.TestRunner
> {
  const declaration = yield* TestRunner.TestRunner
  const runner = yield* declaration.declared
  const transport = yield* Effect.serviceOption(Container.Container)
  const selection = input.selection ?? []
  const timeoutMs = input.timeoutMs ?? runner.timeoutMs
  const current = yield* execute(runner, transport, {
    selection,
    cwd: runner.cwd,
    timeoutMs
  })
  if (input.against !== "base") return current

  const root = runner.root ?? runner.cwd
  if (root === undefined) {
    return yield* Effect.fail(
      failed(
        "The declared runner names no repository directory, so there is no base tree to check out",
        "invalid_input"
      )
    )
  }
  const base = yield* baseCommit(root, runner.baseRef)
  const scratch = `${root.replace(/\/+$/, "")}/${scratchDirectory}`
  const outcome = yield* Effect.acquireUseRelease(
    git(root, ["worktree", "add", "--detach", "--force", scratch, base.commit]).pipe(
      Effect.flatMap((added) =>
        added.exitCode === 0
          ? Effect.void
          : Effect.fail(failed(`Could not check out ${base.commit} for a baseline run: ${added.stderr.trim()}`))
      )
    ),
    () =>
      execute(runner, transport, {
        selection,
        cwd: runner.cwd === undefined ? scratch : `${runner.cwd.replace(/\/+$/, "")}/${scratchDirectory}`,
        timeoutMs
      }),
    () => Effect.ignore(git(root, ["worktree", "remove", "--force", scratch]))
  )
  const difference = TestReport.attribute(current.failed, outcome.failed)
  return {
    ...current,
    base: { ...outcome, ref: base.ref, commit: base.commit },
    ...difference
  }
})
