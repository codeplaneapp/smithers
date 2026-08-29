/**
 * `smithers doctor`: the one command that answers "why did that not work?"
 * without running anything.
 *
 * Every check here is a thing an operator has been surprised by: a flow
 * directory that discovers nothing, a database that is not where they thought,
 * a Node build below the durable engine's floor, `jj` missing from a `PATH`
 * that has it interactively, a provider key that is exported but empty, and
 * Smithers 0.x state beside a project that has already moved on.
 *
 * The report is data, not text. `--json` prints it verbatim, the human
 * rendering is one line per check, and nothing about a check's outcome is
 * decided by the renderer.
 *
 * @since 1.0.0
 */
import { existsSync, readdirSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import * as Environment from "./Environment.ts"
import * as Legacy from "./Legacy.ts"
import * as Project from "./Project.ts"

/**
 * The outcome of one check.
 *
 * `warn` is a fact the operator should know and that stops nothing; `fail` is
 * a fact that will stop the next command they run.
 *
 * @category models
 * @since 1.0.0
 */
export type Level = "ok" | "warn" | "fail"

/**
 * One line of the report.
 *
 * @category models
 * @since 1.0.0
 */
export interface Check {
  readonly name: string
  readonly level: Level
  readonly detail: string
}

/**
 * The whole report.
 *
 * @category models
 * @since 1.0.0
 */
export interface Report {
  readonly root: string
  readonly checks: ReadonlyArray<Check>
}

/**
 * The minimum Node the durable engine runs on (rc-contract section 1).
 *
 * @category constants
 * @since 1.0.0
 */
export const minimumNode = "22.19.0"

const order = (version: string): ReadonlyArray<number> =>
  version.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0)

/**
 * Whether a Node version satisfies the rc.0 floor.
 *
 * @category predicates
 * @since 1.0.0
 */
export const satisfiesNode = (version: string, minimum: string = minimumNode): boolean => {
  const actual = order(version)
  const required = order(minimum)
  for (let index = 0; index < required.length; index++) {
    const left = actual[index] ?? 0
    const right = required[index] ?? 0
    if (left !== right) return left > right
  }
  return true
}

/** How many migrations one database file has recorded, or a reason it cannot say. */
const ladder = (file: string): Check => {
  if (!existsSync(file)) return { name: `database ${file}`, level: "ok", detail: "not created yet" }
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(file, { readOnly: true })
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'flows_migrations'")
      .all()
    if (tables.length === 0) {
      return {
        name: `database ${file}`,
        level: "warn",
        detail: "no flows_migrations table; this file was not created by Smithers 1.0"
      }
    }
    const row = database.prepare("SELECT COUNT(*) AS applied, MAX(migration_id) AS latest FROM flows_migrations")
      .get() as Record<string, unknown> | undefined
    const applied = Number(row?.["applied"] ?? 0)
    const latest = row?.["latest"] ?? "none"
    return { name: `database ${file}`, level: "ok", detail: `${applied} migrations applied, latest ${latest}` }
  } catch (error) {
    return {
      name: `database ${file}`,
      level: "fail",
      detail: error instanceof Error ? error.message : String(error)
    }
  } finally {
    database?.close()
  }
}

/** Every flow directory discovery would walk, and whether it will find anything. */
const registry = (root: string): Check => {
  const directory = Project.flowsDirectory(root)
  if (!existsSync(directory)) {
    return {
      name: "registry",
      level: "warn",
      detail: `no ${directory}; run \`smithers init\` to scaffold one`
    }
  }
  const entries = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  const withBody = entries.filter((entry) =>
    existsSync(`${directory}/${entry.name}/flow.mdx`) || existsSync(`${directory}/${entry.name}/flow.ts`)
  )
  if (withBody.length === 0) {
    return {
      name: "registry",
      level: "warn",
      detail: `${directory} holds no flow.ts or flow.mdx; discovery finds nothing`
    }
  }
  const empty = entries.length - withBody.length
  return {
    name: "registry",
    level: "ok",
    detail: empty === 0
      ? `${withBody.length} flows discovered`
      : `${withBody.length} flows discovered, ${empty} directories skipped with no flow body`
  }
}

