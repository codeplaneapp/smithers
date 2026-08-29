/**
 * Renders `Github.CiGen` declarations into GitHub Actions files.
 *
 * One `Github.CiGen` target owns a deterministic file set under its declaring
 * package directory (`.github` in the Force layout): one workflow YAML per
 * declared `Github.Workflow`, plus the shared composite setup action every
 * generated job starts with. Rendering is a pure function of the validated
 * declarations, the workspace toolchain declaration, and the package index's
 * labels — the same inputs produce the same bytes on every host and from
 * every working directory.
 *
 * `check` byte-compares the rendered set against the checked-in tree and is
 * the CiGen target's lint form; `write` publishes the rendered set
 * atomically. Hand-written files named in `preserve` are never written,
 * never deleted, and never reported as drift. Files inside the declared
 * `changes` write-set that the renderer no longer produces are stale
 * generated output: drift under `check`, removed under `write`. The renderer
 * refuses to write outside the declared write-set.
 *
 * @since 0.1.0
 */
import * as CronTarget from "@smthrs/targets/CronTarget"
import * as GithubTarget from "@smthrs/targets/GithubTarget"
import * as PackageManager from "@smthrs/targets/PackageManager"
import * as Runtime from "@smthrs/targets/Runtime"
import * as Target from "@smthrs/targets/Target"
import * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import * as NodeCrypto from "node:crypto"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"

/**
 * The refusal codes one render, check, or write can fail with.
 *
 * @category models
 * @since 0.1.0
 */
export type ErrorCode =
  | "unlabeled_cigen"
  | "not_a_workflow"
  | "not_a_setup"
  | "invalid_workflow_name"
  | "duplicate_workflow_name"
  | "multiple_setups"
  | "unlabeled_run_target"
  | "duplicate_job_id"
  | "invalid_event_name"
  | "invalid_schedule"
  | "invalid_path"
  | "preserve_conflict"
  | "outside_write_set"
  | "write_failed"

/**
 * One typed CI-generation refusal.
 *
 * @category errors
 * @since 0.1.0
 */
export class GithubRenderError extends Error {
  override readonly name = "GithubRenderError"
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.code = code
  }
}

/**
 * Checks whether a value is a CI-generation refusal.
 *
 * @category guards
 * @since 0.1.0
 */
export const isGithubRenderError = (value: unknown): value is GithubRenderError => value instanceof GithubRenderError

/**
 * The one fact the renderer needs from the package index: a target's label.
 *
 * `PackageIndex` satisfies this shape structurally; tests may substitute a
 * map-backed fake.
 *
 * @category models
 * @since 0.1.0
 */
export interface LabelResolver {
  labelOf(target: Target.AnyTarget): string | undefined
  targets?(): ReadonlyArray<{ readonly label: string; readonly target: Target.AnyTarget }>
}

/**
 * One rendered file: a package-directory-relative POSIX path and its bytes.
 *
 * @category models
 * @since 0.1.0
 */
export interface RenderedFile {
  readonly path: string
  readonly content: string
}

/**
 * The complete rendered output of one `Github.CiGen` target.
 *
 * @category models
 * @since 0.1.0
 */
export interface CiRender {
  /** The CiGen target's own label, named in every generated header. */
  readonly label: string
  /** The workspace-relative package directory the paths resolve against. */
  readonly packageDir: string
  /** Every generated file, sorted by path. */
  readonly files: ReadonlyArray<RenderedFile>
  /** Hand-written paths the generator must never touch. */
  readonly preserve: ReadonlyArray<string>
  /** The declared write-set globs, package-directory-relative. */
  readonly changes: ReadonlyArray<string>
}

// ---------------------------------------------------------------------------
// YAML scalar rendering
// ---------------------------------------------------------------------------

/** Control characters a rendered value may not carry. */
const controlCharacter = /[\u0000-\u0008\u000B-\u001F\u007F]/

