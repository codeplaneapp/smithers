/**
 * The `rg`-process implementation of the ripgrep search contract.
 *
 * @since 0.1.0
 */
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as Path from "@smthrs/kernel/Path"
import { type Context, Effect, Layer, Stream } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as Grouping from "./internal/Grouping.ts"
import * as Contract from "./internal/SearchContract.ts"
import { notice, truncateBytes } from "./internal/Text.ts"
import * as Walk from "./internal/Walk.ts"
import * as Search from "./Search.ts"
import * as StdError from "./StdError.ts"

interface RgResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

const execute = (
  cwd: string,
  args: ReadonlyArray<string>
): Effect.Effect<RgResult, StdError.StdError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make("rg", [...args], { cwd }))
    const [stdout, stderr, exitCode] = yield* Effect.all([
      Stream.mkString(Stream.decodeText(handle.stdout)),
      Stream.mkString(Stream.decodeText(handle.stderr)),
      handle.exitCode
    ], { concurrency: "unbounded" })
    return { stdout, stderr, exitCode }
  }).pipe(
    Effect.scoped,
    Effect.mapError(() =>
      new StdError.StdError({
        code: "provider_unavailable",
        message: "The native ripgrep implementation could not start rg"
      })
    )
  )

const skipGlobs = [...Walk.skippedDirectories].map((directory) => `!**/${directory}/**`)
const hiddenGlobs = ["!.*", "!**/.*", "!**/.*/**"]

/**
 * Reports what `rg` rejected, or `undefined` when it produced an answer.
 *
 * Exit status 2 means only "an error occurred", and a walk hits those
 * routinely: a dangling symlink, a symlink loop, a directory the process may
 * not list. `--no-messages` suppresses exactly those, leaving stderr empty and
 * the results on stdout complete for everything `rg` could reach — the same
 * entries the in-process peer skips, so the peers still agree. A fatal error —
 * an unparsable glob, a rejected expression, a killed process — always writes
 * to stderr, which `--no-messages` does not touch. Stderr is therefore the
 * discriminator, and the exit status alone is not.
 */
const rejection = (result: RgResult): string | undefined => {
  const message = result.stderr.trim()
  return result.exitCode > 1 && message.length > 0 ? message : undefined
}

const nulSeparated = (stdout: string): ReadonlyArray<string> => stdout.split("\0").filter((value) => value.length > 0)

