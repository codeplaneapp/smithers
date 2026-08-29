/**
 * Incur command surface for smithers build.
 *
 * Every command returns structured data for incur's envelope. Progress and
 * the human-facing rendering of that data go through {@link Reporter}: a
 * person at a terminal sees a live or coloured account on standard error and
 * a tree or table on standard output, while a pipe, a CI log, or an explicit
 * `--format` sees exactly the plain lines and the envelope it always did.
 *
 * @since 0.1.0
 */
import * as Config from "@smthrs/targets/Config"
import * as Target from "@smthrs/targets/Target"
import { Cli, z } from "incur"
import * as NodePath from "node:path"
import * as Ansi from "./Ansi.ts"
import * as Diagnostic from "./Diagnostic.ts"
import { runInstall } from "./engine.ts"
import * as Executor from "./Executor.ts"
import * as GitHooks from "./GitHooks.ts"
import * as GraphOutput from "./GraphOutput.ts"
import * as PackageDiscovery from "./PackageDiscovery.ts"
import * as PackageExec from "./PackageExec.ts"
import * as PackageIndex from "./PackageIndex.ts"
import * as PackageLoader from "./PackageLoader.ts"
import * as Planner from "./Planner.ts"
import * as Query from "./Query.ts"
import * as Reporter from "./Reporter.ts"
import {
  ensureGitignored,
  resolveConfig,
  type ResolvedRemoteCache,
  resolveRemoteCache,
  Workspace
} from "./Workspace.ts"

const workspaceOption = z.object({
  workspace: z.string().default(process.cwd()).describe("Workspace root containing BUILD.ts files"),
  cacheDir: z.string().optional().describe(
    "Workspace-relative cache directory; overrides the root BUILD.ts declaration and .flows"
  )
})

const executionOptions = workspaceOption.extend({
  plan: z.boolean().default(false).describe("Print the inert plan instead of executing"),
  jobs: z.number().int().min(1).optional().describe("Maximum concurrent targets; defaults to host parallelism"),
  cache: z.boolean().default(true).describe("Consult the result cache before running; --no-cache bypasses reads")
})

/** The flags outward and agent targets take: the commit message override and payload inputs. */
const invocationOptions = {
  message: z.string().optional().describe("Commit message for a Git.Commit target; wins over the declared message"),
  input: z.array(z.string()).optional().describe("Payload input for agent targets as name=value; repeatable")
}

const runOptions = executionOptions.extend({
  name: z.string().optional().describe("Package name supplied to scaffold targets"),
  ...invocationOptions
})

const executionAlias = { workspace: "w", jobs: "j" }

const invocationAlias = { message: "m", input: "i" }

const patternArgument = z.object({
  pattern: z.string().describe("Bazel label or recursive pattern")
})

/** The options every command accepts, parsed before the command is resolved. */
const globalOptions = z.object({
  ui: z.enum(Reporter.uiModes).default("auto").describe(
    "Terminal renderer: tty draws in place, stream colours without cursor motion, plain prints bare lines; " +
      "auto picks tty on a terminal and plain under a pipe, CI, NO_COLOR, or an explicit --format"
  )
})

/** The flags every command shares. */
interface WorkspaceFlags {
  readonly workspace: string
  readonly cacheDir?: string | undefined
}

/** The flags shared by commands that execute targets. */
interface ExecutionFlags extends WorkspaceFlags {
  readonly plan: boolean
  readonly jobs?: number | undefined
  readonly cache: boolean
}

/**
 * Process-scoped configuration captured before BUILD.ts evaluation.
 *
 * `stdout` and `stderr` default to the process streams; tests inject
 * in-memory terminals. `exit` records the exit code of a failure a
 * human renderer has already explained, so the envelope's error block is not
 * printed twice; without it the structured error is returned instead. The
 * process entry point supplies it, because deciding the exit code is a
 * choice only a process owner may make.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface RuntimeConfig {
  readonly cacheUrl?: string | undefined
  readonly cacheToken?: string | undefined
  readonly signal?: AbortSignal | undefined
  /**
   * The environment package-mode execution reads for agent-fake selection
   * (`SMTHRS_AGENT_FAKE`), backend PATH lookups, and outward preconditions.
   * Defaults to `process.env`; tests inject a hermetic record.
   */
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  readonly stdout?: Reporter.Terminal | undefined
  readonly stderr?: Reporter.Terminal | undefined
  readonly exit?: ((code: number) => void) | undefined
}

