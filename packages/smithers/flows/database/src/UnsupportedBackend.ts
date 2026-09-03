/**
 * The environment half of the SQLite-only contract.
 *
 * rc.0 stores run state in local SQLite only. A project migrating from a 0.x
 * PostgreSQL or PGlite deployment still exports that deployment's connection
 * strings, and rc.0 ignores them. Ignoring them *silently* is the failure
 * The release policy was written to remove: the project would run against
 * SQLite believing it ran against PostgreSQL, and nothing in the run would say
 * otherwise.
 *
 * The names and the sentence live here, beside the driver that decides what a
 * supported database is, rather than in the CLI: the CLI chooses where a
 * notice is printed, not what rc.0 supports. The notice is a notice, not a
 * refusal — it changes no exit code and no result. The refusal for a *chosen*
 * backend (`SMITHERS_BACKEND`, `--backend`) is the CLI's `unsupported_database`
 * error.
 *
 * @since 1.0.0
 */

/** An environment as `process.env` presents it. */
type Source = Readonly<Record<string, string | undefined>>

/**
 * The `SMITHERS_*` names rc.0 ignores: `SMITHERS_TEST_PG_URL` and every
 * `SMITHERS_POSTGRES_*` name (the release policy).
 *
 * The separator is part of the prefix. Every name 0.x actually read carries it
 * (`SMITHERS_POSTGRES_URL`, `SMITHERS_POSTGRES_POOL_MAX`,
 * `SMITHERS_POSTGRES_ACQUIRE_TIMEOUT_MS`), and dropping it would announce
 * `SMITHERS_POSTGRESQL_URL`, a name neither release reads, as one rc.0 decided
 * to ignore.
 *
 * Sorted, so an operator reading two runs compares two identical lists, and
 * de-duplicated by construction because an environment has one value per name.
 * An exported-but-blank name counts as unset, the convention every other read
 * of the environment follows.
 *
 * @category getters
 * @since 1.0.0
 */
export const ignoredNames = (environment: Source): ReadonlyArray<string> =>
  Object.keys(environment)
    .filter((name) =>
      (name === "SMITHERS_TEST_PG_URL" || name.startsWith("SMITHERS_POSTGRES_")) &&
      environment[name] !== undefined && environment[name] !== ""
    )
    .sort()

/**
 * The one line an ignored name gets, verbatim from the release policy.
 *
 * @category constructors
 * @since 1.0.0
 */
export const ignoredNotice = (name: string): string => `ignored: ${name} has no effect in 1.0.0-rc.0 (SQLite only)`
