/**
 * The environment contract of the `smithers` command line.
 *
 * rc.0 reads a small, closed set of `SMITHERS_*` names. The imported CLI read
 * `FLOWS_*` spellings for four of them, so every name here also accepts its
 * `FLOWS_*` alias — for rc.0 only. The aliases are removed at 1.0.0, and the
 * pair is pinned by `test/Environment.test.ts` so neither half drifts.
 *
 * Names outside {@link names} are not read by rc.0. In particular the 0.x
 * `SMITHERS_HOME`, `SMITHERS_TOKEN`, and `SMITHERS_WORKFLOW_*` families are
 * gone: `~/.smithers` is not a runtime input (rc-contract section 6), and
 * `SMITHERS_TOKEN` belongs to a different product's CLI.
 *
 * @since 1.0.0
 */

/**
 * A canonical `SMITHERS_*` name and the `FLOWS_*` alias accepted for rc.0.
 *
 * @category models
 * @since 1.0.0
 */
export interface Name {
  readonly name: string
  readonly alias: string
  readonly purpose: string
}

const entry = (suffix: string, purpose: string): Name => ({
  name: `SMITHERS_${suffix}`,
  alias: `FLOWS_${suffix}`,
  purpose
})

/**
 * Every environment variable rc.0 reads, with its rc.0-only `FLOWS_*` alias.
 *
 * @category constants
 * @since 1.0.0
 */
export const names: ReadonlyArray<Name> = [
  entry("REMOTE", "Control-plane base URL; the environment form of --remote"),
  entry("API_KEY", "Bearer credential; the environment form of --credential"),
  entry("MCP_CONFIG", "Path to the --mcp-config server array"),
  entry("OPENAI_AUTH", "`api-key` or `chatgpt`, selecting how openai seats authenticate"),
  entry("TEST_COMMAND", "The command the `test` flow runs"),
  entry("TEST_CONTAINER", "The container the `test` flow runs in"),
  entry("TEST_CWD", "The repository's path inside that container"),
  entry("TEST_TIMEOUT_MS", "Wall-clock budget for one `test` invocation"),
  entry("BACKEND", "Database backend; only `sqlite` is supported (rc-contract section 2)"),
  entry("BUG_ENDPOINT", "Where `smithers bug` posts its report"),
  entry("JJ_PATH", "Explicit path to the jj binary"),
  entry("DETACHED_ADMISSION_TIMEOUT_MS", "How long `up -d` waits for the detached run's admission line"),
  entry("INSIDE_RUN", "Set on an agent process by the engine; keeps its 0.x meaning"),
  entry("RUN_ID", "The run an agent process belongs to; keeps its 0.x meaning")
]

/** Index for `read`, built once so a lookup is not a linear scan per call. */
const aliasOf = new Map(names.map((name) => [name.name, name.alias]))

/**
 * The environment shape this module reads. `process.env` satisfies it.
 *
 * @category models
 * @since 1.0.0
 */
export type Source = Readonly<Record<string, string | undefined>>

/**
 * Reads one canonical name, falling back to its rc.0 `FLOWS_*` alias.
 *
 * An empty value is treated exactly like an unset one, the convention every
 * credential variable in this CLI already follows: an exported-but-blank
 * variable is how a shell spells "not configured".
 *
 * @category getters
 * @since 1.0.0
 */
export const read = (environment: Source, name: string): string | undefined => {
  const direct = environment[name]
  if (direct !== undefined && direct !== "") return direct
  const alias = aliasOf.get(name)
  if (alias === undefined) return undefined
  const aliased = environment[alias]
  return aliased === undefined || aliased === "" ? undefined : aliased
}

/**
 * Reads one canonical name as a positive integer, ignoring anything else.
 *
 * @category getters
 * @since 1.0.0
 */
export const readInteger = (environment: Source, name: string): number | undefined => {
  const raw = read(environment, name)
  if (raw === undefined) return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * The database-backend refusal required by rc-contract section 2.
 *
 * `sqlite` and an unset value are the supported configuration; every other
 * value names a backend that does not ship, and saying so is the whole
 * contract — a silent fallback to SQLite would run a project's flows against
 * a database it did not ask for.
 *
 * @category getters
 * @since 1.0.0
 */
export const unsupportedBackend = (value: string | undefined): string | undefined => {
  if (value === undefined || value === "" || value === "sqlite") return undefined
  return `unsupported_database: ${value} is not supported in 1.0.0-rc.0. ` +
    `Smithers 1.0.0-rc.0 stores run state in local SQLite only. ` +
    `See https://smithers.sh/migration/1.0#databases`
}