interface PreparedWorkspace {
  readonly root: string
  readonly cacheDirectory: string
  readonly remoteCache?: (ResolvedRemoteCache & { readonly token?: string | undefined }) | undefined
}

/** The slice of an incur command context the presentation helpers read. */
interface Presentation {
  readonly agent: boolean
  readonly formatExplicit: boolean
  readonly globals: { readonly ui: Reporter.UiMode }
}

/** incur's error result constructor, as the command context exposes it. */
type ErrorResult = (options: {
  readonly code: string
  readonly exitCode?: number | undefined
  readonly message: string
  readonly retryable?: boolean | undefined
}) => never

const environmentOf = (config: RuntimeConfig): Ansi.Environment => config.environment ?? process.env

const terminalsOf = (
  config: RuntimeConfig
): { readonly stdout: Reporter.Terminal; readonly stderr: Reporter.Terminal } => ({
  stdout: config.stdout ?? Reporter.terminalOf(process.stdout),
  stderr: config.stderr ?? Reporter.terminalOf(process.stderr)
})

/**
 * The renderer one command draws with. Execution progress goes to standard
 * error, so both streams are consulted; a tree or table goes to standard
 * output, so only that stream matters.
 */
const rendererFor = (context: Presentation, config: RuntimeConfig, bound: "stdout" | "stderr"): Reporter.Renderer => {
  const { stderr, stdout } = terminalsOf(config)
  const streams = bound === "stderr"
    ? { stdout: stdout.isTTY, stderr: stderr.isTTY }
    : { stdout: stdout.isTTY, stderr: stdout.isTTY }
  return Reporter.resolveRenderer(context.globals.ui, environmentOf(config), streams, context.formatExplicit)
}

/** Whether a person is reading: a human renderer, and incur agrees standard output is theirs. */
const forPeople = (context: Presentation, renderer: Reporter.Renderer): boolean =>
  renderer !== "plain" && !context.agent

const reporterFor = (context: Presentation, config: RuntimeConfig): Reporter.Reporter =>
  Reporter.make({
    renderer: rendererFor(context, config, "stderr"),
    terminal: terminalsOf(config).stderr,
    env: environmentOf(config)
  })

/**
 * Hands data to a person as rendered text on standard output, or to incur as
 * the envelope's data.
 */
const present = <A>(
  context: Presentation,
  config: RuntimeConfig,
  data: A,
  render: (style: Ansi.Palette) => string
): A | undefined => {
  const renderer = rendererFor(context, config, "stdout")
  if (!forPeople(context, renderer)) return data
  const { stdout } = terminalsOf(config)
  stdout.write(`${render(Ansi.palette(environmentOf(config), stdout.isTTY))}\n`)
  return undefined
}

/**
 * Settles the cache directory one command runs under. Executing commands apply
 * the declared gitignore policy before writing state; query, graph, and plan
 * commands pass `writeState = false` and remain observational.
 *
 * Reading the declared token from the environment is a read, never a write.
 * Removing the name from `process.env` here would mutate state the caller
 * owns: `makeCli` is a library entry point, and two concurrent commands with
 * different declared token names would delete each other's credentials. The
 * child-process boundary is where the credential is withheld, and `ExecLive`
 * already strips both `SMITHERS_CACHE_URL` and every name in `sensitiveEnv`
 * from a spawned tool's environment. The process entry point in `main.ts`
 * captures and clears the default names for its own short-lived process,
 * which is a choice only a process owner may make.
 */
const prepare = async (
  flags: WorkspaceFlags,
  runtime: RuntimeConfig = {},
  writeState = true
): Promise<PreparedWorkspace> => {
  runtime.signal?.throwIfAborted()
  const root = NodePath.resolve(flags.workspace)
  const config = await resolveConfig(root, flags.cacheDir)
  runtime.signal?.throwIfAborted()
  const remoteCache = await resolveRemoteCache(root, runtime.cacheUrl)
  let preparedRemote: PreparedWorkspace["remoteCache"]
  if (remoteCache !== undefined) {
    const token = remoteCache.tokenEnv === "SMITHERS_CACHE_TOKEN"
      ? runtime.cacheToken ?? process.env[remoteCache.tokenEnv]
      : process.env[remoteCache.tokenEnv]
    preparedRemote = { ...remoteCache, token }
  }
  if (writeState && config.gitignored) await ensureGitignored(root, config.cacheDirectory)
  runtime.signal?.throwIfAborted()
  return preparedRemote === undefined
    ? { root, cacheDirectory: config.cacheDirectory }
    : { root, cacheDirectory: config.cacheDirectory, remoteCache: preparedRemote }
}