/** Characters a plain (unquoted) YAML scalar may carry here. */
const plainScalar = /^[A-Za-z0-9][A-Za-z0-9 ._/@:+'-]*$/

const yamlBoolean = /^(?:y|Y|yes|Yes|YES|n|N|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/
const yamlNull = /^(?:~|null|Null|NULL)$/
const yamlNumber =
  /^[-+]?(?:0b[01_]+|0o[0-7_]+|0x[0-9a-fA-F_]+|0[0-7_]+|[0-9][0-9_]*(?::[0-5]?[0-9])+(?:\.[0-9_]*)?|(?:[0-9][0-9_]*)?\.[0-9_]*(?:[eE][-+]?[0-9]+)?|[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?)$/
const yamlInfinity = /^[-+]?\.(?:inf|Inf|INF|nan|NaN|NAN)$/
const yamlTimestamp = /^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:[Tt ].*)?$/

/** Whether a plain scalar would resolve to something other than a string. */
const resolvesToNonString = (value: string): boolean =>
  yamlBoolean.test(value) || yamlNull.test(value) || yamlNumber.test(value) ||
  yamlInfinity.test(value) || yamlTimestamp.test(value)

/**
 * Quotes a scalar unless YAML reads it back as exactly the declared string.
 *
 * `JSON.stringify` emits a YAML double-quoted scalar whose escape set agrees
 * with JSON's for every character that can appear here, so the quoted form
 * always reads back byte-identical.
 */
const scalar = (value: string): string => {
  if (controlCharacter.test(value)) {
    throw new GithubRenderError("invalid_path", `${JSON.stringify(value)} contains a control character`)
  }
  return plainScalar.test(value) &&
      !value.includes(": ") && !value.endsWith(":") && !/\s$/.test(value) &&
      !resolvesToNonString(value)
    ? value
    : JSON.stringify(value)
}

/** Renders a `with:` map, keys and values both through {@link scalar}. */
const mapping = (entries: Readonly<Record<string, string>>, indent: string): ReadonlyArray<string> =>
  Object.entries(entries).map(([key, value]) => `${indent}${scalar(key)}: ${scalar(value)}`)

// ---------------------------------------------------------------------------
// Declaration projection helpers
// ---------------------------------------------------------------------------

/** Strips the workspace-label prefix from a declared file path. */
const workspacePath = (path: string): string => path.startsWith("//") ? path.slice(2) : path

/**
 * The toolchain facts the composite setup action renders from.
 *
 * Every JavaScript field is optional because a workspace may have no
 * JavaScript in it: a Cargo workspace declares `toolchains` instead of the
 * runtime/packageManager/nodeModules trio, and its setup action installs a
 * Rust toolchain and nothing else. A workspace that declares both renders
 * both, in the order the fields appear here.
 */
interface Toolchain {
  /** `node-version` / `node-version-file` (exclusive) for setup-node, or bun. */
  readonly runtime:
    | { readonly kind: "node-version"; readonly version: string }
    | { readonly kind: "node-version-file"; readonly file: string }
    | { readonly kind: "bun"; readonly version: string }
    | { readonly kind: "go"; readonly file: string }
    | undefined
  /** The declared Rust toolchain layer, as the pin `dtolnay/rust-toolchain` reads. */
  readonly rust: { readonly channel: string | undefined; readonly file: string | undefined } | undefined
  /** The extra action that installs the package manager itself, if any. */
  readonly managerAction: { readonly uses: string; readonly with?: Readonly<Record<string, string>> } | undefined
  /** The package-manager store the cache step saves, absent without one. */
  readonly store:
    | { readonly path: string; readonly prefix: string; readonly lockfile: string; readonly install: string }
    | undefined
  /** The argv prefix that runs a workspace-local binary. */
  readonly exec: ReadonlyArray<string>
}

/** The Rust layer facts, or undefined for a workspace that declares none. */
const rustFacts = (workspace: WorkspaceDeclaration.WorkspaceDeclaration): Toolchain["rust"] => {
  const layer = WorkspaceDeclaration.rustToolchain(workspace)
  if (layer === undefined) return undefined
  return {
    channel: layer.channel,
    file: layer.toolchain === undefined ? undefined : workspacePath(layer.toolchain.path)
  }
}

const runtimeFacts = (
  runtime: Runtime.Runtime | Runtime.NodeDeclaration | Runtime.BunDeclaration
): Toolchain["runtime"] => {
  if (Runtime.isBunDeclaration(runtime)) return { kind: "bun", version: runtime.version }
  if ("name" in runtime && runtime.name === "bun") return { kind: "bun", version: runtime.version }
  if ("name" in runtime && runtime.name === "node") return { kind: "node-version", version: runtime.version }
  // The WORKSPACE.ts NodeDeclaration: an exclusive version | manifest union.
  return runtime.manifest !== undefined
    ? { kind: "node-version-file", file: workspacePath(runtime.manifest.path) }
    : { kind: "node-version", version: runtime.version ?? "" }
}

const toolchainOf = (workspace: WorkspaceDeclaration.WorkspaceDeclaration): Toolchain => {
  const rust = rustFacts(workspace)
  const manager = workspace.packageManager
  if (workspace.runtime === undefined || manager === undefined) {
    const go = workspace.toolchains?.find((entry) => entry._tag === "GoToolchain") as
      | { readonly mod?: { readonly path?: string } }
      | undefined
    return {
      runtime: go === undefined ? undefined : { kind: "go", file: workspacePath(go.mod?.path ?? "go.mod") },
      rust,
      managerAction: undefined,
      store: undefined,
      exec: ["smthrs"]
    }
  }
  const runtime = runtimeFacts(workspace.runtime)
  if (PackageManager.isYarnDeclaration(manager)) {
    return {
      runtime,
      rust,
      managerAction: undefined,
      store: {
        path: "~/.cache/yarn",
        prefix: "yarn-store-",
        lockfile: workspacePath(manager.lockfile.path),
        install: "yarn install --frozen-lockfile"
      },
      exec: ["yarn", "exec", "smthrs"]
    }
  }
  if (PackageManager.isPnpmDeclaration(manager)) {
    // Workspace-era pnpm: the runtime comes from the workspace like yarn's,
    // and pnpm/action-setup reads the manifest's packageManager field when
    // the declaration carries no version pin.
    return {
      runtime,
      rust,
      managerAction: {
        uses: "pnpm/action-setup@v4",
        ...(manager.version === undefined ? {} : { with: { version: manager.version } })
      },
      store: {
        path: "~/.pnpm-store",
        prefix: "pnpm-store-",
        lockfile: workspacePath(manager.lockfile.path),
        install: "pnpm install --frozen-lockfile"
      },
      exec: ["pnpm", "exec", "smthrs"]
    }
  }
  switch (manager.name) {
    case "pnpm":
      return {
        runtime,
        rust,
        managerAction: { uses: "pnpm/action-setup@v4", with: { version: manager.version } },
        store: {
          path: "~/.pnpm-store",
          prefix: "pnpm-store-",
          lockfile: PackageManager.lockfileName(manager),
          install: "pnpm install --frozen-lockfile"
        },
        exec: ["pnpm", "exec", "smthrs"]
      }
    case "bun":
      return {
        runtime,
        rust,
        managerAction: { uses: "oven-sh/setup-bun@v2" },
        store: {
          path: "~/.bun/install/cache",
          prefix: "bun-store-",
          lockfile: PackageManager.lockfileName(manager),
          install: "bun install --frozen-lockfile"
        },
        exec: ["bun", "x", "smthrs"]
      }
  }
}

// ---------------------------------------------------------------------------
// Composite setup action
// ---------------------------------------------------------------------------

const header = (label: string): string =>
  `# Generated by smthrs from ${label}. Do not edit; run: smthrs ${label} --write`

/** Renders the shared composite setup action for one `Github.Setup` target. */
const renderSetupAction = (
  label: string,
  setup: (typeof GithubTarget.SetupAttrs)["Type"],
  workspace: WorkspaceDeclaration.WorkspaceDeclaration
): string => {
  const toolchain = toolchainOf(workspace)
  const lines: Array<string> = [header(label)]
  lines.push("name: setup")
  lines.push("description: Install the workspace toolchain and connect the smithers remote cache.")
  const inputs: Array<{ readonly name: string; readonly env: string }> = []
  if (setup.cacheUrl !== undefined) inputs.push({ name: "cache-url", env: setup.cacheUrl.env })
  if (setup.cacheToken !== undefined) inputs.push({ name: "cache-token", env: setup.cacheToken.env })
  if (inputs.length > 0) {
    lines.push("inputs:")
    for (const input of inputs) {
      lines.push(`  ${input.name}:`)
      lines.push(`    description: Exported to the job environment as ${input.env}.`)
      lines.push("    required: false")
      lines.push("    default: \"\"")
    }
  }
  lines.push("runs:")
  lines.push("  using: composite")
  lines.push("  steps:")
  if (toolchain.managerAction !== undefined) {
    lines.push(`    - uses: ${scalar(toolchain.managerAction.uses)}`)
    if (toolchain.managerAction.with !== undefined) {
      lines.push("      with:", ...mapping(toolchain.managerAction.with, "        "))
    }
  }
  switch (toolchain.runtime?.kind) {
    case "node-version":
      lines.push("    - uses: actions/setup-node@v4")
      lines.push("      with:", ...mapping({ "node-version": toolchain.runtime.version }, "        "))
      break
    case "node-version-file":
      lines.push("    - uses: actions/setup-node@v4")
      lines.push("      with:", ...mapping({ "node-version-file": toolchain.runtime.file }, "        "))
      break
    case "bun":
      // setup-bun installed the runtime above; nothing further to declare.
      break
    case "go":
      lines.push("    - uses: actions/setup-go@v6")
      lines.push("      with:", ...mapping({ "go-version-file": toolchain.runtime.file }, "        "))
      break
    case undefined:
      // A toolchain-only workspace: nothing to install for JavaScript.
      break
  }
  if (toolchain.rust !== undefined) {
    // The declared layer is the pin: the channel when the workspace names one,
    // and the pin file otherwise, which the action reads on its own.
    lines.push("    - uses: dtolnay/rust-toolchain@stable")
    if (toolchain.rust.channel !== undefined) {
      lines.push("      with:", ...mapping({ toolchain: toolchain.rust.channel }, "        "))
    }
  }
  if (toolchain.store !== undefined) {
    lines.push("    - uses: actions/cache@v4")
    lines.push(
      "      with:",
      ...mapping({
        path: toolchain.store.path,
        key: `${toolchain.store.prefix}\${{ hashFiles('${toolchain.store.lockfile}') }}`,
        "restore-keys": toolchain.store.prefix
      }, "        ")
    )
    lines.push(`    - run: ${scalar(toolchain.store.install)}`)
    lines.push("      shell: bash")
  }
  if (inputs.length > 0) {
    lines.push("    - run: |")
    lines.push("        if [ -n \"${{ inputs.cache-url }}\" ]; then")
    for (const input of inputs) {
      lines.push(`          echo "${input.env}=\${{ inputs.${input.name} }}" >> "$GITHUB_ENV"`)
    }
    lines.push("        fi")
    lines.push("      shell: bash")
  }
  return `${lines.join("\n")}\n`
}

// ---------------------------------------------------------------------------
// Workflow rendering
// ---------------------------------------------------------------------------

/** The file-name grammar a declared workflow name must satisfy. */
const workflowName = /^[A-Za-z0-9_-]+$/

/** The event-name grammar the `cancelInProgress` sugar accepts. */
const eventName = /^[a-z][a-z_]*$/

/** Five whitespace-separated fields; GitHub validates the field contents. */
const cronExpression = /^\S+ \S+ \S+ \S+ \S+$/

/** GitHub job ids must start with a letter or `_`. */
const jobIdStart = /^[A-Za-z_]/

/** Derives a deterministic GitHub job id from a target label. */
const jobIdOf = (label: string): string => {
  const mangled = label.slice(2).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
  return jobIdStart.test(mangled) ? mangled : `run-${mangled}`
}

/** Largest Shell.Test shard fan-out reachable from one workflow run root. */
const shardCountOf = (target: Target.AnyTarget, seen = new Set<Target.AnyTarget>()): number => {
  if (seen.has(target)) return 1
  seen.add(target)
  const metadata = Target.metadata(target)
  const direct =
    metadata.target === "Shell.Test" && typeof (metadata.attrs as { readonly shards?: unknown }).shards === "number"
      ? (metadata.attrs as { readonly shards: number }).shards
      : 1
  return Math.max(direct, ...metadata.dependencies.map((dependency) => shardCountOf(dependency, seen)))
}

/**
 * The single provisional CLI flag a generated affected workflow passes: the
 * merge-base of the checked-out head and the pull request's base branch.
 * The spelling is pinned by the goldens and owned by the CLI integration.
 */
const affectedSuffix = " --affected-base \"$(git merge-base HEAD \"origin/${GITHUB_BASE_REF:-main}\")\""

/** Renders one workflow YAML for a validated `Github.Workflow` target. */
const renderWorkflow = (
  label: string,
  packageDir: string,
  workflow: (typeof GithubTarget.WorkflowAttrs)["Type"],
  runs: ReadonlyArray<{ readonly label: string; readonly target: Target.AnyTarget }>,
  setup: (typeof GithubTarget.SetupAttrs)["Type"] | undefined,
  toolchain: Toolchain
): string => {
  const lines: Array<string> = [header(label)]
  lines.push(`name: ${scalar(workflow.name)}`)
  lines.push("on:")
  if (workflow.on.pullRequest === true) lines.push("  pull_request:")
  if (typeof workflow.on.pullRequest === "object") {
    lines.push("  pull_request:")
    if (workflow.on.pullRequest.branches !== undefined) {
      lines.push("    branches:")
      for (const branch of workflow.on.pullRequest.branches) lines.push(`      - ${scalar(branch)}`)
    }
    if (workflow.on.pullRequest.types !== undefined) {
      lines.push("    types:")
      for (const activity of workflow.on.pullRequest.types) lines.push(`      - ${scalar(activity)}`)
    }
  }
  if (workflow.on.issues !== undefined) {
    lines.push("  issues:")
    if (workflow.on.issues.types !== undefined) {
      lines.push("    types:")
      for (const activity of workflow.on.issues.types) lines.push(`      - ${scalar(activity)}`)
    }
  }
  if (workflow.on.push !== undefined) {
    lines.push("  push:")
    lines.push("    branches:")
    for (const branch of workflow.on.push.branches) lines.push(`      - ${scalar(branch)}`)
  }
  if (workflow.on.schedule !== undefined) {
    lines.push("  schedule:")
    for (const cron of workflow.on.schedule) {
      if (!cronExpression.test(cron)) {
        throw new GithubRenderError(
          "invalid_schedule",
          `schedule ${JSON.stringify(cron)} is not a five-field cron expression`
        )
      }
      lines.push(`    - cron: ${scalar(cron)}`)
    }
  }
  if (workflow.on.release !== undefined) {
    lines.push("  release:")
    lines.push("    types:")
    for (const activity of workflow.on.release) lines.push(`      - ${scalar(activity)}`)
  }
  if (workflow.on.workflowDispatch === true) lines.push("  workflow_dispatch:")
  if (typeof workflow.on.workflowDispatch === "object") {
    lines.push("  workflow_dispatch:")
    const inputs = Object.entries(workflow.on.workflowDispatch.inputs)
    if (inputs.length > 0) lines.push("    inputs:")
    for (const [name, input] of inputs) {
      lines.push(`      ${name}:`)
      if (input.description !== undefined) lines.push(`        description: ${scalar(input.description)}`)
      if (input.required !== undefined) lines.push(`        required: ${input.required ? "true" : "false"}`)
      if (input.default !== undefined) {
        const value = typeof input.default === "string" ? scalar(input.default) : String(input.default)
        lines.push(`        default: ${value}`)
      }
      if (input.type !== undefined) lines.push(`        type: ${input.type}`)
      if (input.options !== undefined) {
        lines.push("        options:")
        for (const option of input.options) lines.push(`          - ${scalar(option)}`)
      }
    }
  }
  if (workflow.concurrency !== undefined) {
    lines.push("concurrency:")
    lines.push(`  group: ${scalar(workflow.concurrency.group)}`)
    const cancel = workflow.concurrency.cancelInProgress
    if (typeof cancel === "boolean") {
      lines.push(`  cancel-in-progress: ${cancel ? "true" : "false"}`)
    } else {
      if (!eventName.test(cancel)) {
        throw new GithubRenderError(
          "invalid_event_name",
          `cancelInProgress ${JSON.stringify(cancel)} is neither a boolean nor an event name`
        )
      }
      lines.push(`  cancel-in-progress: \${{ github.event_name == '${cancel}' }}`)
    }
  }
  if (workflow.permissions !== undefined) {
    lines.push("permissions:")
    lines.push(...mapping(workflow.permissions, "  "))
  }
  if (workflow.env !== undefined) {
    lines.push("env:")
    lines.push(...mapping(workflow.env, "  "))
  }
  lines.push("jobs:")
  const seen = new Set<string>()
  for (const run of runs) {
    const runLabel = run.label
    const shards = shardCountOf(run.target)
    const jobId = jobIdOf(runLabel)
    if (seen.has(jobId)) {
      throw new GithubRenderError(
        "duplicate_job_id",
        `two run entries of workflow ${workflow.name} derive one job id ${jobId}`
      )
    }
    seen.add(jobId)
    lines.push(`  ${jobId}:`)
    if (workflow.jobName !== undefined) lines.push(`    name: ${scalar(workflow.jobName)}`)
    if (workflow.condition !== undefined) lines.push(`    if: ${scalar(workflow.condition)}`)
    lines.push(`    runs-on: ${scalar(workflow.runsOn ?? "ubuntu-latest")}`)
    if (shards > 1) {
      lines.push("    strategy:")
      lines.push("      matrix:")
      lines.push(`        shard: [${Array.from({ length: shards }, (_, index) => index + 1).join(", ")}]`)
      lines.push(`        total-shards: [${shards}]`)
      lines.push("    env:")
      lines.push("      SMTHRS_SHARD: \"${{ matrix.shard }}/${{ matrix.total-shards }}\"")
    }
    if (workflow.environment !== undefined) lines.push(`    environment: ${scalar(workflow.environment)}`)
    lines.push("    steps:")
    lines.push("      - uses: actions/checkout@v4")
    if (workflow.affected === true) {
      lines.push("        with:", ...mapping({ "fetch-depth": "0" }, "          "))
    }
    if (setup !== undefined) {
      lines.push(`      - uses: ./${packageDir}/actions/setup`)
      const withEntries: Record<string, string> = {}
      if (setup.cacheUrl !== undefined) withEntries["cache-url"] = `\${{ secrets.${setup.cacheUrl.env} }}`
      if (setup.cacheToken !== undefined) withEntries["cache-token"] = `\${{ secrets.${setup.cacheToken.env} }}`
      if (Object.keys(withEntries).length > 0) {
        lines.push("        with:", ...mapping(withEntries, "          "))
      }
    }
    const command = [...toolchain.exec, `'${runLabel}'`].join(" ") +
      (workflow.affected === true ? affectedSuffix : "")
    lines.push(`      - run: ${scalar(command)}`)
  }
  if (workflow.steps !== undefined) {
    const jobId = jobIdOf(`//:${workflow.name}`)
    if (seen.has(jobId)) {
      throw new GithubRenderError(
        "duplicate_job_id",
        `custom steps for workflow ${workflow.name} collide with ${jobId}`
      )
    }
    lines.push(`  ${jobId}:`)
    if (workflow.jobName !== undefined) lines.push(`    name: ${scalar(workflow.jobName)}`)
    if (workflow.condition !== undefined) lines.push(`    if: ${scalar(workflow.condition)}`)
    lines.push(`    runs-on: ${scalar(workflow.runsOn ?? "ubuntu-latest")}`)
    if (workflow.environment !== undefined) lines.push(`    environment: ${scalar(workflow.environment)}`)
    lines.push("    steps:")
    for (const step of workflow.steps) {
      if (step.name !== undefined) lines.push(`      - name: ${scalar(step.name)}`)
      else if ("uses" in step) lines.push(`      - uses: ${scalar(step.uses)}`)
      else lines.push(`      - run: ${scalar(step.run)}`)
      const propertyIndent = step.name === undefined ? "        " : "        "
      if (step.name !== undefined) {
        if ("uses" in step) lines.push(`${propertyIndent}uses: ${scalar(step.uses)}`)
        else lines.push(`${propertyIndent}run: ${scalar(step.run)}`)
      }
      if (step.id !== undefined) lines.push(`${propertyIndent}id: ${scalar(step.id)}`)
      if (step.if !== undefined) lines.push(`${propertyIndent}if: ${scalar(step.if)}`)
      if ("shell" in step && step.shell !== undefined) lines.push(`${propertyIndent}shell: ${scalar(step.shell)}`)
      if ("workingDirectory" in step && step.workingDirectory !== undefined) {
        lines.push(`${propertyIndent}working-directory: ${scalar(step.workingDirectory)}`)
      }
      if ("with" in step && step.with !== undefined) {
        lines.push(`${propertyIndent}with:`, ...mapping(step.with, `${propertyIndent}  `))
      }
      if (step.env !== undefined) lines.push(`${propertyIndent}env:`, ...mapping(step.env, `${propertyIndent}  `))
    }
  }
  return `${lines.join("\n")}\n`
}

// ---------------------------------------------------------------------------
// CiGen rendering
// ---------------------------------------------------------------------------

/** A package-directory-relative POSIX path, confined to the directory. */
const relativePath = (value: string, what: string): string => {
  const segments = value.split("/")
  if (
    value === "" || value.startsWith("/") || value.includes("\\") || value.includes("\0") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new GithubRenderError("invalid_path", `${what} ${JSON.stringify(value)} is not a confined relative path`)
  }
  return value
}

/**
 * Renders the complete file set one `Github.CiGen` target owns.
 *
 * @category rendering
 * @since 0.1.0
 */
export const render = (options: {
  readonly ciGen: Target.AnyTarget
  readonly workspace: WorkspaceDeclaration.WorkspaceDeclaration
  readonly resolve: LabelResolver
  readonly packageDir: string
}): CiRender => {
  const label = options.resolve.labelOf(options.ciGen)
  if (label === undefined) {
    throw new GithubRenderError("unlabeled_cigen", "the Github.CiGen target has no label; list it in a Package map")
  }
  const attrs = GithubTarget.ciGenAttrsOf(options.ciGen)
  const toolchain = toolchainOf(options.workspace)
  const workflowDirectory = (attrs.changes ?? [])
    .map((change) => change.replace(/\/\*\*$/, ""))
    .find((change) => change === "workflows" || change.endsWith("/workflows")) ?? "workflows"
  const files: Array<RenderedFile> = []
  const names = new Set<string>()
  let setupTarget: Target.AnyTarget | undefined
  for (const workflowTarget of attrs.workflows) {
    let workflow: (typeof GithubTarget.WorkflowAttrs)["Type"]
    try {
      workflow = GithubTarget.workflowAttrsOf(workflowTarget)
    } catch (cause) {
      throw new GithubRenderError(
        "not_a_workflow",
        `CiGen workflows entries must be Github.Workflow targets: ${
          cause instanceof Error ? cause.message : String(cause)
        }`
      )
    }
    if (!workflowName.test(workflow.name)) {
      throw new GithubRenderError(
        "invalid_workflow_name",
        `workflow name ${JSON.stringify(workflow.name)} is not usable as a file name`
      )
    }
    if (names.has(workflow.name)) {
      throw new GithubRenderError("duplicate_workflow_name", `two workflows declare the name ${workflow.name}`)
    }
    names.add(workflow.name)
    let setup: (typeof GithubTarget.SetupAttrs)["Type"] | undefined
    if (workflow.setup !== undefined) {
      if (setupTarget !== undefined && setupTarget !== workflow.setup) {
        throw new GithubRenderError(
          "multiple_setups",
          "the declared workflows name two distinct Github.Setup targets; share one"
        )
      }
      setupTarget = workflow.setup
      try {
        setup = GithubTarget.setupAttrsOf(workflow.setup)
      } catch (cause) {
        throw new GithubRenderError(
          "not_a_setup",
          `a workflow setup attr must be a Github.Setup target: ${
            cause instanceof Error ? cause.message : String(cause)
          }`
        )
      }
    }
    const runs = workflow.run.map((target) => {
      const runLabel = options.resolve.labelOf(target)
      if (runLabel === undefined) {
        throw new GithubRenderError(
          "unlabeled_run_target",
          `a run entry of workflow ${workflow.name} has no label; list it in a Package map`
        )
      }
      return { label: runLabel, target }
    })
    files.push({
      path: `${workflowDirectory}/${workflow.name}.yml`,
      content: renderWorkflow(label, options.packageDir, workflow, runs, setup, toolchain)
    })
  }
  // Cron is an inert package-level trigger declaration. A compact or expanded
  // CI generator in the same graph projects every labeled Cron into a normal
  // GitHub schedule workflow; no second scheduler or executor path exists.
  for (const row of options.resolve.targets?.() ?? []) {
    if (Target.metadata(row.target).target !== "Cron") continue
    const cron = CronTarget.attrsOf(row.target)
    const key = row.label.slice(row.label.lastIndexOf(":") + 1)
    const name = `cron-${key}`
    if (names.has(name)) {
      throw new GithubRenderError("duplicate_workflow_name", `Cron ${row.label} collides with workflow ${name}`)
    }
    names.add(name)
    const run = [...(cron.refresh ?? []), ...cron.run]
    const runs = run.map((target) => {
      const runLabel = options.resolve.labelOf(target)
      if (runLabel === undefined) {
        throw new GithubRenderError(
          "unlabeled_run_target",
          `a run entry of Cron ${row.label} has no label; list it in a Package map`
        )
      }
      return { label: runLabel, target }
    })
    files.push({
      path: `${workflowDirectory}/${name}.yml`,
      content: renderWorkflow(
        label,
        options.packageDir,
        GithubTarget.WorkflowAttrs.make({ name, on: { schedule: [cron.schedule] }, run }),
        runs,
        undefined,
        toolchain
      )
    })
  }
  if (setupTarget !== undefined) {
    files.push({
      path: "actions/setup/action.yml",
      content: renderSetupAction(label, GithubTarget.setupAttrsOf(setupTarget), options.workspace)
    })
  }
  const preserve = (attrs.preserve ?? []).map((path) => relativePath(path, "preserve entry"))
  for (const file of files) {
    if (preserve.includes(file.path)) {
      throw new GithubRenderError(
        "preserve_conflict",
        `${file.path} is both rendered and preserved; rename the workflow or drop the preserve entry`
      )
    }
  }
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  return {
    label,
    packageDir: options.packageDir,
    files,
    preserve,
    changes: [...(attrs.changes ?? [])]
  }
}

// ---------------------------------------------------------------------------
// Check and write
// ---------------------------------------------------------------------------

/** Compiles one write-set glob (`*` within a segment, `**` across them). */
const globToRegExp = (glob: string): RegExp => {
  let source = "^"
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index]!
    if (character === "*") {
      if (glob[index + 1] === "*") {
        source += ".*"
        index += 1
      } else {
        source += "[^/]*"
      }
    } else if ("\\^$.|?+()[]{}".includes(character)) {
      source += `\\${character}`
    } else {
      source += character
    }
  }
  return new RegExp(`${source}$`)
}

