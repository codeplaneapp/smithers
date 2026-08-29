/**
 * Workspace configuration declared in the root BUILD.ts file.
 *
 * A configuration value is inert: {@link Workspace} validates its fields and
 * performs no I/O, so BUILD.ts evaluation stays pure. The CLI discovers the
 * declaration and resolves it against the `--cache-dir` flag. The CLI passes
 * the result explicitly to input expansion and tool execution as host state.
 *
 * The resolved cache directory is explicit host state rather than target attrs
 * on purpose. It names where scratch and cache files live on one host, so it
 * must never reach a cache key or a content digest.
 *
 * @since 0.1.0
 */
import * as NodeUtil from "node:util/types"

/**
 * Runtime marker for a workspace configuration declaration.
 *
 * @category type ids
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("smithers-build/Workspace") as never

/**
 * The cache directory used when no BUILD.ts declaration and no flag name one.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultCacheDirectory = ".flows"

/**
 * Maximum UTF-8 size of a normalized cache-directory path.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumCacheDirectoryBytes = 4 * 1024

/**
 * Maximum UTF-8 size of one cache-directory path segment.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumCacheDirectorySegmentBytes = 255

/**
 * A pure workspace configuration declaration.
 *
 * `cacheDirectory` is a workspace-relative directory holding the result cache
 * and target scratch files. `gitignored` asks the CLI to keep a root
 * `.gitignore` entry for it.
 *
 * @category models
 * @since 0.1.0
 */
export interface Workspace {
  readonly [TypeId]: typeof TypeId
  readonly cacheDirectory: string
  readonly gitignored: boolean
}

/**
 * Options accepted by {@link Workspace}.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /** @default ".flows" */
  readonly cacheDirectory?: string | undefined
  /** @default false */
  readonly gitignored?: boolean | undefined
}

const absolute = /^([/\\]|[A-Za-z]:)/

/**
 * Validates one declared cache directory and returns its normalized posix
 * form.
 *
 * The value names a single workspace-relative directory. Surrounding
 * whitespace, redundant separators, and `.` segments are dropped. An empty
 * value, an absolute path, and any `..` segment are refused, so the directory
 * can never escape the workspace.
 *
 * @category validation
 * @since 0.1.0
 */
export const normalizeCacheDirectory = (value: string): string => {
  if (typeof value !== "string") throw new TypeError("cacheDirectory must be a string")
  if (value.length > maximumCacheDirectoryBytes) {
    throw new Error(`cacheDirectory must be at most ${maximumCacheDirectoryBytes} UTF-8 bytes`)
  }
  const trimmed = value.trim()
  if (trimmed === "") throw new Error("cacheDirectory must not be empty")
  if (!trimmed.isWellFormed() || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error("cacheDirectory must be well-formed text without control characters")
  }
  if (absolute.test(trimmed)) throw new Error(`cacheDirectory must be workspace-relative: ${value}`)
  const segments = trimmed.split(/[/\\]/).filter((segment) => segment !== "" && segment !== ".")
  if (segments.length === 0) throw new Error("cacheDirectory must not be empty")
  if (segments.includes("..")) throw new Error(`cacheDirectory must not leave the workspace: ${value}`)
  const encoder = new TextEncoder()
  for (const segment of segments) {
    if (encoder.encode(segment).byteLength > maximumCacheDirectorySegmentBytes) {
      throw new Error(
        `cacheDirectory segments must be at most ${maximumCacheDirectorySegmentBytes} UTF-8 bytes`
      )
    }
  }
  const normalized = segments.join("/")
  if (encoder.encode(normalized).byteLength > maximumCacheDirectoryBytes) {
    throw new Error(`cacheDirectory must be at most ${maximumCacheDirectoryBytes} UTF-8 bytes`)
  }
  return normalized
}

/**
 * Creates a pure workspace configuration declaration using BUILD.ts syntax.
 *
 * @example
 * ```ts
 * import { Workspace } from "@smthrs/targets/Config"
 *
 * export const workspace = Workspace({
 *   cacheDirectory: ".flows",
 *   gitignored: true
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const Workspace = (options: Options = {}): Workspace => {
  if (
    typeof options !== "object" || options === null || NodeUtil.isProxy(options) ||
    (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)
  ) throw new TypeError("Workspace options must be a plain object")
  const names = Object.getOwnPropertyNames(options)
  if (Object.getOwnPropertySymbols(options).length > 0) {
    throw new TypeError("Workspace options must not contain symbol properties")
  }
  for (const name of names) {
    if (name !== "cacheDirectory" && name !== "gitignored") {
      throw new TypeError(`Workspace received unknown option ${JSON.stringify(name)}`)
    }
  }
  const read = (name: "cacheDirectory" | "gitignored"): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(options, name)
    if (descriptor === undefined) return undefined
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`Workspace option ${name} must be an enumerable data property`)
    }
    return descriptor.value
  }
  const cacheDirectory = read("cacheDirectory")
  const gitignored = read("gitignored")
  if (cacheDirectory !== undefined && typeof cacheDirectory !== "string") {
    throw new TypeError("Workspace option cacheDirectory must be a string")
  }
  if (gitignored !== undefined && typeof gitignored !== "boolean") {
    throw new TypeError("Workspace option gitignored must be a boolean")
  }
  return Object.freeze<Workspace>({
    [TypeId]: TypeId,
    cacheDirectory: cacheDirectory === undefined
      ? defaultCacheDirectory
      : normalizeCacheDirectory(cacheDirectory),
    gitignored: gitignored ?? false
  })
}

/**
 * Checks whether a BUILD.ts export is a workspace configuration declaration.
 *
 * @category guards
 * @since 0.1.0
 */
export const isWorkspace = (value: unknown): value is Workspace => {
  if (typeof value !== "object" || value === null || NodeUtil.isProxy(value)) return false
  const own = (key: PropertyKey): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
  }
  return own(TypeId) === TypeId &&
    typeof own("cacheDirectory") === "string" &&
    typeof own("gitignored") === "boolean"
}
