/**
 * `smthrs update`: is the installed CLI the current one?
 *
 * The check is a plain registry read of `@smthrs/cli`'s dist-tags and nothing
 * else. rc.0 never installs anything on the operator's behalf: 0.x's
 * self-upgrade path had to know about npm, pnpm, bun, and global versus local
 * installs, and got it wrong often enough that the honest answer is to print
 * the command for the package manager the operator actually uses.
 *
 * A release candidate publishes under the `next` tag, so the comparison is
 * against `next` first and `latest` second: an rc.0 install told about a 0.35
 * `latest` would be told to downgrade.
 *
 * @since 1.0.0
 */

/**
 * The package this CLI ships as.
 *
 * @category constants
 * @since 1.0.0
 */
export const packageName = "@smthrs/cli"

/**
 * The registry endpoint the check reads.
 *
 * @category constants
 * @since 1.0.0
 */
export const registryUrl = `https://registry.npmjs.org/-/package/${packageName}/dist-tags`

/**
 * What the check found.
 *
 * @category models
 * @since 1.0.0
 */
export interface Status {
  readonly current: string
  readonly available: string | undefined
  readonly tag: "next" | "latest" | undefined
  readonly upToDate: boolean
  readonly install: string | undefined
}

const parts = (version: string): ReadonlyArray<string> => version.split(/[.-]/)

/**
 * Whether `candidate` is a later version than `current`.
 *
 * Numeric segments compare numerically and everything else lexically, which is
 * enough to order `1.0.0-rc.0` before `1.0.0-rc.10` and both before `1.0.0`.
 *
 * @category predicates
 * @since 1.0.0
 */
export const isNewer = (candidate: string, current: string): boolean => {
  const left = parts(candidate)
  const right = parts(current)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index++) {
    const a = left[index]
    const b = right[index]
    // Both versions come from npm dist-tags, so both carry major, minor, and
    // patch. Running out of segments therefore means one of them has no
    // prerelease suffix, and the release is newer: 1.0.0 beats 1.0.0-rc.0.
    if (a === undefined) return true
    if (b === undefined) return false
    if (a === b) continue
    const numeric = Number(a)
    const other = Number(b)
    if (Number.isFinite(numeric) && Number.isFinite(other)) return numeric > other
    return a > b
  }
  return false
}

/**
 * Turns a dist-tag document into a status.
 *
 * @category constructors
 * @since 1.0.0
 */
export const compare = (current: string, tags: Readonly<Record<string, string>>): Status => {
  const candidates: ReadonlyArray<readonly ["next" | "latest", string | undefined]> = [
    ["next", tags["next"]],
    ["latest", tags["latest"]]
  ]
  for (const [tag, version] of candidates) {
    if (version !== undefined && isNewer(version, current)) {
      return {
        current,
        available: version,
        tag,
        upToDate: false,
        install: `npm install -g ${packageName}@${version}`
      }
    }
  }
  return { current, available: undefined, tag: undefined, upToDate: true, install: undefined }
}

/**
 * The human rendering of a status.
 *
 * @category conversions
 * @since 1.0.0
 */
export const render = (status: Status): string =>
  status.upToDate
    ? `${packageName} ${status.current} is current.`
    : `${packageName} ${status.available} is available (${status.tag}); you have ${status.current}.\n${status.install}`