/** Whether a relative path falls inside the declared write-set. */
const insideWriteSet = (changes: ReadonlyArray<RegExp>, path: string): boolean =>
  changes.some((pattern) => pattern.test(path))

/** Lists every regular file under a directory, as sorted relative POSIX paths. */
const listFiles = async (directory: string): Promise<ReadonlyArray<string>> => {
  const found: Array<string> = []
  const walk = async (current: string, prefix: string): Promise<void> => {
    let entries
    try {
      entries = await Fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) await walk(NodePath.join(current, entry.name), relative)
      else if (entry.isFile()) found.push(relative)
    }
  }
  await walk(directory, "")
  return found.sort()
}

/**
 * One file's drift classification.
 *
 * @category models
 * @since 0.1.0
 */
export type FileStatus = "clean" | "stale" | "missing" | "unexpected" | "preserved"

/**
 * One classified file row of a check report.
 *
 * @category models
 * @since 0.1.0
 */
export interface CheckEntry {
  readonly path: string
  readonly status: FileStatus
}

/**
 * The result of byte-comparing a rendered set against the checked-in tree.
 *
 * @category models
 * @since 0.1.0
 */
export interface CheckReport {
  readonly clean: boolean
  readonly entries: ReadonlyArray<CheckEntry>
}

/**
 * Byte-compares the rendered file set against the tree under `root`.
 *
 * A rendered file that matches is `clean`; different bytes are `stale`; an
 * absent file is `missing`. A file inside the declared write-set that is
 * neither rendered nor preserved is `unexpected` stale generated output.
 * Preserved files are reported `preserved` and never count as drift.
 *
 * @category checking
 * @since 0.1.0
 */
