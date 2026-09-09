/**
 * Scrubs cache credentials from persisted deployment state.
 *
 * @since 0.1.0
 */
import { isRecord } from "@smthrs/canonical/Record"
import { createHash, randomUUID } from "node:crypto"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { stackName } from "../deployment.ts"
import { failureMessage } from "./failure-message.ts"

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

/**
 * Where the deployment keeps the state this script scrubs.
 *
 * The stack name is the state directory. Importing it keeps a rename from
 * silently turning redaction into a no-op that reports success.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultStateDirectory = NodePath.join(infraDirectory, ".alchemy", "state", stackName)

/**
 * Maximum bytes accepted from one Alchemy state file.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumStateFileBytes = 16 * 1024 * 1024

const maximumRenderedStateBytes = 32 * 1024 * 1024
const maximumDirectoryEntries = 100_000
const maximumWorkerStateFiles = 1_024
const maximumJsonDepth = 128
const maximumJsonMembers = 100_000

/**
 * Optional state location and token override, primarily for isolated tooling and tests.
 *
 * @category models
 * @since 0.1.0
 */
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

/**
 * What one redaction run walks and what it may leave in place.
 *
 * @category models
 * @since 0.1.0
 */
export interface RedactionTargets {
  /** The values a credential binding may hold: the sentinel and every current verifier. */
  readonly permitted: ReadonlySet<string>
  readonly directory: string
}

/**
 * Resolves the options into the state directory and the permitted values.
 *
 * Without a directory the run walks {@link defaultStateDirectory}; without a
 * token every credential this service can be deployed with is read from the
 * environment. Every option is read as plain data, so an accessor never runs.
 *
 * @category constructors
 * @since 0.1.0
 */