const preview = (line: string): string => {
  const withoutTerminator = line.replace(/\r?\n$/, "")
  const characters = Array.from(withoutTerminator)
  return truncateBytes(characters.length > 500 ? characters.slice(0, 500).join("") : withoutTerminator, 500, {
    keep: "head"
  }).text
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined

const textAt = (record: Record<string, unknown> | undefined, key: string): string | undefined => {
  const nested = asRecord(record?.[key])
  return typeof nested?.text === "string" ? nested.text : undefined
}

const malformedJson = (): StdError.StdError =>
  new StdError.StdError({ code: "request_failed", message: "rg returned malformed JSON" })

const resolveRoot = (
  root: string
): Effect.Effect<
  {
    readonly cwd: string
    readonly target: string
    readonly explicitFile: boolean
    readonly absolute: (value: string) => string
  },
  StdError.StdError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const info = yield* fileSystem.stat(root).pipe(Effect.mapError(() => Contract.notFound(root)))
    const cwd = info.type === "File" ? path.dirname(root) : root
    const target = info.type === "File" ? path.basename(root) : "."
    return {
      cwd,
      target,
      explicitFile: info.type === "File",
      absolute: (value: string) => path.normalize(path.join(cwd, value.replace(/^\.\//, "")))
    }
  })

const pathOrder = (left: Search.GrepLine, right: Search.GrepLine): number =>
  left.file < right.file ? -1 : left.file > right.file ? 1 : left.line - right.line

const grep = (
  input: Search.GrepInput
): Effect.Effect<
  Search.GrepOutput,
  StdError.StdError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* resolveRoot(input.root)
    const args: Array<string> = [
      "--json",
      "--stats",
      "--no-ignore",
      "--no-messages",
      "--sort",
      "path",
      "--encoding=utf-8",
      "--crlf"
    ]
    if (input.hidden) args.push("--hidden")
    if (input.fixedStrings) args.push("--fixed-strings")
    if (input.ignoreCase) args.push("--ignore-case")
    if (input.smartCase) args.push("--smart-case")
    if (input.beforeContext > 0) args.push("--before-context", String(input.beforeContext))
    if (input.afterContext > 0) args.push("--after-context", String(input.afterContext))
    if (input.maxCount !== undefined) args.push("--max-count", String(input.maxCount))
    const globs = [...input.globs.map(Contract.canonicalGlob), ...(input.hidden ? [] : hiddenGlobs), ...skipGlobs]
    for (const glob of globs) args.push("--glob", glob)
    args.push("--", input.pattern, root.target)

    const binaryArgs: Array<string> = [
      "--files-with-matches",
      "--text",
      "--null",
      "--no-ignore",
      "--no-messages",
      "--sort",
      "path"
    ]
    if (input.hidden) binaryArgs.push("--hidden")
    for (const glob of globs) binaryArgs.push("--glob", glob)
    binaryArgs.push("--", "\\x00", root.target)

    // `--json` reports `stats.searches` from the printer, so it counts only the
    // files that produced output — the files with a match. The contract counts
    // every file the search covered, which is what `--files` lists, and listing
    // reads no file contents.
    const listingArgs: Array<string> = ["--files", "--null", "--no-ignore", "--no-messages"]
    if (input.hidden) listingArgs.push("--hidden")
    for (const glob of globs) listingArgs.push("--glob", glob)
    listingArgs.push("--", root.target)

    const [result, binaryResult, listingResult] = yield* Effect.all(
      [execute(root.cwd, args), execute(root.cwd, binaryArgs), execute(root.cwd, listingArgs)],
      { concurrency: "unbounded" }
    )
    for (const outcome of [result, binaryResult, listingResult]) {
      const message = rejection(outcome)
      if (message !== undefined) {
        return yield* Effect.fail(new StdError.StdError({ code: "request_failed", message }))
      }
    }
    const binaryFiles = new Set(nulSeparated(binaryResult.stdout).map(root.absolute))
    if (root.explicitFile && binaryFiles.size > 0) {
      return yield* Effect.fail(
        new StdError.StdError({
          code: "binary_file",
          message: `Cannot search binary file: ${input.root}`,
          path: input.root
        })
      )
    }

    const lines: Array<Search.GrepLine> = []
    const files = new Set<string>()
    let sawSummary = false
    for (const encoded of result.stdout.split("\n")) {
      if (encoded.length === 0) continue
      let event: Record<string, unknown>
      try {
        const decoded = JSON.parse(encoded) as unknown
        const record = asRecord(decoded)
        if (record === undefined) return yield* Effect.fail(malformedJson())
        event = record
      } catch {
        return yield* Effect.fail(malformedJson())
      }
      const type = event.type
      const data = asRecord(event.data)
      if (type === "match" || type === "context") {
        const file = textAt(data, "path")
        const text = textAt(data, "lines")
        const line = data?.line_number
        if (file === undefined || text === undefined || typeof line !== "number") {
          return yield* Effect.fail(malformedJson())
        }
        const absolute = root.absolute(file)
        files.add(absolute)
        lines.push({ file: absolute, line, text: preview(text), kind: type })
      } else if (type === "begin") {
        if (textAt(data, "path") === undefined) return yield* Effect.fail(malformedJson())
      } else if (type === "end") {
        if (
          textAt(data, "path") === undefined ||
          (data?.binary_offset !== null && typeof data?.binary_offset !== "number")
        ) return yield* Effect.fail(malformedJson())
      } else if (type === "summary") {
        const stats = asRecord(data?.stats)
        if (typeof stats?.searches !== "number") return yield* Effect.fail(malformedJson())
        sawSummary = true
      } else return yield* Effect.fail(malformedJson())
    }
    if (!sawSummary) return yield* Effect.fail(malformedJson())
    for (const file of binaryFiles) files.delete(file)
    const visibleLines = lines.filter((line) => !binaryFiles.has(line.file)).sort(pathOrder)
    const grouped = input.filesWithMatches ? [] : Grouping.group(visibleLines)
    const entries = input.filesWithMatches ? [...files].sort() : grouped
    const truncated = entries.length > input.limit
    const shown = grouped.slice(0, input.limit)
    // `rg` reports lines, not files, so the enclosing definition costs one read
    // of each file whose hits survived the limit — never one per file searched.
    const contents = new Map<string, ReadonlyArray<string>>()
    if (input.symbols) {
      for (const file of new Set(shown.map((match) => match.file))) {
        const bytes = yield* Effect.orElseSucceed(fileSystem.readFile(file), () => undefined)
        if (bytes !== undefined) contents.set(file, Grouping.sourceLines(new TextDecoder().decode(bytes)))
      }
    }
    const unsatisfiable = entries.length > 0 ? undefined : yield* Contract.unsatisfiableNotice({
      fileSystem,
      path,
      root: input.root,
      globs: input.globs,
      hidden: input.hidden
    })
    return {
      matches: Grouping.annotate(shown, contents),
      files: input.filesWithMatches ? [...files].sort().slice(0, input.limit) : [],
      filesSearched: nulSeparated(listingResult.stdout).length,
      skippedBinary: binaryFiles.size,
      truncated,
      ...(truncated
        ? { notice: notice(input.filesWithMatches ? "files" : "matches", input.limit, entries.length) }
        : {}),
      ...(unsatisfiable === undefined ? {} : { notice: unsatisfiable })
    }
  })