/** Opens the workspace index under the resolved cache directory. */
const openWorkspace = async (
  flags: WorkspaceFlags,
  runtime: RuntimeConfig = {},
  writeState = true
): Promise<{ readonly workspace: Workspace; readonly remoteCache: PreparedWorkspace["remoteCache"] }> => {
  const prepared = await prepare(flags, runtime, writeState)
  return {
    workspace: await Workspace.make(prepared.root, process.cwd(), {
      cacheDirectory: prepared.cacheDirectory,
      signal: runtime.signal
    }),
    remoteCache: prepared.remoteCache
  }
}

/**
 * Opens the PACKAGE.ts index when the resolved workspace is in package mode:
 * the nearest ancestor of the workspace flag holding `.smithers/WORKSPACE.ts`
 * or a root `WORKSPACE.ts` decides. A BUILD.ts workspace has neither and
 * returns undefined, so BUILD mode is untouched.
 */
const openPackageIndex = async (
  flags: WorkspaceFlags,
  runtime: RuntimeConfig = {}
): Promise<PackageIndex.PackageIndex | undefined> => {
  runtime.signal?.throwIfAborted()
  const root = await PackageDiscovery.findWorkspaceRoot(NodePath.resolve(flags.workspace))
  if (root === undefined) return undefined
  // The flag wins; otherwise the WORKSPACE-declared cache directory must
  // reach the prune set before the package walk, or a workspace with a
  // non-default cache directory would index its own cache artifacts. The
  // probe evaluates only WORKSPACE.ts and is forgiving — on failure the
  // full load reports the real diagnostic under the default prune.
  let cacheDirectory = flags.cacheDir === undefined ? undefined : Config.normalizeCacheDirectory(flags.cacheDir)
  if (cacheDirectory === undefined) {
    const workspaceFile = await PackageDiscovery.workspaceFileOf(root)
    if (workspaceFile !== undefined) {
      cacheDirectory = await PackageLoader.probeCacheDirectory(root, workspaceFile)
    }
  }
  const discovery = await PackageDiscovery.discover(root, { cacheDirectory, signal: runtime.signal })
  const loaded = await PackageLoader.load(discovery)
  return PackageIndex.PackageIndex.make(loaded, process.cwd())
}

/** Package-mode `query`: the same listing shape BUILD mode prints. */
const packageQuery = (
  index: PackageIndex.PackageIndex,
  expression: string
): Query.Listing | Query.Dependencies => {
  const dependencyMatch = expression.match(/^deps\((.+)\)$/)
  if (dependencyMatch?.[1] !== undefined) {
    const rows = index.resolve(dependencyMatch[1].trim())
    if (rows.length !== 1) throw new Error("deps() requires one exact or default target")
    const root = rows[0]!
    const closure = new Set<string>()
    const stack = [root.target]
    const seen = new Set<Target.AnyTarget>()
    while (stack.length > 0) {
      const current = stack.pop()!
      if (seen.has(current)) continue
      seen.add(current)
      const label = index.labelOf(current)
      if (label !== undefined && label !== root.label) closure.add(label)
      for (const dependency of Target.metadata(current).dependencies) stack.push(dependency)
    }
    return {
      query: expression,
      root: root.label,
      dependencies: [...closure].sort(),
      edges: index.edges(rows)
    }
  }
  return {
    query: expression,
    targets: index.resolve(expression).map((row) => ({
      label: row.label,
      target: Target.metadata(row.target).target,
      kinds: Target.metadata(row.target).kinds
    }))
  }
}

/** Package-mode `graph`: labeled nodes plus classified edges. */
const packageGraph = (index: PackageIndex.PackageIndex, pattern: string): {
  readonly rows: ReadonlyArray<GraphOutput.PackageRow>
  readonly edges: ReadonlyArray<PackageIndex.Edge>
  readonly data: unknown
} => {
  const selected = index.resolve(pattern)
  const edges = index.edges(selected)
  const rows = selected.map((row) => ({ label: row.label, target: Target.metadata(row.target).target }))
  return {
    rows,
    edges,
    data: {
      pattern,
      format: "text",
      graph: GraphOutput.packageText(rows, edges),
      roots: rows.map((row) => row.label),
      targets: rows,
      edges,
      warnings: []
    }
  }
}

