/**
 * Where the `jj` executable comes from on a Node host.
 *
 * `NodeJj` spawns the bare name `jj` and lets the operating system search
 * `PATH`. That is the right default and the wrong diagnosis: when it fails, an
 * operator needs to know which file was tried and why it was rejected. This
 * module answers exactly that question, and `smithers doctor` prints the
 * answer.
 *
 * Resolution order, carried over from the 0.x `@smthrs/vcs` resolver:
 *
 * 1. `SMITHERS_JJ_PATH` (`FLOWS_JJ_PATH` is read as an rc.0 alias). An
 *    override that names an existing file stays authoritative even when it is
 *    not executable, so a bad explicit path is reported instead of silently
 *    running a different binary.
 * 2. `PATH`, as the bare command name `jj`.
 *
 * rc.0 ships no vendored `jj` platform packages, so the 0.x bundled-package
 * branch has no counterpart here.
 *
 * @since 1.0.0
 */
import { accessSync, constants, existsSync } from "node:fs"
import { delimiter, join } from "node:path"

/**
 * Where a resolved `jj` command came from.
 *
 * `env` is an override named by {@link overrideVariables}, `path` is the bare
 * command name left for the operating system to search.
 *
 * @category models
 * @since 1.0.0
 */
export type Source = "env" | "path"

/**
 * The `jj` command a host should spawn, and what is known about it.
 *
 * `path` is always spawnable in the sense that it can be handed to a spawner:
 * when nothing better is known it is the bare name `jj`, which fails to spawn
 * with `not_installed` exactly as `NodeJj` already classifies it.
 *
 * `hint` is present only when the resolution is known to be unusable — an
 * override that is not executable, or nothing named `jj` on `PATH` — and
 * carries the operator guidance for that case.
 *
 * @category models
 * @since 1.0.0
 */
export interface Resolved {
  readonly path: string
  readonly source: Source
  readonly executable: boolean
  readonly hint?: string | undefined
  /** The override variable that supplied `path` when `source` is `env`. */
  readonly variable?: string | undefined
  /**
   * An override variable that was set to a path nothing exists at, and was
   * therefore skipped. The resolution is unaffected, but an operator whose
   * typo'd `SMITHERS_JJ_PATH` was disregarded otherwise gets a healthy report
   * for a jj they did not choose.
   */
  readonly ignored?: { readonly variable: string; readonly path: string } | undefined
}

/**
 * The environment names this resolver reads, most specific first.
 *
 * `FLOWS_JJ_PATH` is an rc.0-only alias and is removed at 1.0.0.
 *
 * @category constants
 * @since 1.0.0
 */
export const overrideVariables: ReadonlyArray<string> = ["SMITHERS_JJ_PATH", "FLOWS_JJ_PATH"]

/**
 * Whether the operating system can execute a candidate.
 *
 * POSIX requires the execute bit; Windows selects a vendored `.exe` and does
 * not use POSIX mode bits, so existence is sufficient there. This is a probe,
 * never a `chmod`: an unusable candidate must be reported, not repaired.
 *
 * @category predicates
 * @since 1.0.0
 */
