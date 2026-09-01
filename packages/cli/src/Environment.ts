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
 * A canonical `SMITHERS_*` name, and the `FLOWS_*` alias accepted for rc.0
 * when the imported CLI read one.
 *
 * Most names have no alias. The alias set is not "every name with `SMITHERS_`
 * swapped for `FLOWS_`": it is the four families rc-contract section 4 names
 * as renames, which are the only `FLOWS_*` spellings anything has ever set.
 *
 * @category models
 * @since 1.0.0
 */
export interface Name {
  readonly name: string
  readonly alias?: string | undefined
  readonly purpose: string
}

/** A name the imported CLI read under a `FLOWS_*` spelling. */
const renamed = (suffix: string, purpose: string): Name => ({
  name: `SMITHERS_${suffix}`,
  alias: `FLOWS_${suffix}`,
  purpose
})

/** A name with no 0.x spelling to accept. */
const entry = (suffix: string, purpose: string): Name => ({ name: `SMITHERS_${suffix}`, purpose })

/**
 * Every environment variable rc.0 reads, with the rc.0-only `FLOWS_*` alias
 * for the four families that have one.
 *
 * @category constants
 * @since 1.0.0
 */
export const names: ReadonlyArray<Name> = [
  renamed("REMOTE", "Control-plane base URL; the environment form of --remote"),
  // New in rc.0: there is no 0.x spelling for it to accept.
  entry("API_KEY", "Bearer credential; the environment form of --credential"),
  renamed("MCP_CONFIG", "Path to the --mcp-config server array"),
  renamed("OPENAI_AUTH", "`api-key` or `chatgpt`, selecting how openai seats authenticate"),
  renamed("TEST_COMMAND", "The command the `test` flow runs"),
  renamed("TEST_CONTAINER", "The container the `test` flow runs in"),
  renamed("TEST_CWD", "The repository's path inside that container"),
  renamed("TEST_TIMEOUT_MS", "Wall-clock budget for one `test` invocation"),
  entry("BACKEND", "Database backend; only `sqlite` is supported (rc-contract section 2)"),
  entry("BUG_ENDPOINT", "Where `smithers bug` posts its report"),
  entry("JJ_PATH", "Explicit path to the jj binary"),
  entry("DETACHED_ADMISSION_TIMEOUT_MS", "How long `up -d` waits for the detached run's admission line"),
  entry("INSIDE_RUN", "Set on an agent process by the engine; keeps its 0.x meaning"),
  entry("RUN_ID", "The run an agent process belongs to; keeps its 0.x meaning")
]

/** Index for `read`, built once so a lookup is not a linear scan per call. */
const aliasOf = new Map(
  names.flatMap((name) => name.alias === undefined ? [] : [[name.name, name.alias] as const])
)

/**
 * The environment shape this module reads. `process.env` satisfies it.
 *
 * @category models
 * @since 1.0.0
 */
export type Source = Readonly<Record<string, string | undefined>>

/**
 * Reads the directory the process was started in by deliberate host choice.
 *
 * Using this gives up the project root resolved for an invocation. It belongs
 * only in explicit process-backed service defaults; project operations take
 * their configured root as an argument.
 *
 * @category getters
 * @since 1.0.0
 */
export const ambientWorkingDirectory = (): string => process.cwd()

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
  // The whole value has to be digits. `Number.parseInt` stops at the first
  // character it cannot read, so it answered 30 for `30abc` and for `30s`,
  // which is the opposite of the "ignore anything else" this function
  // promises: a typo silently became a plausible-looking budget.
  if (!/^\d+$/.test(raw)) return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * The refusal sentence, verbatim from rc-contract section 2.
 *
 * The contract fixes the whole sentence, so this is a constant rather than a
 * template. An interpolated value cannot be asserted verbatim, and the two
 * clauses an interpolated version drops are the ones an operator needs: which
 * backends are unavailable, and what to do next. Repeating the value they
 * typed is neither.
 *
 * @category constants
 * @since 1.0.0
 */
export const unsupportedBackendMessage: string =
  "unsupported_database: 1.0.0-rc.0 supports local SQLite only. PostgreSQL and PGlite are not available. " +
  "Unset SMITHERS_BACKEND or set it to sqlite. See https://smithers.sh/migration/1.0#databases"

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
export const unsupportedBackend = (value: string | undefined): string | undefined =>
  value === undefined || value === "" || value === "sqlite" ? undefined : unsupportedBackendMessage