/** The plan printed by `ci --plan`: all CI verb plans merged over one pattern. */
interface CiPlan extends Executor.MergedPlan {
  readonly verb: "ci"
  readonly pattern: string
}

/**
 * Refuses execution verbs in package mode that stay out of the W2 feature
 * set (`ci`, `docs`, `install`). Failing here is the no-fake-green rule at
 * the CLI boundary.
 */
const refusePackageMode = async (flags: WorkspaceFlags, verb: string): Promise<void> => {
  const root = await PackageDiscovery.findWorkspaceRoot(NodePath.resolve(flags.workspace))
  if (root !== undefined) {
    throw new Error(
      `NotImplemented: ${verb} does not execute PACKAGE.ts targets yet; ` +
        "query, graph, build, test, lint, run, and the bare-label form are the package-mode surface"
    )
  }
}

/** The mode and invocation flags the package-mode execution surface accepts. */
interface ModeFlags {
  readonly write?: boolean | undefined
  readonly fix?: boolean | undefined
  readonly message?: string | undefined
  readonly input?: ReadonlyArray<string> | undefined
}

/** Parses repeated `--input name=value` flags into the agent payload record. */
const parseInputs = (entries: ReadonlyArray<string> | undefined): Readonly<Record<string, string>> | undefined => {
  if (entries === undefined || entries.length === 0) return undefined
  const values: Record<string, string> = {}
  for (const entry of entries) {
    const separator = entry.indexOf("=")
    if (separator <= 0) throw new Error(`--input expects name=value, received ${JSON.stringify(entry)}`)
    const name = entry.slice(0, separator)
    if (name in values) throw new Error(`--input names ${JSON.stringify(name)} twice`)
    values[name] = entry.slice(separator + 1)
  }
  return values
}

/**
 * Runs one execution verb through the package-mode executor when the
 * resolved workspace is a PACKAGE.ts workspace, or returns undefined so the
 * caller falls through to BUILD mode.
 */
const runPackageVerb = async (
  verb: PackageExec.PackageVerb,
  pattern: string,
  flags: ExecutionFlags & ModeFlags,
  config: RuntimeConfig,
  reporter: Reporter.Reporter
): Promise<Executor.Summary | PackageExec.PlanReport | undefined> => {
  const index = await openPackageIndex(flags, config)
  if (index === undefined) return undefined
  const cacheDirectory = flags.cacheDir === undefined
    ? index.workspace.cache.directory
    : Config.normalizeCacheDirectory(flags.cacheDir)
  return PackageExec.run({
    index,
    cacheDirectory,
    verb,
    pattern,
    write: flags.write,
    fix: flags.fix,
    plan: flags.plan,
    jobs: flags.jobs,
    readCache: flags.cache,
    signal: config.signal,
    reporter,
    message: flags.message,
    inputs: parseInputs(flags.input),
    environment: config.environment
  })
}

/**
 * The `gitHooks` command: renders the WORKSPACE.ts hook bindings to
 * `.git/hooks` scripts, byte-checks them by default, installs them under
 * `--write`. Drift is a red exit, like every other generated file.
 */
const runGitHooks = async (
  flags: WorkspaceFlags & { readonly write: boolean },
  config: RuntimeConfig
): Promise<
  | { readonly mode: "check"; readonly clean: boolean; readonly entries: ReadonlyArray<GitHooks.CheckEntry> }
  | { readonly mode: "install"; readonly installed: ReadonlyArray<string> }
> => {
  const index = await openPackageIndex(flags, config)
  if (index === undefined) {
    throw new Error("gitHooks renders PACKAGE.ts workspace bindings; this workspace has no WORKSPACE.ts")
  }
  const bindings = GitHooks.resolveHookLabels(index.workspace, index)
  const rendered = GitHooks.render(bindings)
  if (flags.write) {
    const { wrote } = await GitHooks.install(index.root, rendered)
    return { mode: "install", installed: wrote }
  }
  const report = await GitHooks.check(index.root, rendered)
  return { mode: "check", clean: report.clean, entries: report.entries }
}