/** Which provider credentials are present, and which are exported but empty. */
const providers = (environment: Environment.Source): Check => {
  const variables = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "CEREBRAS_API_KEY"]
  const present = variables.filter((variable) => (environment[variable] ?? "") !== "")
  const blank = variables.filter((variable) => environment[variable] === "")
  const auth = Environment.read(environment, "SMITHERS_OPENAI_AUTH")
  const chatgpt = auth === "chatgpt" ? "; openai seats use the ChatGPT session" : ""
  if (present.length === 0) {
    return {
      name: "providers",
      level: "warn",
      detail: `no provider key set${blank.length === 0 ? "" : ` (${blank.join(", ")} exported but empty)`}`
    }
  }
  return {
    name: "providers",
    level: "ok",
    detail: `${present.join(", ")}${blank.length === 0 ? "" : `; ${blank.join(", ")} exported but empty`}${chatgpt}`
  }
}

/**
 * Arguments accepted by {@link inspect}. Every host fact is a parameter so the
 * report is deterministic in a test.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  readonly root: string
  readonly environment?: Environment.Source | undefined
  readonly nodeVersion?: string | undefined
  readonly jj?: { readonly path: string; readonly executable: boolean; readonly hint?: string | undefined } | undefined
  readonly cwd?: string | undefined
  /**
   * The 0.x state found when the invocation started. The caller samples it,
   * because by the time a command runs its own control database has created
   * `<root>/.flows` and `Project.legacyState` would report nothing.
   */
  readonly legacyPaths?: ReadonlyArray<string> | undefined
}

/**
 * Runs every check and returns the report.
 *
 * @category constructors
 * @since 1.0.0
 */
export const inspect = (options: Options): Report => {
  const environment = options.environment ?? process.env
  const nodeVersion = options.nodeVersion ?? process.versions.node
  const checks: Array<Check> = [registry(options.root)]

  checks.push({
    name: "state",
    level: "ok",
    detail: existsSync(Project.stateDirectory(options.root))
      ? Project.stateDirectory(options.root)
      : `${Project.stateDirectory(options.root)} (not created yet)`
  })
  checks.push(ladder(`${Project.stateDirectory(options.root)}/control.db`))
  checks.push(ladder(`${Project.stateDirectory(options.root)}/engine.db`))

  checks.push({
    name: "node",
    level: satisfiesNode(nodeVersion) ? "ok" : "fail",
    detail: satisfiesNode(nodeVersion)
      ? `v${nodeVersion.replace(/^v/, "")}`
      : `v${nodeVersion.replace(/^v/, "")} is below the ${minimumNode} floor the durable engine requires`
  })

  if (options.jj !== undefined) {
    checks.push({
      name: "jj",
      level: options.jj.executable ? "ok" : "warn",
      detail: options.jj.executable ? options.jj.path : options.jj.hint ?? "not found"
    })
  }

  checks.push(providers(environment))

  const backend = Environment.unsupportedBackend(Environment.read(environment, "SMITHERS_BACKEND"))
  if (backend !== undefined) checks.push({ name: "backend", level: "fail", detail: backend })

  // Two sources, because section 6 gates them differently. The markers are
  // the notice's paths and stop at a directory that already holds `.flows/`.
  // The databases are the refusal's input and do not, so doctor keeps
  // answering "what does the old database still hold?" for a project that
  // has already started running rc.0 commands.
  const markers = options.legacyPaths ?? Project.legacyState(options.cwd ?? options.root)
  const databases = Project.legacyDatabases(options.cwd ?? options.root)
  const reported = new Set<string>()
  for (const path of [...markers, ...databases]) {
    if (reported.has(path)) continue
    reported.add(path)
    const detail = path.endsWith("smithers.db")
      ? describeLegacyDatabase(path)
      : Project.legacyNotice(path)
    checks.push({ name: "smithers 0.x", level: "warn", detail })
  }

  return { root: options.root, checks }
}

/** The 0.x notice, plus what the database still holds. */
const describeLegacyDatabase = (path: string): string => {
  const database = Legacy.read(path)
  if (!database.readable) return `${Project.legacyNotice(path)} (unreadable: ${database.reason ?? "unknown"})`
  if (database.runs.length === 0) return `${Project.legacyNotice(path)} (no non-terminal runs)`
  return `${Project.legacyNotice(path)} (${database.runs.length} non-terminal runs)`
}

/**
 * The human rendering: one line per check.
 *
 * @category conversions
 * @since 1.0.0
 */
export const render = (report: Report): string =>
  [
    `smithers doctor — ${report.root}`,
    ...report.checks.map((check) => `${symbol(check.level)} ${check.name}: ${check.detail}`)
  ].join("\n")

const symbol = (level: Level): string => level === "ok" ? "ok  " : level === "warn" ? "warn" : "fail"

/**
 * Whether the report contains a failing check, which decides the exit status.
 *
 * @category predicates
 * @since 1.0.0
 */
export const failed = (report: Report): boolean => report.checks.some((check) => check.level === "fail")