export const check = async (root: string, rendered: CiRender): Promise<CheckReport> => {
  const directory = NodePath.join(root, rendered.packageDir)
  const entries: Array<CheckEntry> = []
  for (const file of rendered.files) {
    let status: FileStatus
    try {
      const existing = await Fs.readFile(NodePath.join(directory, file.path), "utf8")
      status = existing === file.content ? "clean" : "stale"
    } catch {
      status = "missing"
    }
    entries.push({ path: file.path, status })
  }
  const patterns = rendered.changes.map(globToRegExp)
  const renderedPaths = new Set(rendered.files.map((file) => file.path))
  for (const path of await listFiles(directory)) {
    if (renderedPaths.has(path)) continue
    if (rendered.preserve.includes(path)) {
      entries.push({ path, status: "preserved" })
      continue
    }
    if (insideWriteSet(patterns, path)) entries.push({ path, status: "unexpected" })
  }
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  return {
    clean: entries.every((entry) => entry.status === "clean" || entry.status === "preserved"),
    entries
  }
}

/**
 * The result of publishing a rendered set.
 *
 * @category models
 * @since 0.1.0
 */
export interface WriteReport {
  readonly wrote: ReadonlyArray<string>
  readonly unchanged: ReadonlyArray<string>
  readonly removed: ReadonlyArray<string>
  readonly preserved: ReadonlyArray<string>
}