/** Plans one verb and executes it unless `--plan` asked for the inert print. */
const runVerb = async (
  verb: "build" | "test" | "lint" | "run" | "docs",
  pattern: string,
  flags: ExecutionFlags & ModeFlags,
  config: RuntimeConfig,
  reporter: Reporter.Reporter
): Promise<Planner.Plan | Executor.Summary | PackageExec.PlanReport> => {
  if (verb === "docs") {
    await refusePackageMode(flags, verb)
  } else {
    const packaged = await runPackageVerb(verb, pattern, flags, config, reporter)
    if (packaged !== undefined) return packaged
  }
  const { remoteCache, workspace } = await openWorkspace(flags, config, !flags.plan)
  const plan = await Planner.make(workspace, verb, pattern)
  if (flags.plan) return plan
  return Executor.execute({
    workspace,
    verb,
    pattern,
    targets: plan.targets,
    jobs: flags.jobs,
    readCache: flags.cache,
    remoteCache,
    signal: config.signal,
    packageName: "name" in flags && typeof flags.name === "string" ? flags.name : undefined,
    reporter
  })
}

/**
 * The verbs `ci` merges, LINT FIRST.
 *
 * `mergePlans` deduplicates on label and first occurrence wins, so the plan a
 * target contributes to `ci` is the one from the first verb that selected it.
 * A generator target participates in both `build` and `lint`, and its `lint`
 * form is the non-mutating one (`attrsForKind` maps write to check). Planning
 * `build` first therefore made `smthrs ci` rewrite checked-in package
 * manifests and workflow files as a side effect of asking whether the
 * repository was green. Lint first makes the merged graph the checking form,
 * which is the only correct posture for a CI verb.
 */
const ciKinds = ["lint", "build", "test", "docs"] as const

/** Plans every CI-safe verb over one pattern and executes the merged graph. */
const runCi = async (
  pattern: string,
  flags: ExecutionFlags,
  config: RuntimeConfig,
  reporter: Reporter.Reporter
): Promise<CiPlan | Executor.Summary> => {
  await refusePackageMode(flags, "ci")
  const { remoteCache, workspace } = await openWorkspace(flags, config, !flags.plan)
  const plans: Array<Planner.Plan> = []
  const refusals: Array<unknown> = []
  for (const kind of ciKinds) {
    try {
      plans.push(await Planner.make(workspace, kind, pattern))
    } catch (cause) {
      // An exact label that does not participate in one of the CI kinds is
      // fine as long as it participates in another; any other planning error
      // is real and propagates.
      if (cause instanceof Planner.UnsupportedVerbError && cause.verb === kind) refusals.push(cause)
      else throw cause
    }
  }
  if (plans.length === 0) throw refusals[0] ?? new Error(`no targets selected by ${pattern}`)
  const merged = Executor.mergePlans(plans)
  if (flags.plan) return { verb: "ci", pattern, ...merged }
  return Executor.execute({
    workspace,
    verb: "ci",
    pattern,
    targets: merged.targets,
    jobs: flags.jobs,
    readCache: flags.cache,
    remoteCache,
    signal: config.signal,
    reporter
  })
}

/** Every outcome an execution command can return before settling. */
type Outcome = Planner.Plan | CiPlan | Executor.Summary | PackageExec.PlanReport

/** Whether an outcome is an execution summary rather than an inert plan. */
const isSummary = (outcome: Outcome): outcome is Executor.Summary => "ok" in outcome

/** Whether an outcome is an execution summary that went red. */
const failedSummary = (outcome: Outcome): outcome is Executor.Summary => isSummary(outcome) && !outcome.ok

const failureMessage = (summary: Executor.Summary): string =>
  `${summary.counts.failed} of ${summary.results.length} targets failed` +
  (summary.counts.skipped === 0 ? "" : ` (${summary.counts.skipped} skipped)`)

/**
 * Turns an execution outcome into the command's return.
 *
 * A red summary is the structured `targets_failed` error, unless a human
 * renderer already told a person what failed, in which case only the exit
 * code remains to record. A green summary is the envelope's data, unless the
 * same renderer already drew it, in which case standard output stays empty.
 * An inert plan is always data.
 */
const settle = <A extends Outcome>(
  context: Presentation & { readonly error: ErrorResult },
  config: RuntimeConfig,
  reporter: Reporter.Reporter,
  outcome: A
): A | undefined => {
  const people = forPeople(context, reporter.renderer)
  if (failedSummary(outcome)) {
    if (people && config.exit !== undefined) {
      config.exit(1)
      return undefined
    }
    return context.error({
      code: "targets_failed",
      exitCode: 1,
      message: failureMessage(outcome),
      retryable: false
    })
  }
  if (people && isSummary(outcome)) return undefined
  return outcome
}

