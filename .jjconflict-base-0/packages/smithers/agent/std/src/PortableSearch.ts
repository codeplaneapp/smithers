/**
 * The in-process implementation of the ripgrep search contract.
 *
 * @since 0.1.0
 */
import * as Path from "@smthrs/kernel/Path"
import { type Context, Effect, Layer } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Grouping from "./internal/Grouping.ts"
import * as Contract from "./internal/SearchContract.ts"
import { notice, truncateBytes } from "./internal/Text.ts"
import * as Walk from "./internal/Walk.ts"
import * as Search from "./Search.ts"
import * as StdError from "./StdError.ts"

/**
 * How many filesystem questions one directory level asks at a time.
 *
 * A metadata call through the layer costs far more in fiber scheduling than in
 * kernel time, so asking one entry at a time is what makes a walk slow: the
 * same probe measured 28.8 µs sequentially and 6.0 µs at this width on the
 * SWE-bench pytest tree. The bound keeps the file-descriptor and thread-pool
 * pressure of a wide directory predictable.
 */
const concurrency = 16

/**
 * Answers whether each path is a symbolic link, which neither peer follows.
 *
 * `FileSystem.stat` resolves links, so the only probe available is `readLink`,
 * and every probe is one more call in a loop that already makes one per entry.
 * The walk therefore probes directories, where following a link would duplicate
 * a subtree or loop forever, and the callers probe the far smaller set of files
 * they are about to report — batched, never one at a time.
 */
const symbolicLinks = (
  fileSystem: FileSystem.FileSystem,
  candidates: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<boolean>> =>
  Effect.forEach(
    candidates,
    (candidate) => fileSystem.readLink(candidate).pipe(Effect.as(true), Effect.orElseSucceed(() => false)),
    { concurrency }
  )

/**
 * One walk: the files under the root, and whether the root was one file.
 */
interface Walked {
  readonly explicitFile: boolean
  readonly files: ReadonlyArray<string>
}

/**
 * Lists the files a search under `root` reaches.
 *
 * Only the root the caller named is allowed to fail the walk. Every entry
 * below it that the process cannot inspect — a dangling symlink, a symlink
 * loop, a directory it may not list — is skipped and the walk continues, which
 * is what `rg --no-messages` does with the same tree. Turning one of those into
 * a typed failure would make a whole repository unsearchable because of one
 * link, and would answer differently from the native peer.
 */
const walkFiles = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  hidden: boolean
): Effect.Effect<Walked, StdError.StdError> =>
  Effect.gen(function*() {
    const info = yield* fileSystem.stat(root).pipe(Effect.mapError(() => Contract.notFound(root)))
    if (info.type === "File") return { explicitFile: true, files: [path.normalize(root)] }
    const files: Array<string> = []
    const directories: Array<string> = [root]
    while (directories.length > 0) {
      const directory = directories.pop()
      if (directory === undefined) continue
      const children: ReadonlyArray<string> = yield* fileSystem.readDirectory(directory).pipe(
        Effect.catch(() =>
          directory === root
            ? Effect.fail(Contract.notFound(directory))
            : Effect.succeed<ReadonlyArray<string>>([])
        )
      )
      const candidates = children
        .filter((child) => !Walk.skippedDirectories.has(child) && (hidden || !child.startsWith(".")))
        .map((child) => path.join(directory, child))
      const entries = yield* Effect.forEach(candidates, (candidate) =>
        fileSystem.stat(candidate).pipe(
          Effect.map((candidateInfo): { readonly candidate: string; readonly type: string | undefined } => ({
            candidate,
            type: candidateInfo.type
          })),
          Effect.orElseSucceed(() => ({ candidate, type: undefined }))
        ), { concurrency })
      const nested: Array<string> = []
      for (const entry of entries) {
        if (entry.type === "Directory") nested.push(entry.candidate)
        else if (entry.type === "File") files.push(path.normalize(entry.candidate))
      }
      const links = yield* symbolicLinks(fileSystem, nested)
      for (let index = 0; index < nested.length; index++) {
        const candidate = nested[index]
        if (candidate !== undefined && links[index] !== true) directories.push(candidate)
      }
    }
    return { explicitFile: false, files: files.sort() }
  })

/**
 * Narrows a walk to the files a search reports.
 *
 * A root that names one file is that file: `rg` searches a path given on the
 * command line whatever `-g` says, and follows it even when it is a symlink.
 * Everything a walk found is filtered by the globs first and probed for
 * symlinks second, so the probe runs over the far smaller included set.
 */
const candidates = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  walked: Walked,
  root: string,
  globs: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function*() {
    if (walked.explicitFile) return walked.files
    const included = walked.files.filter((file) =>
      Contract.includedByGlobs(globs, path.relative(root, file), path.basename(file))
    )
    const links = yield* symbolicLinks(fileSystem, included)
    return included.filter((_, index) => links[index] !== true)
  })