/**
 * Publishes the rendered file set under `root`, atomically per file.
 *
 * Every rendered path must fall inside the declared `changes` write-set when
 * one is declared. Each file lands via a same-directory temporary name and
 * rename, so a reader sees the old bytes or the new bytes, never a torn
 * write. Files inside the write-set that are neither rendered nor preserved
 * are stale generated output and are removed. Preserved files are never
 * written and never removed.
 *
 * @category writing
 * @since 0.1.0
 */
export const write = async (root: string, rendered: CiRender): Promise<WriteReport> => {
  const directory = NodePath.join(root, rendered.packageDir)
  const patterns = rendered.changes.map(globToRegExp)
  if (rendered.changes.length > 0) {
    for (const file of rendered.files) {
      if (!insideWriteSet(patterns, file.path)) {
        throw new GithubRenderError(
          "outside_write_set",
          `${file.path} falls outside the declared changes write-set`
        )
      }
    }
  }
  const wrote: Array<string> = []
  const unchanged: Array<string> = []
  for (const file of rendered.files) {
    const absolute = NodePath.join(directory, relativePath(file.path, "rendered path"))
    try {
      const existing = await Fs.readFile(absolute, "utf8")
      if (existing === file.content) {
        unchanged.push(file.path)
        continue
      }
    } catch {
      // Absent: fall through to the write below.
    }
    const temporary = `${absolute}.tmp-${process.pid}-${NodeCrypto.randomBytes(4).toString("hex")}`
    try {
      await Fs.mkdir(NodePath.dirname(absolute), { recursive: true })
      await Fs.writeFile(temporary, file.content, "utf8")
      await Fs.rename(temporary, absolute)
    } catch (cause) {
      await Fs.rm(temporary, { force: true }).catch(() => undefined)
      throw new GithubRenderError(
        "write_failed",
        `${file.path} could not be published: ${cause instanceof Error ? cause.message : String(cause)}`
      )
    }
    wrote.push(file.path)
  }
  const removed: Array<string> = []
  const preserved: Array<string> = []
  const renderedPaths = new Set(rendered.files.map((file) => file.path))
  for (const path of await listFiles(directory)) {
    if (renderedPaths.has(path)) continue
    if (rendered.preserve.includes(path)) {
      preserved.push(path)
      continue
    }
    if (!insideWriteSet(patterns, path)) continue
    try {
      await Fs.rm(NodePath.join(directory, path))
    } catch (cause) {
      throw new GithubRenderError(
        "write_failed",
        `stale generated file ${path} could not be removed: ${cause instanceof Error ? cause.message : String(cause)}`
      )
    }
    removed.push(path)
  }
  return { wrote, unchanged, removed, preserved }
}