/**
 * Runs one execution command under a reporter that is closed however the
 * run ends, so a live renderer always hands the terminal back.
 */
const executeCommand = async <A extends Outcome>(
  context: Presentation & { readonly error: ErrorResult },
  config: RuntimeConfig,
  code: string,
  body: (reporter: Reporter.Reporter) => Promise<A>
): Promise<A | undefined> => {
  const reporter = reporterFor(context, config)
  let outcome: A
  try {
    outcome = await body(reporter)
  } catch (cause) {
    return context.error({ code, exitCode: 1, message: Diagnostic.message(cause) })
  } finally {
    reporter.close()
  }
  return settle(context, config, reporter, outcome)
}

/**
 * Creates the configured smthrs CLI.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeCli = (config: RuntimeConfig = {}) =>
  Cli.create("smthrs", {
    description: "Execute BUILD.ts targets and install pnpm workspaces with flows",
    version: "0.1.0",
    globals: globalOptions
  })
    .command("install", {
      description: "Plan and execute the pnpm install Flow",
      options: workspaceOption,
      alias: { workspace: "w" },
      async run(context) {
        try {
          await refusePackageMode(context.options, "install")
          const prepared = await prepare(context.options, config)
          return await runInstall(prepared.root, {
            cacheDirectory: prepared.cacheDirectory,
            sensitiveEnvironment: prepared.remoteCache === undefined
              ? []
              : [prepared.remoteCache.tokenEnv],
            signal: config.signal
          })
        } catch (cause) {
          return context.error({
            code: "install_failed",
            exitCode: 1,
            message: Diagnostic.message(cause),
            retryable: false
          })
        }
      }
    })
    .command("build", {
      description: "Execute the build targets selected by a pattern",
      args: patternArgument,
      options: executionOptions,
      alias: executionAlias,
      run: (context) =>
        executeCommand(
          context,
          config,
          "build_failed",
          (reporter) => runVerb("build", context.args.pattern, context.options, config, reporter)
        )
    })
    .command("test", {
      description: "Execute the test targets selected by a pattern",
      args: patternArgument,
      options: executionOptions,
      alias: executionAlias,
      run: (context) =>
        executeCommand(
          context,
          config,
          "test_failed",
          (reporter) => runVerb("test", context.args.pattern, context.options, config, reporter)
        )
    })
    .command("lint", {
      description: "Execute the lint targets selected by a pattern",
      args: patternArgument,
      options: executionOptions.extend({
        fix: z.boolean().default(false).describe("Apply agent lint fixes inside the declared fixes write-set")
      }),
      alias: executionAlias,
      run: (context) =>
        executeCommand(
          context,
          config,
          "lint_failed",
          (reporter) => runVerb("lint", context.args.pattern, context.options, config, reporter)
        )
    })
    .command("docs", {
      description: "Execute the documentation-parity targets selected by a pattern",
      args: patternArgument,
      options: executionOptions,
      alias: executionAlias,
      run: (context) =>
        executeCommand(
          context,
          config,
          "docs_failed",
          (reporter) => runVerb("docs", context.args.pattern, context.options, config, reporter)
        )
    })
    .command("run", {
      description: "Execute run targets selected by a pattern",
      args: patternArgument,
      options: runOptions,
      alias: { ...executionAlias, ...invocationAlias, name: "n" },
      run: (context) =>
        executeCommand(
          context,
          config,
          "run_failed",
          (reporter) => runVerb("run", context.args.pattern, context.options, config, reporter)
        )
    })
    .command("target", {
      description: "Execute one package-mode label with its flavor-implied verb (the bare-label form)",
      args: patternArgument,
      options: executionOptions.extend({
        write: z.boolean().default(false).describe("Apply Diff/Generate/CiGen targets instead of checking drift"),
        fix: z.boolean().default(false).describe("Apply agent lint fixes inside the declared fixes write-set"),
        ...invocationOptions
      }),
      alias: { ...executionAlias, ...invocationAlias },
      run: (context) =>
        executeCommand(context, config, "target_failed", async (reporter) => {
          const outcome = await runPackageVerb("auto", context.args.pattern, context.options, config, reporter)
          if (outcome === undefined) {
            throw new Error("the bare-label form executes PACKAGE.ts targets; this workspace has no WORKSPACE.ts")
          }
          return outcome
        })
    })
    .command("gitHooks", {
      description: "Check the WORKSPACE.ts gitHooks scripts against .git/hooks, or install them with --write",
      options: workspaceOption.extend({
        write: z.boolean().default(false).describe("Install the rendered hook scripts into .git/hooks")
      }),
      alias: { workspace: "w" },
      async run(context) {
        let outcome: Awaited<ReturnType<typeof runGitHooks>>
        try {
          outcome = await runGitHooks(context.options, config)
        } catch (cause) {
          return context.error({ code: "git_hooks_failed", exitCode: 1, message: Diagnostic.message(cause) })
        }
        if (outcome.mode === "check" && !outcome.clean) {
          return context.error({
            code: "git_hooks_drift",
            exitCode: 1,
            message: `git hooks drift (run with --write to install): ${
              outcome.entries.filter((entry) => entry.status !== "clean").map((entry) =>
                `${entry.file}=${entry.status}`
              )
                .join(", ")
            }`,
            retryable: false
          })
        }
        return outcome
      }
    })
    .command("ci", {
      description: "Execute build, test, lint, and documentation targets over one merged graph",
      args: patternArgument,
      options: executionOptions,
      alias: executionAlias,
      run: (context) =>
        executeCommand(
          context,
          config,
          "ci_failed",
          (reporter) => runCi(context.args.pattern, context.options, config, reporter)
        )
    })
    .command("query", {
      description: "List labels or evaluate deps(label)",
      args: z.object({ expr: z.string().describe("Label, pattern, or deps(label)") }),
      options: workspaceOption,
      alias: { workspace: "w" },
      async run(context) {
        try {
          const index = await openPackageIndex(context.options, config)
          let result: Query.Listing | Query.Dependencies
          if (index !== undefined) {
            result = packageQuery(index, context.args.expr)
          } else {
            const { workspace } = await openWorkspace(context.options, config, false)
            result = await Query.run(workspace, context.args.expr)
          }
          return present(context, config, result, (style) => Query.text(result, style))
        } catch (cause) {
          return context.error({ code: "query_failed", exitCode: 1, message: Diagnostic.message(cause) })
        }
      }
    })
    .command("graph", {
      description: "Print the target graph without executing it",
      args: patternArgument,
      options: workspaceOption.extend({
        mermaid: z.boolean().default(false).describe("Render Mermaid instead of a text tree")
      }),
      alias: { workspace: "w", mermaid: "m" },
      async run(context) {
        try {
          const index = await openPackageIndex(context.options, config)
          if (index !== undefined) {
            const { data, edges, rows } = packageGraph(index, context.args.pattern)
            if (context.options.mermaid) return data
            return present(context, config, data, (style) => GraphOutput.packageText(rows, edges, style))
          }
          const { workspace } = await openWorkspace(context.options, config, false)
          const plan = await Planner.make(workspace, "graph", context.args.pattern)
          const data = {
            pattern: context.args.pattern,
            format: context.options.mermaid ? "mermaid" : "text",
            graph: context.options.mermaid ? GraphOutput.mermaid(plan) : GraphOutput.text(plan),
            roots: plan.roots,
            targets: plan.targets.map((target) => ({ label: target.label, target: target.target })),
            edges: plan.edges,
            warnings: plan.warnings
          }
          // Mermaid is meant for a file or a renderer, never a terminal.
          if (context.options.mermaid) return data
          return present(context, config, data, (style) => GraphOutput.text(plan, style))
        } catch (cause) {
          return context.error({ code: "graph_failed", exitCode: 1, message: Diagnostic.message(cause) })
        }
      }
    })

/**
 * Rewrites a bare-label argv into the `target` command.
 *
 * `smthrs '//src:lint'` — a first argument that is a label rather than a
 * command — executes the label under its flavor-implied verb. Every other
 * argv passes through unchanged.
 *
 * @category parsing
 * @since 0.1.0
 * @slop
 */
export const normalizeArgv = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const first = argv[0]
  if (first !== undefined && (first.startsWith("//") || first.startsWith(":"))) {
    return ["target", ...argv]
  }
  return argv
}

/**
 * Programmatic CLI without process-scoped remote cache or interruption state.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const cli = makeCli()
