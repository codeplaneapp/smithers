import { randomUUID } from "node:crypto"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const redacted = "__SMITHERS_CACHE_TOKEN_REDACTED__"

/**
 * The Worker bindings that carry a cache credential.
 *
 * `CACHE_TOKEN` is the single-credential deployment this service had before
 * reads and writes were separated. Legacy state can still hold it, so it stays
 * on the list.
 */
const credentialBindingNames = new Set(["CACHE_TOKEN", "CACHE_READ_TOKEN", "CACHE_WRITE_TOKEN"])

const credentialEnvironmentNames = [
  "SMITHERS_CACHE_TOKEN",
  "SMITHERS_CACHE_READ_TOKEN",
  "SMITHERS_CACHE_WRITE_TOKEN"
] as const
const infraDirectory = NodePath.dirname(NodePath.dirname(fileURLToPath(import.meta.url)))
const defaultStateDirectory = NodePath.join(infraDirectory, ".alchemy", "state", "SmithersBuildRemoteCache")

/** Maximum bytes accepted from one Alchemy state file. */
export const maximumStateFileBytes = 16 * 1024 * 1024

const maximumRenderedStateBytes = 32 * 1024 * 1024
const maximumDirectoryEntries = 100_000
const maximumWorkerStateFiles = 1_024
const maximumJsonDepth = 128
const maximumJsonMembers = 100_000

/** Optional state location and token override, primarily for isolated tooling and tests. */
export interface RedactAlchemyStateOptions {
  readonly directory?: string | undefined
  readonly bearerToken?: string | undefined
}

interface FileIdentity {
  readonly dev: bigint
  readonly ino: bigint
  readonly size: bigint
  readonly mtimeNs: bigint
  readonly ctimeNs: bigint
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const normalizeOptions = (value: RedactAlchemyStateOptions): {
  readonly bearerTokens: ReadonlyArray<string>
  readonly directory: string
} => {
  let prototype: object | null
  let keys: Array<string | symbol>
  try {
    if (!isRecord(value)) throw new TypeError("redaction options must be a plain record")
    prototype = Object.getPrototypeOf(value) as object | null
    keys = Reflect.ownKeys(value)
  } catch {
    throw new TypeError("redaction options must be inspectable plain data")
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("redaction options must be a plain record")
  }
  const allowed = new Set(["directory", "bearerToken"])
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`redaction options contain an unknown property: ${String(key)}`)
    }
  }
  const read = (key: "directory" | "bearerToken"): unknown => {
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key)
    } catch {
      throw new TypeError(`redaction option ${key} could not be inspected safely`)
    }
    if (descriptor === undefined) return undefined
    if (!("value" in descriptor)) throw new TypeError(`redaction option ${key} must be a data property`)
    return descriptor.value
  }
  const configuredDirectory = read("directory")
  const directory = configuredDirectory ?? defaultStateDirectory
  const configuredToken = read("bearerToken")
  if (typeof directory !== "string" || !NodePath.isAbsolute(directory)) {
    throw new TypeError("Alchemy state directory must be an absolute path")
  }
  if (configuredToken !== undefined && typeof configuredToken !== "string") {
    throw new TypeError("Alchemy state bearer token must be a string when supplied")
  }
  // Without an override, every credential this service can be deployed with is
  // scrubbed. Missing one would leave a raw value in state that the operator
  // believes was redacted.
  const bearerTokens = configuredToken !== undefined
    ? [configuredToken]
    : credentialEnvironmentNames
      .map((name) => process.env[name])
      .filter((token): token is string => typeof token === "string" && token !== "")
  return { bearerTokens, directory }
}

const errorCode = (value: unknown): string | undefined => {
  try {
    if (!isRecord(value)) return undefined
    const descriptor = Object.getOwnPropertyDescriptor(value, "code")
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value
      : undefined
  } catch {
    return undefined
  }
}

const failureMessage = (value: unknown): string => {
  try {
    if (value instanceof Error) {
      const descriptor = Object.getOwnPropertyDescriptor(value, "message")
      if (descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string") {
        return descriptor.value
      }
    }
  } catch {
    // Fall through to the deliberately generic message.
  }
  return "unrenderable failure"
}