const glob = (
  input: Search.GlobInput
): Effect.Effect<
  Search.GlobOutput,
  StdError.StdError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* resolveRoot(input.root)
    const args: Array<string> = ["--files", "--no-ignore", "--no-messages", "--sort", "path"]
    if (input.hidden) args.push("--hidden")
    args.push("--glob", Contract.canonicalGlob(input.pattern))
    for (const glob of [...(input.hidden ? [] : hiddenGlobs), ...skipGlobs]) args.push("--glob", glob)
    args.push("--", root.target)
    const result = yield* execute(root.cwd, args)
    const rejected = rejection(result)
    if (rejected !== undefined) {
      return yield* Effect.fail(new StdError.StdError({ code: "invalid_pattern", message: rejected }))
    }
    const paths = result.stdout.split(/\r?\n/).filter((value) => value.length > 0).map(root.absolute).sort()
    const shown = paths.slice(0, input.limit)
    const unsatisfiable = paths.length > 0 ? undefined : yield* Contract.unsatisfiableNotice({
      fileSystem,
      path,
      root: input.root,
      globs: [input.pattern],
      hidden: input.hidden
    })
    return {
      paths: shown,
      total: paths.length,
      truncated: paths.length > input.limit,
      ...(paths.length > input.limit ? { notice: notice("entries", shown.length, paths.length) } : {}),
      ...(unsatisfiable === undefined ? {} : { notice: unsatisfiable })
    }
  })

/**
 * Captures filesystem, path and process services in the native peer.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  services: Context.Context<FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner>
): Search.Search =>
  Search.make({
    grep: (input) => Effect.provide(grep(input), services),
    glob: (input) => Effect.provide(glob(input), services)
  })

/**
 * Provides the `rg`-driven peer.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<
  Search.Search,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(
  Search.Search,
  Effect.map(Effect.context<FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner>(), make)
)