export const resolveRedactionOptions = (value: RedactAlchemyStateOptions): RedactionTargets => {
  if (!isRecord(value)) throw new TypeError("redaction options must be a plain record")
  let prototype: object | null
  let keys: Array<string | symbol>
  try {
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
  // considered. Missing one would leave a raw value in state that the operator
  // believes was redacted.
  const bearerTokens = configuredToken !== undefined
    ? [configuredToken]
    : credentialEnvironmentNames
      .map((name) => process.env[name])
      .filter((token): token is string => typeof token === "string" && token !== "")
  if (bearerTokens.includes(redacted)) {
    throw new TypeError("a cache bearer token must not be the redaction sentinel")
  }
  // Redaction fails closed: a credential binding may hold the sentinel or a
  // verifier derived from a currently configured bearer, and nothing else.
  // Matching known bearer values instead would leave a rotated-away
  // credential in place while still reporting success.
  const permitted = new Set([
    redacted,
    ...bearerTokens.map((token) => createHash("sha256").update(token, "utf8").digest("hex"))
  ])
  return { permitted, directory }
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
  // Each container is charged for its children before they are queued, so
  // the running count can never pass the budget between checks.
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    members += 1
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

/**
 * Audits member names in text already accepted by JSON.parse. Like the
 * protocol prescan, this keeps a separate name set for each object and
 * decodes escaped keys before comparing them. Parsed values alone cannot
 * expose credentials hidden in members that JSON.parse discarded.
 */
const assertNoDuplicateJsonMembers = (text: string): void => {
  const scopes: Array<Set<string> | null> = []
  let keyScope: Set<string> | null = null
  let index = 0
  while (index < text.length) {
    const character = text.charAt(index)
    if (character === "{") {
      keyScope = new Set<string>()
      scopes.push(keyScope)
      index += 1
    } else if (character === "[") {
      scopes.push(null)
      keyScope = null
      index += 1
    } else if (character === "}" || character === "]") {
      scopes.pop()
      keyScope = null
      index += 1
    } else if (character === ",") {
      const enclosing = scopes.at(-1)
      keyScope = enclosing instanceof Set ? enclosing : null
      index += 1
    } else if (character === ":") {
      keyScope = null
      index += 1
    } else if (character === "\"") {
      let end = index + 1
      // Valid JSON guarantees a closing quote; escaped quotes are skipped.
      while (text.charAt(end) !== "\"") end += text.charAt(end) === "\\" ? 2 : 1
      if (keyScope !== null) {
        const name = JSON.parse(text.slice(index, end + 1)) as string
        if (keyScope.has(name)) throw new TypeError("Alchemy state contains a duplicate object member name")
        keyScope.add(name)
      }
      index = end + 1
    } else index += 1
  }
}

/**
 * Runs `use` over an open handle and closes the handle afterwards.
 *
 * The operation's own failure is the one reported: a close that fails after
 * it is not allowed to replace it, while a close that fails after a success
 * is a failure of its own, since the bytes it was flushing may be lost.
 */
const usingHandle = async <A>(handle: Fs.FileHandle, use: () => Promise<A>): Promise<A> => {
  let value: A
  try {
    value = await use()
  } catch (error) {
    try {
      await handle.close()
    } catch {
      // The operation's failure is the report.
    }
    throw error
  }
  await handle.close()
  return value
}

const readStateFile = async (file: string): Promise<{ readonly identity: FileIdentity; readonly state: unknown }> => {
  const expected = await Fs.lstat(file, { bigint: true })
  if (!expected.isFile() || expected.nlink !== 1n) {
    throw new TypeError(`Alchemy state path is not a singly linked regular file: ${file}`)
  }
  if (expected.size > BigInt(maximumStateFileBytes)) {
    throw new RangeError(`Alchemy state file exceeds ${maximumStateFileBytes} bytes: ${file}`)
  }

  const identity = identityOf(expected)
  const handle = await Fs.open(
    file,
    NodeFs.constants.O_RDONLY | optionalOpenFlag("O_NOFOLLOW") | optionalOpenFlag("O_NONBLOCK")
  )
  const bytes = await usingHandle(handle, async () => {
    const opened = await handle.stat({ bigint: true })
    if (!sameIdentity(identity, opened) || opened.size > BigInt(maximumStateFileBytes)) {
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
    if (!sameIdentity(identity, after) || BigInt(total) !== opened.size) {
      throw new Error(`Alchemy state file changed while it was being read: ${file}`)
    }
    return buffer.subarray(0, total)
  })

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
  assertNoDuplicateJsonMembers(text)
  return { identity, state }
}

const isCredentialBinding = (name: unknown): name is string =>
  typeof name === "string" && credentialBindingNames.has(name)

const unrecognizedCredentialBinding = (name: string): TypeError =>
  new TypeError(`Alchemy state holds an unrecognized shape for credential binding ${name}`)

const assertNoUnhandledCredentialBindings = (
  root: unknown,
  permitted: ReadonlySet<string>,
  handledKeyContainers: WeakSet<object>,
  handledNameRecords: WeakSet<object>,
  handledSidRecords: WeakSet<object>
): void => {
  /**
   * Reports a value under an unhandled credential name as provably clean.
   *
   * Only the two renderings this scrubber writes qualify: the sentinel or a
   * verifier derived from a currently configured bearer, bare or wrapped in
   * Alchemy's `__redacted__` envelope. Everything else, including a shorter
   * or longer object, could be carrying the bearer.
   */
  const provablyClean = (candidate: unknown): boolean => {
    if (typeof candidate === "string") return permitted.has(candidate)
    if (!isRecord(candidate)) return false
    const keys = Object.keys(candidate)
    if (keys.length !== 1 || keys[0] !== "__redacted__") return false
    const inner = candidate["__redacted__"]
    return typeof inner === "string" && permitted.has(inner)
  }
  const pending: Array<unknown> = [root]
  while (pending.length > 0) {
    const current = pending.pop()
    if (Array.isArray(current)) {
      for (const member of current) pending.push(member)
      continue
    }
    if (!isRecord(current)) continue
    for (const [key, member] of Object.entries(current)) {
      // An Alchemy state file may echo the worker's inputs into a field this
      // scrubber does not write, and after a successful run that echo already
      // holds the scrubbed value. Refusing it would fail every deployment
      // after the first with no credential at risk, so refuse only what
      // cannot be proven clean.
      if (isCredentialBinding(key) && !handledKeyContainers.has(current) && !provablyClean(member)) {
        throw unrecognizedCredentialBinding(key)
      }
      if (key === "name" && isCredentialBinding(member) && !handledNameRecords.has(current)) {
        throw unrecognizedCredentialBinding(member)
      }
      if (key === "sid" && isCredentialBinding(member) && !handledSidRecords.has(current)) {
        throw unrecognizedCredentialBinding(member)
      }
      pending.push(member)
    }
  }
}

const redactWorkerState = (value: unknown, permitted: ReadonlySet<string>): boolean => {
  let changed = false
  const handledKeyContainers = new WeakSet<object>()
  const handledNameRecords = new WeakSet<object>()
  const handledSidRecords = new WeakSet<object>()
  // Fail closed on the value's type as well as its content: a credential
  // binding holding a number, an array, or an object with the bearer nested
  // inside it is exactly the shape a string-only test walks past while the
  // wrapper reports a successful redaction.
  const mustRedact = (candidate: unknown): boolean => typeof candidate !== "string" || !permitted.has(candidate)

  const props = isRecord(value) && isRecord(value["props"]) ? value["props"] : null
  const env = props !== null && isRecord(props["env"]) ? props["env"] : null
  if (env !== null) {
    handledKeyContainers.add(env)
    for (const [name, entry] of Object.entries(env)) {
      if (!isCredentialBinding(name)) continue
      if (isRecord(entry)) {
        if (!Object.hasOwn(entry, "__redacted__")) {
          // Refusing beats reporting success over a shape this script cannot
          // prove is credential free.
          throw unrecognizedCredentialBinding(name)
        }
        if (Object.keys(entry).some((key) => key !== "__redacted__")) {
          // A recognized verifier beside an unrecognized field is not clean:
          // the sibling may be the raw bearer from a newer Alchemy state
          // representation. Accept only the one shape this scrubber proves.
          throw unrecognizedCredentialBinding(name)
        }
        if (!mustRedact(entry["__redacted__"])) continue
        changed = true
        entry["__redacted__"] = redacted
        continue
      }
      if (!mustRedact(entry)) continue
      changed = true
      env[name] = redacted
    }
  }

  const bindings = isRecord(value) ? value["bindings"] : undefined
  if (Array.isArray(bindings)) {
    for (const binding of bindings) {
      if (!isRecord(binding)) continue
      const sid = binding["sid"]
      const data = binding["data"]
      if (!isRecord(data) || !Array.isArray(data["bindings"])) {
        if (isCredentialBinding(sid)) throw unrecognizedCredentialBinding(sid)
        continue
      }
      const nativeBindings = data["bindings"]
      let containsCredentialBinding = false
      for (const nativeBinding of nativeBindings) {
        if (!isRecord(nativeBinding)) {
          if (isCredentialBinding(sid)) throw unrecognizedCredentialBinding(sid)
          continue
        }
        const name = nativeBinding["name"]
        if (!isCredentialBinding(name)) continue
        containsCredentialBinding = true
        if (
          !Object.hasOwn(nativeBinding, "text") ||
          Object.keys(nativeBinding).some((key) => !["name", "text", "type"].includes(key)) ||
          (Object.hasOwn(nativeBinding, "type") && typeof nativeBinding["type"] !== "string")
        ) {
          throw unrecognizedCredentialBinding(name)
        }
        handledNameRecords.add(nativeBinding)
        // The binding name is the trust boundary in both Alchemy representations.
        // Trusting the native type would let a credential survive under a label
        // such as `plain_text` while the environment half rejects the same shape.
        if (mustRedact(nativeBinding["text"])) {
          changed = true
          nativeBinding["text"] = redacted
        }
      }
      if (isCredentialBinding(sid)) {
        if (!containsCredentialBinding) throw unrecognizedCredentialBinding(sid)
        handledSidRecords.add(binding)
      }
    }
  }
  // Walk the whole decoded document after handling the two known Alchemy
  // representations. A credential name moved one level deeper, into another
  // props field, or behind a new wrapper is an unknown state format, not a
  // clean state file.
  assertNoUnhandledCredentialBindings(
    value,
    permitted,
    handledKeyContainers,
    handledNameRecords,
    handledSidRecords
  )
  return changed
}

const directorySyncUnsupported = new Set(["ENOTSUP", "EOPNOTSUPP", "EINVAL", "ENOSYS"])

const syncDirectory = async (directory: string): Promise<void> => {
  if (process.platform === "win32") return
  const handle = await Fs.open(directory, "r")
  await usingHandle(handle, async () => {
    try {
      await handle.sync()
    } catch (error) {
      if (!directorySyncUnsupported.has(errorCode(error) ?? "")) throw error
    }
  })
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
  try {
    await usingHandle(temporary.handle, async () => {
      await temporary.handle.writeFile(contents, "utf8")
      await temporary.handle.sync()
    })
    await assertCanonicalDirectory(root, directory)
    if (!sameIdentity(identity, await Fs.lstat(file, { bigint: true }))) {
      throw new Error(`Alchemy state file changed before redaction could be published: ${file}`)
    }
    await Fs.rename(temporary.file, file)
  } catch (error) {
    try {
      await Fs.rm(temporary.file, { force: true })
    } catch {
      // The failure above is the report; a temporary file left behind is not.
    }
    throw error
  }
  // The rename is durable only once the directory entry is, and a sync that
  // fails here leaves the redacted file in place, so nothing is removed.
  await syncDirectory(directory)
}

const redactFile = async (
  root: string,
  file: string,
  permitted: ReadonlySet<string>
): Promise<boolean> => {
  const { identity, state } = await readStateFile(file)
  if (!redactWorkerState(state, permitted)) return false
  let rendered = `${JSON.stringify(state, null, 2)}\n`
  if (Buffer.byteLength(rendered, "utf8") > maximumRenderedStateBytes) {
    throw new RangeError(`redacted Alchemy state exceeds ${maximumRenderedStateBytes} bytes: ${file}`)
  }
  // Preserve the rendering budget above, but never publish bytes a later
  // redaction cannot read. Deep indentation can dwarf the compact input.
  if (Buffer.byteLength(rendered, "utf8") > maximumStateFileBytes) {
    rendered = `${JSON.stringify(state)}\n`
    if (Buffer.byteLength(rendered, "utf8") > maximumStateFileBytes) {
      throw new RangeError(`redacted Alchemy state exceeds ${maximumStateFileBytes} bytes: ${file}`)
    }
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
  // Array iteration observes the directories pushed while it runs, so this
  // walks every subtree it discovers.
  for (const current of directories) {
    await assertCanonicalDirectory(root, current)
    const handle = await Fs.opendir(current)
    for await (const entry of handle) {
      entries += 1
      if (entries > maximumDirectoryEntries) {
        throw new RangeError(`Alchemy state tree exceeds ${maximumDirectoryEntries} directory entries`)
      }
      const candidate = NodePath.join(current, entry.name)
      if (entry.isSymbolicLink()) throw new TypeError(`symbolic links are not allowed in Alchemy state: ${candidate}`)
      // The name is checked before the kind: a directory or a device named
      // like Worker state is a state file the read path cannot scrub, and
      // walking past it would report success over whatever it hides.
      if (entry.name.startsWith("CacheWorker.json")) {
        if (!entry.isFile()) throw new TypeError(`Alchemy Worker state is not a regular file: ${candidate}`)
        const resolved = await Fs.realpath(candidate)
        if (!inside(root, resolved)) throw new TypeError(`Alchemy Worker state escapes its root: ${candidate}`)
        files.push(resolved)
        if (files.length > maximumWorkerStateFiles) {
          throw new RangeError(`Alchemy state tree exceeds ${maximumWorkerStateFiles} Worker state files`)
        }
      } else if (entry.isDirectory()) {
        const resolved = await Fs.realpath(candidate)
        if (!inside(root, resolved)) throw new TypeError(`Alchemy state directory escapes its root: ${candidate}`)
        directories.push(resolved)
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
 * used for other durable repository state. Credential-named entries in both
 * the environment and native binding representations are treated as secrets
 * regardless of their declared type, and an unreadable credential shape is
 * refused rather than reported clean.
 *
 * @category security
 * @since 0.1.0
 */
export const redactAlchemyState = async (options: RedactAlchemyStateOptions = {}): Promise<number> => {
  const { directory, permitted } = resolveRedactionOptions(options)
  const discovered = await discoverWorkerStates(directory)
  if (discovered === null) return 0
  let changed = 0
  for (const file of discovered.files) {
    if (await redactFile(discovered.root, file, permitted)) changed += 1
  }
  return changed
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    // The one optional argument is an absolute Alchemy state directory. The
    // deploy wrapper never passes it, since it calls `redactAlchemyState()`
    // in process, so the default stack directory stays the operator's path
    // and this argument exists so the CLI contract itself is executable.
    const count = await redactAlchemyState({ directory: process.argv[2] })
    process.stdout.write(`Redacted ${count} Alchemy Worker state file(s).\n`)
  } catch (error) {
    process.stderr.write(`Alchemy state redaction failed: ${failureMessage(error)}\n`)
    process.exitCode = 1
  }
}