const optionalOpenFlag = (name: "O_NOFOLLOW" | "O_NONBLOCK"): number =>
  (NodeFs.constants as Partial<Record<string, number>>)[name] ?? 0

const inside = (root: string, path: string): boolean => {
  const relative = NodePath.relative(root, path)
  return relative === "" ||
    (!relative.startsWith(`..${NodePath.sep}`) && relative !== ".." && !NodePath.isAbsolute(relative))
}

const identityOf = (stat: NodeFs.BigIntStats): FileIdentity => ({
  dev: stat.dev,
  ino: stat.ino,
  size: stat.size,
  mtimeNs: stat.mtimeNs,
  ctimeNs: stat.ctimeNs
})

const sameIdentity = (left: FileIdentity, right: NodeFs.BigIntStats): boolean =>
  right.isFile() &&
  right.nlink === 1n &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs

const validateJsonBudget = (root: unknown): void => {
  const pending: Array<{ readonly depth: number; readonly value: unknown }> = [{ depth: 0, value: root }]
  let members = 0
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) break
    members += 1
    if (members > maximumJsonMembers) throw new RangeError("Alchemy state has too many JSON members")
    if (current.depth > maximumJsonDepth) throw new RangeError("Alchemy state is nested too deeply")
    if (Array.isArray(current.value)) {
      if (members + pending.length + current.value.length > maximumJsonMembers) {
        throw new RangeError("Alchemy state has too many JSON members")
      }
      for (const value of current.value) pending.push({ depth: current.depth + 1, value })
    } else if (isRecord(current.value)) {
      const keys = Object.keys(current.value)
      if (members + pending.length + keys.length > maximumJsonMembers) {
        throw new RangeError("Alchemy state has too many JSON members")
      }
      for (const key of keys) pending.push({ depth: current.depth + 1, value: current.value[key] })
    }
  }
}

const readStateFile = async (file: string): Promise<{ readonly identity: FileIdentity; readonly state: unknown }> => {
  const expected = await Fs.lstat(file, { bigint: true })
  if (!expected.isFile() || expected.nlink !== 1n) {
    throw new TypeError(`Alchemy state path is not a singly linked regular file: ${file}`)
  }
  if (expected.size > BigInt(maximumStateFileBytes)) {
    throw new RangeError(`Alchemy state file exceeds ${maximumStateFileBytes} bytes: ${file}`)
  }

  const handle = await Fs.open(
    file,
    NodeFs.constants.O_RDONLY | optionalOpenFlag("O_NOFOLLOW") | optionalOpenFlag("O_NONBLOCK")
  )
  let identity: FileIdentity | undefined
  let bytes: Buffer | undefined
  let primary: unknown
  try {
    const opened = await handle.stat({ bigint: true })
    const expectedIdentity = identityOf(expected)
    if (!sameIdentity(expectedIdentity, opened) || opened.size > BigInt(maximumStateFileBytes)) {
      throw new Error(`Alchemy state file changed before it could be read safely: ${file}`)
    }
    const buffer = Buffer.allocUnsafe(Number(opened.size) + 1)
    let total = 0
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total)
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length - total) {
        throw new Error(`Alchemy state file returned an invalid read length: ${file}`)
      }
      if (bytesRead === 0) break
      total += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    if (!sameIdentity(expectedIdentity, after) || BigInt(total) !== opened.size) {
      throw new Error(`Alchemy state file changed while it was being read: ${file}`)
    }
    identity = expectedIdentity
    bytes = buffer.subarray(0, total)
  } catch (error) {
    primary = error
  }
  try {
    await handle.close()
  } catch (error) {
    primary ??= error
  }
  if (primary !== undefined) throw primary
  if (identity === undefined || bytes === undefined) throw new Error(`Alchemy state file could not be read: ${file}`)

  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)
  } catch {
    throw new TypeError(`Alchemy state file is not valid UTF-8: ${file}`)
  }
  let state: unknown
  try {
    state = JSON.parse(text) as unknown
  } catch {
    throw new TypeError(`Alchemy state file is not valid JSON: ${file}`)
  }
  validateJsonBudget(state)
  return { identity, state }
}