const preview = (line: string): string => {
  const characters = Array.from(line)
  return truncateBytes(characters.length > 500 ? characters.slice(0, 500).join("") : line, 500, { keep: "head" }).text
}

const grep = (
  input: Search.GrepInput
): Effect.Effect<Search.GrepOutput, StdError.StdError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const walked = yield* walkFiles(fileSystem, path, input.root, input.hidden)
    const insensitive = input.ignoreCase || (input.smartCase && !/[A-Z]/.test(input.pattern))
    const regex = Contract.expression(input.pattern, input.fixedStrings, insensitive)
    const output: Array<Search.GrepLine> = []
    const matchingFiles: Array<string> = []
    const contents = new Map<string, ReadonlyArray<string>>()
    let filesSearched = 0
    let skippedBinary = 0

    const included = yield* candidates(fileSystem, path, walked, input.root, input.globs)
    for (const file of included) {
      // `rg --files` counts a file it cannot open among the files it would
      // search, and so does this walk: the count is what the globs admitted,
      // not what the reads happened to return.
      filesSearched++
      const bytes = yield* Effect.orElseSucceed(fileSystem.readFile(file), () => undefined)
      if (bytes === undefined) continue
      if (bytes.includes(0)) {
        if (walked.explicitFile) {
          return yield* Effect.fail(
            new StdError.StdError({
              code: "binary_file",
              message: `Cannot search binary file: ${file}`,
              path: file
            })
          )
        }
        skippedBinary++
        continue
      }
      const content = new TextDecoder().decode(bytes)
      const lines = Grouping.sourceLines(content)
      const matched: Array<number> = []
      for (let index = 0; index < lines.length; index++) {
        if (input.maxCount !== undefined && matched.length >= input.maxCount) break
        regex.lastIndex = 0
        if (regex.test(lines[index] ?? "")) matched.push(index)
      }
      if (matched.length === 0) continue
      matchingFiles.push(file)
      if (input.filesWithMatches) continue
      if (input.symbols) contents.set(file, lines)
      const selected = new Set<number>()
      for (const index of matched) {
        for (
          let line = Math.max(0, index - input.beforeContext);
          line <= Math.min(lines.length - 1, index + input.afterContext);
          line++
        ) {
          selected.add(line)
        }
      }
      const matchedSet = new Set(matched)
      for (const index of [...selected].sort((left, right) => left - right)) {
        output.push({
          file,
          line: index + 1,
          text: preview(lines[index] ?? ""),
          kind: matchedSet.has(index) ? "match" : "context"
        })
      }
    }

    const grouped = input.filesWithMatches ? [] : Grouping.group(output)
    const entries = input.filesWithMatches ? matchingFiles : grouped
    const truncated = entries.length > input.limit
    const shownMatches = Grouping.annotate(grouped.slice(0, input.limit), contents)
    const shownFiles = input.filesWithMatches ? matchingFiles.slice(0, input.limit) : []
    const unsatisfiable = entries.length > 0 ? undefined : yield* Contract.unsatisfiableNotice({
      fileSystem,
      path,
      root: input.root,
      globs: input.globs,
      hidden: input.hidden
    })
    return {
      matches: shownMatches,
      files: shownFiles,
      filesSearched,
      skippedBinary,
      truncated,
      ...(truncated
        ? { notice: notice(input.filesWithMatches ? "files" : "matches", input.limit, entries.length) }
        : {}),
      ...(unsatisfiable === undefined ? {} : { notice: unsatisfiable })
    }
  })

const glob = (
  input: Search.GlobInput
): Effect.Effect<Search.GlobOutput, StdError.StdError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const walked = yield* walkFiles(fileSystem, path, input.root, input.hidden)
    const included = yield* candidates(fileSystem, path, walked, input.root, [input.pattern])
    const matching = [...included].sort()
    const paths = matching.slice(0, input.limit)
    const unsatisfiable = matching.length > 0 ? undefined : yield* Contract.unsatisfiableNotice({
      fileSystem,
      path,
      root: input.root,
      globs: [input.pattern],
      hidden: input.hidden
    })
    return {
      paths,
      total: matching.length,
      truncated: matching.length > input.limit,
      ...(matching.length > input.limit ? { notice: notice("entries", paths.length, matching.length) } : {}),
      ...(unsatisfiable === undefined ? {} : { notice: unsatisfiable })
    }
  })

/**
 * Captures filesystem and path services in the portable peer.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (services: Context.Context<FileSystem.FileSystem | Path.Path>): Search.Search =>
  Search.make({
    grep: (input) => Effect.provide(grep(input), services),
    glob: (input) => Effect.provide(glob(input), services)
  })

/**
 * Provides the in-process peer.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<Search.Search, never, FileSystem.FileSystem | Path.Path> = Layer.effect(
  Search.Search,
  Effect.map(Effect.context<FileSystem.FileSystem | Path.Path>(), make)
)