export const isExecutable = (
  file: string,
  options: {
    readonly platform?: NodeJS.Platform | undefined
    readonly access?: ((file: string, mode: number) => void) | undefined
  } = {}
): boolean => {
  const platform = options.platform ?? process.platform
  const access = options.access ?? accessSync
  try {
    access(file, platform === "win32" ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * A path rendered as one POSIX shell word.
 *
 * The permission hint is remediation an operator is expected to paste into a
 * shell, and the path in it is whatever they put in `SMITHERS_JJ_PATH`. Unquoted,
 * a space makes the advice silently wrong and a `;` or `$(...)` makes the paste
 * run commands the hint never named.
 *
 * @category conversions
 * @since 1.0.0
 */
export const shellQuote = (value: string): string => `'${value.split("'").join(`'\\''`)}'`

/**
 * The guidance printed when a named `jj` cannot be executed.
 *
 * The macOS quarantine tip appears only on darwin, where a downloaded binary
 * carries `com.apple.quarantine` and refuses to run with an error that names
 * neither the attribute nor the fix.
 *
 * @category constructors
 * @since 1.0.0
 */
export const permissionHint = (file: string, platform: NodeJS.Platform = process.platform): string => {
  const quoted = shellQuote(file)
  const quarantine = platform === "darwin" ? ` xattr -d com.apple.quarantine ${quoted};` : ""
  return `Cannot execute the jj binary at ${file}. Run: chmod +x ${quoted};${quarantine}` +
    ` or point SMITHERS_JJ_PATH at a working jj.`
}

/** The guidance printed when no `jj` was found at all. */
const missingHint = "No jj on PATH. Install jj (https://jj-vcs.github.io) or set SMITHERS_JJ_PATH."

/** The first entry of `PATH` that holds an executable named `jj`, if any. */
const searchPath = (
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  executable: (file: string) => boolean
): string | undefined => {
  const raw = environment["PATH"] ?? environment["Path"]
  if (raw === undefined || raw === "") return undefined
  const name = platform === "win32" ? "jj.exe" : "jj"
  for (const entry of raw.split(delimiter)) {
    if (entry === "") continue
    const candidate = join(entry, name)
    if (executable(candidate)) return candidate
  }
  return undefined
}

/**
 * Options accepted by {@link resolveJjBinary}. Every probe is injectable so
 * the resolution order can be pinned without staging a filesystem.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  readonly platform?: NodeJS.Platform | undefined
  readonly exists?: ((file: string) => boolean) | undefined
  readonly executable?: ((file: string) => boolean) | undefined
}

/**
 * Resolves the `jj` command this host should spawn.
 *
 * Always returns a command. When jj is genuinely absent the bare name `jj` is
 * returned with `executable: false` and a hint, which keeps every caller's
 * soft-failure behavior — `NodeJj` classifies the failed spawn as
 * `not_installed` — while giving `doctor` something specific to print.
 *
 * @category constructors
 * @since 1.0.0
 */
export const resolveJjBinary = (options: Options = {}): Resolved => {
  const environment = options.environment ?? process.env
  const platform = options.platform ?? process.platform
  const exists = options.exists ?? existsSync
  const executable = options.executable ?? ((file: string) => isExecutable(file, { platform }))

  let ignored: { readonly variable: string; readonly path: string } | undefined
  for (const variable of overrideVariables) {
    const override = environment[variable]
    if (override === undefined || override === "") continue
    // An override that names a real file wins even when it cannot run: an
    // operator who set the variable deserves to hear that their file is
    // broken, not to have a different binary quietly substituted.
    //
    // One that names nothing falls through to PATH, which is the behavior 0.x
    // recorded, but the fall-through is REPORTED rather than silent.
    if (!exists(override)) {
      ignored ??= { variable, path: override }
      continue
    }
    const usable = executable(override)
    return {
      path: override,
      source: "env",
      executable: usable,
      variable,
      ...(usable ? {} : { hint: permissionHint(override, platform) }),
      ...(ignored === undefined ? {} : { ignored })
    }
  }

  const noted = ignored === undefined ? {} : { ignored }
  const found = searchPath(environment, platform, executable)
  if (found !== undefined) return { path: found, source: "path", executable: true, ...noted }
  return { path: "jj", source: "path", executable: false, hint: missingHint, ...noted }
}

/**
 * A one-line description of a resolution, for `smithers doctor`.
 *
 * @category conversions
 * @since 1.0.0
 */
export const describe = (resolved: Resolved): string => {
  const where = resolved.source === "env"
    ? `${resolved.path} (${resolved.variable ?? "SMITHERS_JJ_PATH"})`
    : resolved.executable
    ? resolved.path
    : "not found"
  const notes = [
    resolved.hint,
    resolved.ignored === undefined
      ? undefined
      : `${resolved.ignored.variable} names ${resolved.ignored.path}, which does not exist, and was ignored`
  ].filter((note): note is string => note !== undefined)
  return notes.length === 0 ? `jj: ${where}` : `jj: ${where} - ${notes.join("; ")}`
}