const isCredentialBinding = (name: unknown): boolean => typeof name === "string" && credentialBindingNames.has(name)

const redactWorkerState = (value: unknown, bearerTokens: ReadonlyArray<string>): boolean => {
  if (!isRecord(value)) return false
  let changed = false
  const isBearer = (candidate: unknown): boolean => typeof candidate === "string" && bearerTokens.includes(candidate)

  const props = isRecord(value["props"]) ? value["props"] : null
  const env = props !== null && isRecord(props["env"]) ? props["env"] : null
  for (const [name, entry] of env === null ? [] : Object.entries(env)) {
    if (!isCredentialBinding(name) || !isRecord(entry) || !isBearer(entry["__redacted__"])) continue
    changed = true
    entry["__redacted__"] = redacted
  }

  const bindings = value["bindings"]
  if (!Array.isArray(bindings)) return changed
  for (const binding of bindings) {
    if (!isRecord(binding) || !isCredentialBinding(binding["sid"])) continue
    const data = isRecord(binding["data"]) ? binding["data"] : null
    const nativeBindings = data?.["bindings"]
    if (!Array.isArray(nativeBindings)) continue
    for (const nativeBinding of nativeBindings) {
      if (
        !isRecord(nativeBinding) ||
        nativeBinding["type"] !== "secret_text" ||
        !isCredentialBinding(nativeBinding["name"])
      ) continue
      if (isBearer(nativeBinding["text"])) {
        changed = true
        nativeBinding["text"] = redacted
      }
    }
  }
  return changed
}

const directorySyncUnsupported = new Set(["ENOTSUP", "EOPNOTSUPP", "EINVAL", "ENOSYS"])

const syncDirectory = async (directory: string): Promise<void> => {
  if (process.platform === "win32") return
  const handle = await Fs.open(directory, "r")
  let primary: unknown
  try {
    await handle.sync()
  } catch (error) {
    if (!directorySyncUnsupported.has(errorCode(error) ?? "")) primary = error
  }
  try {
    await handle.close()
  } catch (error) {
    primary ??= error
  }
  if (primary !== undefined) throw primary
}

const createTemporaryFile = async (
  directory: string,
  base: string
): Promise<{ readonly file: string; readonly handle: Fs.FileHandle }> => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const file = NodePath.join(directory, `.${base}.${process.pid.toString(36)}.${randomUUID()}.tmp`)
    try {
      return { file, handle: await Fs.open(file, "wx", 0o600) }
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error
    }
  }
  throw new Error(`could not create a unique temporary state file in ${directory}`)
}

const assertCanonicalDirectory = async (root: string, directory: string): Promise<void> => {
  const resolved = await Fs.realpath(directory)
  if (resolved !== directory || !inside(root, resolved)) {
    throw new TypeError(`Alchemy state directory escaped its canonical root: ${directory}`)
  }
}

const writeStateFile = async (
  root: string,
  file: string,
  identity: FileIdentity,
  contents: string
): Promise<void> => {
  const directory = NodePath.dirname(file)
  await assertCanonicalDirectory(root, directory)
  if (!sameIdentity(identity, await Fs.lstat(file, { bigint: true }))) {
    throw new Error(`Alchemy state file changed before redaction could be published: ${file}`)
  }
  const temporary = await createTemporaryFile(directory, NodePath.basename(file))
  let closed = false
  let renamed = false
  let primary: unknown
  try {
    await temporary.handle.writeFile(contents, "utf8")
    await temporary.handle.sync()
  } catch (error) {
    primary = error
  }
  try {
    await temporary.handle.close()
    closed = true
  } catch (error) {
    primary ??= error
  }
  if (primary === undefined) {
    try {
      await assertCanonicalDirectory(root, directory)
      if (!sameIdentity(identity, await Fs.lstat(file, { bigint: true }))) {
        throw new Error(`Alchemy state file changed before redaction could be published: ${file}`)
      }
      await Fs.rename(temporary.file, file)
      renamed = true
      await syncDirectory(directory)
    } catch (error) {
      primary = error
    }
  }
  if (!closed) {
    try {
      await temporary.handle.close()
    } catch (error) {
      primary ??= error
    }
  }
  if (!renamed) {
    try {
      await Fs.rm(temporary.file, { force: true })
    } catch (error) {
      primary ??= error
    }
  }
  if (primary !== undefined) throw primary
}

const redactFile = async (
  root: string,
  file: string,
  bearerTokens: ReadonlyArray<string>
): Promise<boolean> => {
  const { identity, state } = await readStateFile(file)
  if (!redactWorkerState(state, bearerTokens)) return false
  const rendered = `${JSON.stringify(state, null, 2)}\n`
  if (Buffer.byteLength(rendered, "utf8") > maximumRenderedStateBytes) {
    throw new RangeError(`redacted Alchemy state exceeds ${maximumRenderedStateBytes} bytes: ${file}`)
  }
  await writeStateFile(root, file, identity, rendered)
  return true
}

const discoverWorkerStates = async (
  directory: string
): Promise<{ readonly files: ReadonlyArray<string>; readonly root: string } | null> => {
  const requestedRoot = NodePath.resolve(directory)
  let root: string
  try {
    root = await Fs.realpath(requestedRoot)
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null
    throw error
  }
  if (root !== requestedRoot) {
    throw new TypeError(`symbolic links are not allowed in the Alchemy state root: ${directory}`)
  }
  if (!(await Fs.lstat(root)).isDirectory()) throw new TypeError(`Alchemy state root is not a directory: ${root}`)

  const directories = [root]
  const files: Array<string> = []
  let entries = 0
  for (let index = 0; index < directories.length; index += 1) {
    const current = directories[index]
    if (current === undefined) break
    await assertCanonicalDirectory(root, current)
    const handle = await Fs.opendir(current)
    for await (const entry of handle) {
      entries += 1
      if (entries > maximumDirectoryEntries) {
        throw new RangeError(`Alchemy state tree exceeds ${maximumDirectoryEntries} directory entries`)
      }
      const candidate = NodePath.join(current, entry.name)
      if (entry.isSymbolicLink()) throw new TypeError(`symbolic links are not allowed in Alchemy state: ${candidate}`)
      if (entry.isDirectory()) {
        const resolved = await Fs.realpath(candidate)
        if (!inside(root, resolved)) throw new TypeError(`Alchemy state directory escapes its root: ${candidate}`)
        directories.push(resolved)
      } else if (entry.name === "CacheWorker.json") {
        if (!entry.isFile()) throw new TypeError(`Alchemy Worker state is not a regular file: ${candidate}`)
        const resolved = await Fs.realpath(candidate)
        if (!inside(root, resolved)) throw new TypeError(`Alchemy Worker state escapes its root: ${candidate}`)
        files.push(resolved)
        if (files.length > maximumWorkerStateFiles) {
          throw new RangeError(`Alchemy state tree exceeds ${maximumWorkerStateFiles} Worker state files`)
        }
      }
    }
  }
  files.sort()
  return { files, root }
}

/**
 * Removes a raw Worker bearer value from legacy Alchemy local state.
 *
 * State discovery and reads are bounded, links are refused, and each changed
 * file is published with the same write-sync-rename-directory-sync sequence
 * used for other durable repository state.
 */
export const redactAlchemyState = async (options: RedactAlchemyStateOptions = {}): Promise<number> => {
  const { bearerTokens, directory } = normalizeOptions(options)
  const discovered = await discoverWorkerStates(directory)
  if (discovered === null) return 0
  let changed = 0
  for (const file of discovered.files) {
    if (await redactFile(discovered.root, file, bearerTokens)) changed += 1
  }
  return changed
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    const count = await redactAlchemyState()
    process.stdout.write(`Redacted ${count} Alchemy Worker state file(s).\n`)
  } catch (error) {
    process.stderr.write(`Alchemy state redaction failed: ${failureMessage(error)}\n`)
    process.exitCode = 1
  }
}
