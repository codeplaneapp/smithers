/**
 * Permission-aware filesystem operations.
 *
 * There is no kernel `FileSystem` interface and no kernel `FileSystem` tag.
 * Effect owns both, and its tag fixes the error channel to `PlatformError`, so
 * this module is only the middleware: a `Layer` over Effect's own tag that
 * reads the raw service out of context and returns a guarded one in its place.
 * Permission failures are projected into `PlatformError` by
 * `Permission.toPlatformError`, which keeps the structured kernel failure on
 * the error's `cause`.
 *
 * Governing design:
 * `docs/specs/Concepts/Permission Kernel.md`,
 * `docs/specs/Concepts/Effect Taxonomy.md`, and
 * `docs/specs/Concepts/Host Adapters.md`.
 *
 * @since 1.0.0-rc.0
 */
import { make as makeCapability } from "@smthrs/capability/Capability"
import { permissionDenied, type PermissionError, toPlatformError } from "@smthrs/capability/Permission"
import {
  Effect,
  Encoding,
  FileSystem as EffectFileSystem,
  Layer,
  Option,
  Path as EffectPath,
  type PlatformError,
  Sink,
  Stream
} from "effect"
import { GrantStore } from "./GrantStore.ts"
import { Workspace } from "./Workspace.ts"

/**
 * Host-private extension used for race-free, descriptor-relative filesystem
 * operations. A plain path-based `FileSystem` cannot provide confinement: an
 * attacker can replace any checked component before the delegate resolves it.
 * Platform adapters opt in only when they can pin a root handle and reject
 * symlinks while traversing from it. Hosts without this extension fail closed.
 *
 * @since 1.0.0-rc.0
 * @category security
 * @slop
 */
export const AtomicFileSystemTypeId = Symbol.for("@smthrs/kernel/AtomicFileSystem")

/** A serializable operation executed relative to a pinned filesystem root.
 *
 * @since 1.0.0-rc.0
 * @category security
 * @slop
 */
export interface AtomicRequest {
  readonly operation: string
  readonly boundaryRoot?: string | undefined
  readonly logicalRoot?: string | undefined
  readonly path?: string | undefined
  readonly from?: string | undefined
  readonly to?: string | undefined
  readonly pattern?: string | undefined
  readonly root?: string | undefined
  readonly data?: string | undefined
  readonly encoding?: string | undefined
  readonly options?: object | undefined
}

/** Trusted host extension implementing atomic path resolution and operation.
 *
 * @since 1.0.0-rc.0
 * @category security
 * @slop
 */
export interface AtomicFileSystem {
  readonly execute: <A>(request: AtomicRequest) => Effect.Effect<A, PlatformError.PlatformError>
  /**
   * A filesystem already confined by an enforceable process/filesystem
   * boundary (for example an in-memory browser volume). Methods not expressible
   * as one descriptor-relative request may delegate only through this surface.
   */
  readonly isolated?: EffectFileSystem.FileSystem | undefined
}

/** An Effect filesystem carrying the atomic host extension.
 *
 * @since 1.0.0-rc.0
 * @category security
 * @slop
 */
export type AtomicHostFileSystem = EffectFileSystem.FileSystem & {
  readonly [AtomicFileSystemTypeId]: AtomicFileSystem
}

/** Attaches a trusted platform's descriptor-relative executor to its service.
 *
 * @since 1.0.0-rc.0
 * @category security
 * @slop
 */
export const withAtomicFileSystem = (
  fileSystem: EffectFileSystem.FileSystem,
  atomic: AtomicFileSystem
): AtomicHostFileSystem => Object.assign(fileSystem, { [AtomicFileSystemTypeId]: atomic })

/**
 * Attests that a host filesystem is already isolated as a whole. Intended for
 * browser/test volumes whose implementation cannot address the host
 * filesystem at all; native path-based adapters must not use this shortcut.
 *
 * @since 1.0.0-rc.0
 * @category security
 * @slop
 */
export const withIsolatedFileSystem = (
  fileSystem: EffectFileSystem.FileSystem
): AtomicHostFileSystem =>
  withAtomicFileSystem(fileSystem, {
    isolated: fileSystem,
    execute: (request) => {
      switch (request.operation) {
        case "glob":
          return fileSystem.glob(request.pattern!, {
            ...(request.options as { readonly exclude?: ReadonlyArray<string> | undefined } | undefined),
            root: request.root
          })
        case "exists":
          return fileSystem.exists(request.path!)
        case "makeDirectory":
          return fileSystem.makeDirectory(request.path!, request.options)
        case "readDirectory":
          return fileSystem.readDirectory(request.path!, request.options)
        case "readFile":
          return fileSystem.readFile(request.path!)
        case "readFileString":
          return fileSystem.readFileString(request.path!, request.encoding)
        case "readLink":
          return fileSystem.readLink(request.path!)
        case "realPath":
          return fileSystem.realPath(request.path!)
        case "remove":
          return fileSystem.remove(request.path!, request.options)
        case "rename":
          return fileSystem.rename(request.from!, request.to!)
        case "stat":
          return fileSystem.stat(request.path!)
        case "writeFile":
          return Encoding.decodeBase64(request.data!).pipe(
            Effect.fromResult,
            Effect.orDie,
            Effect.flatMap((data) => fileSystem.writeFile(request.path!, data, request.options))
          )
        case "writeFileString":
          return fileSystem.writeFileString(request.path!, request.data!, request.options)
        default:
          return Effect.die(`unsupported isolated filesystem operation: ${request.operation}`)
      }
    }
  } as AtomicFileSystem)

const readableOpenFlags: ReadonlySet<EffectFileSystem.OpenFlag> = new Set([
  "r",
  "r+",
  "w+",
  "wx+",
  "a+",
  "ax+"
])

const writableOpenFlags: ReadonlySet<EffectFileSystem.OpenFlag> = new Set([
  "r+",
  "w",
  "wx",
  "w+",
  "wx+",
  "a",
  "ax",
  "a+",
  "ax+"
])

const isInside = (path: EffectPath.Path, root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate)
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/**
 * The `device:inode` identity a descriptor-bound authorization pins, or
 * `Option.none` when the entry is not a regular file or the host reports no
 * inode identity. A host without inode identity is an isolated volume, and its
 * isolation attestation — not inode evidence — is the confinement boundary.
 */
const identityOf = (info: EffectFileSystem.File.Info): Option.Option<string> =>
  info.type === "File"
    ? Option.map(info.ino, (ino) => `${info.dev}:${ino}`)
    : Option.none()

/**
 * Resolves a path through every existing ancestor and maps paths inside the
 * canonical workspace back to the stable logical workspace root. Existing
 * symlinks therefore cannot turn an inside-workspace grant into outside
 * authority, while capability resources remain stable when the root itself is
 * a symlink.
 *
 * @category security
 * @since 1.0.0-rc.0
 * @slop
 */
export const canonicalResource = (
  fileSystem: EffectFileSystem.FileSystem,
  path: EffectPath.Path,
  workspaceRoot: string,
  value: string
): Effect.Effect<string, PlatformError.PlatformError> => {
  const normalizedRoot = path.normalize(workspaceRoot)
  const normalizedValue = path.normalize(
    path.isAbsolute(value) ? value : path.resolve(normalizedRoot, value)
  )
  const resolveExistingAncestor = (
    candidate: string,
    symlinkDepth = 0
  ): Effect.Effect<string, PlatformError.PlatformError> =>
    fileSystem.realPath(candidate).pipe(
      Effect.catch((error) => {
        const resolveParent = () => {
          const parent = path.dirname(candidate)
          if (parent === candidate) {
            return Effect.fail(error)
          }
          return resolveExistingAncestor(parent, symlinkDepth).pipe(
            Effect.map((resolvedParent) => path.join(resolvedParent, path.basename(candidate)))
          )
        }
        return fileSystem.readLink(candidate).pipe(
          Effect.matchEffect({
            onFailure: resolveParent,
            onSuccess: (target) =>
              symlinkDepth >= 40
                ? Effect.fail(error)
                : resolveExistingAncestor(
                  path.isAbsolute(target) ? target : path.resolve(path.dirname(candidate), target),
                  symlinkDepth + 1
                )
          })
        )
      })
    )

  return Effect.all([
    fileSystem.realPath(normalizedRoot),
    resolveExistingAncestor(normalizedValue)
  ]).pipe(
    Effect.map(([canonicalRoot, canonicalValue]) =>
      isInside(path, canonicalRoot, canonicalValue)
        ? path.normalize(path.join(normalizedRoot, path.relative(canonicalRoot, canonicalValue)))
        : path.normalize(canonicalValue)
    )
  )
}

/**
 * Decorates Effect's filesystem service in place with workspace-normalized
 * capability checks. Canonical-path and hard-link guards are always evaluated
 * before the capability check and delegate acquisition, and the canonical
 * resource is resolved again after every grant decision: a decision can
 * suspend (an attended request, a journal-backed store), and an operation
 * whose path no longer names the resource that was authorized is refused
 * rather than performed. Open file handles bind their authorization to the
 * `device:inode` identity fstat'd at open time and refuse any operation once
 * the authorized path names a different resource.
 *
 * The layer provides the tag it also requires: compose it over a host
 * filesystem layer with `Layer.provide` and every consumer of
 * `FileSystem.FileSystem` — including one that never heard of the kernel —
 * resolves the guarded implementation. A denied request surfaces as a
 * `PlatformError` whose reason is `PermissionDenied` and whose `cause` is the
 * kernel's own `PermissionRequired`, `PermissionDenied`, or `GrantStoreError`;
 * `Permission.fromPlatformError` reads it back.
 *
 * @category layers
 * @since 1.0.0-rc.0
 * @slop
 */
export const layer: Layer.Layer<
  EffectFileSystem.FileSystem,
  PlatformError.PlatformError,
  EffectFileSystem.FileSystem | EffectPath.Path | Workspace | GrantStore
> = Layer.effect(
  EffectFileSystem.FileSystem,
  Effect.gen(function*() {
    const fileSystem = yield* EffectFileSystem.FileSystem
    const path = yield* EffectPath.Path
    const workspace = yield* Workspace
    const grants = yield* GrantStore
    const atomic = (fileSystem as Partial<AtomicHostFileSystem>)[AtomicFileSystemTypeId]
    const normalizeFrom = (base: string, value: string): string =>
      path.normalize(path.isAbsolute(value) ? value : path.resolve(base, value))
    const normalize = (value: string): string => normalizeFrom(workspace.root, value)
    const logicalRoot = normalize(workspace.root)
    const boundaryRoot = yield* fileSystem.realPath(logicalRoot)
    const refuse = (method: string, resource: string) => (error: PermissionError): PlatformError.PlatformError =>
      toPlatformError({ module: "FileSystem", method, pathOrDescriptor: resource, error })
    /**
     * Resolves the canonical capability resource a path names right now and
     * applies the always-on hard-link refusal. `guard` runs it twice — once
     * before the grant decision and once after — so the resolution must be a
     * pure question about the current filesystem state.
     */
    const resolvedResource = (
      action: "fs:read" | "fs:write",
      method: string,
      value: string
    ): Effect.Effect<string, PlatformError.PlatformError> => {
      const normalized = normalize(value)
      return canonicalResource(fileSystem, path, workspace.root, normalized).pipe(
        Effect.flatMap((resource) =>
          fileSystem.stat(normalized).pipe(
            Effect.matchEffect({
              onFailure: () => Effect.succeed(resource),
              onSuccess: (info) => {
                const hardLinked = info.type === "File" && Option.isSome(info.nlink) && info.nlink.value > 1
                return hardLinked
                  ? Effect.fail(
                    refuse(method, resource)(
                      permissionDenied(
                        makeCapability(action, resource),
                        "hard-linked files cannot be confined to the workspace"
                      )
                    )
                  )
                  : Effect.succeed(resource)
              }
            })
          )
        )
      )
    }
    const guard = (
      action: "fs:read" | "fs:write",
      value: string
    ): Effect.Effect<void, PlatformError.PlatformError> => {
      const method = action === "fs:read" ? "read" : "write"
      return resolvedResource(action, method, value).pipe(
        Effect.flatMap((resource) =>
          grants.check(makeCapability(action, resource)).pipe(
            Effect.mapError(refuse(method, resource)),
            // The grant decision can suspend — an attended request waiting for
            // a human, a journal-backed store doing IO. What was authorized is
            // the resource the path named at check time, so the path must
            // still name it when the decision arrives: a symlink or rename
            // swapped in during the wait is refused, never followed.
            Effect.andThen(resolvedResource(action, method, value)),
            Effect.flatMap((settled) =>
              settled === resource
                ? Effect.void
                : Effect.fail(
                  refuse(method, resource)(
                    permissionDenied(
                      makeCapability(action, resource),
                      "path no longer names the resource that was authorized"
                    )
                  )
                )
            )
          )
        )
      )
    }
    const read = (value: string) => guard("fs:read", value)
    const write = (value: string) => guard("fs:write", value)
    const atomicUnavailable = (
      action: "fs:read" | "fs:write",
      value: string,
      method: string
    ): PlatformError.PlatformError => {
      const resource = normalize(value)
      return toPlatformError({
        module: "FileSystem",
        method,
        pathOrDescriptor: resource,
        error: permissionDenied(
          makeCapability(action, resource),
          "host does not provide descriptor-relative, no-follow filesystem isolation"
        )
      })
    }
    const atomicOne = <A>(
      action: "fs:read" | "fs:write",
      value: string,
      method: string,
      request: AtomicRequest
    ): Effect.Effect<A, PlatformError.PlatformError> =>
      atomic === undefined
        ? Effect.fail(atomicUnavailable(action, value, method))
        : guard(action, value).pipe(
          Effect.andThen(atomic.execute<A>({ ...request, boundaryRoot, logicalRoot }))
        )
    const atomicTwo = <A>(
      first: readonly ["fs:read" | "fs:write", string],
      second: readonly ["fs:read" | "fs:write", string],
      method: string,
      request: AtomicRequest
    ): Effect.Effect<A, PlatformError.PlatformError> =>
      atomic === undefined
        ? Effect.fail(atomicUnavailable(first[0], first[1], method))
        : guard(first[0], first[1]).pipe(
          Effect.andThen(guard(second[0], second[1])),
          Effect.andThen(atomic.execute<A>({ ...request, boundaryRoot, logicalRoot }))
        )
    const isolatedOne = <A>(
      action: "fs:read" | "fs:write",
      value: string,
      method: string,
      use: (isolated: EffectFileSystem.FileSystem) => Effect.Effect<A, PlatformError.PlatformError>
    ): Effect.Effect<A, PlatformError.PlatformError> =>
      atomic?.isolated === undefined
        ? Effect.fail(atomicUnavailable(action, value, method))
        : guard(action, value).pipe(Effect.andThen(use(atomic.isolated)))
    const isolatedTwo = <A>(
      first: readonly ["fs:read" | "fs:write", string],
      second: readonly ["fs:read" | "fs:write", string],
      method: string,
      use: (isolated: EffectFileSystem.FileSystem) => Effect.Effect<A, PlatformError.PlatformError>
    ): Effect.Effect<A, PlatformError.PlatformError> =>
      atomic?.isolated === undefined
        ? Effect.fail(atomicUnavailable(first[0], first[1], method))
        : guard(first[0], first[1]).pipe(
          Effect.andThen(guard(second[0], second[1])),
          Effect.andThen(use(atomic.isolated))
        )
    const temp = (directory: string | undefined) =>
      directory === undefined
        ? write(path.resolve(workspace.root, "..", "<system-temp>"))
        : write(directory)
    const snapshotOptions = <T>(value: T): T => {
      if (Array.isArray(value)) return Object.freeze(value.map(snapshotOptions)) as T
      if (typeof value !== "object" || value === null) return value
      const snapshot: Record<string, unknown> = {}
      for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (!descriptor.enumerable) continue
        if (!("value" in descriptor)) throw new TypeError("filesystem options must contain only data properties")
        snapshot[name] = snapshotOptions(descriptor.value)
      }
      return Object.freeze(snapshot) as T
    }
    const normalizeTempOptions = <T extends { readonly directory?: string | undefined }>(options: T | undefined) =>
      options?.directory === undefined ? options : { ...options, directory: normalize(options.directory) }
    const openChecks = (value: string, flag: EffectFileSystem.OpenFlag) => {
      const readable = readableOpenFlags.has(flag)
      const writable = writableOpenFlags.has(flag)
      return readable && writable ?
        read(value).pipe(Effect.andThen(write(value))) :
        writable ?
        write(value) :
        read(value)
    }
    const descriptorRefusal = (action: "fs:read" | "fs:write", value: string): PlatformError.PlatformError => {
      const resource = normalize(value)
      return refuse(action === "fs:read" ? "read" : "write", resource)(
        permissionDenied(
          makeCapability(action, resource),
          "descriptor no longer names the resource at its authorized path"
        )
      )
    }
    /**
     * Confirms an open descriptor still names the resource its authorization
     * bound: the `device:inode` identity fstat'd at open time must be what the
     * authorized path names right now. Rechecking the pathname alone would
     * re-authorize the CURRENT occupant of the path and then delegate to the
     * OLD descriptor — after a rename that descriptor can name an inode
     * outside the workspace even though the replacement path is still allowed.
     * A host that reports no inode identity is an isolated volume whose
     * attestation is the boundary; there is no descriptor evidence to verify.
     */
    const verifyDescriptor = (
      host: EffectFileSystem.FileSystem,
      action: "fs:read" | "fs:write",
      value: string,
      identity: Option.Option<string>
    ): Effect.Effect<void, PlatformError.PlatformError> =>
      Option.match(identity, {
        onNone: () => Effect.void,
        onSome: (bound) =>
          host.stat(normalize(value)).pipe(
            Effect.matchEffect({
              onFailure: () => Effect.fail(descriptorRefusal(action, value)),
              onSuccess: (info) =>
                Option.match(identityOf(info), {
                  onNone: () => Effect.fail(descriptorRefusal(action, value)),
                  onSome: (current) => current === bound ? Effect.void : Effect.fail(descriptorRefusal(action, value))
                })
            })
          )
      })
    const wrapFile = (
      host: EffectFileSystem.FileSystem,
      file: EffectFileSystem.File,
      value: string,
      identity: Option.Option<string>
    ): EffectFileSystem.File => {
      const readable = Effect.suspend(() =>
        read(value).pipe(Effect.andThen(verifyDescriptor(host, "fs:read", value, identity)))
      )
      const writable = Effect.suspend(() =>
        write(value).pipe(Effect.andThen(verifyDescriptor(host, "fs:write", value, identity)))
      )
      return {
        [EffectFileSystem.FileTypeId]: EffectFileSystem.FileTypeId,
        stat: Effect.fn("FileSystem.File.stat")(() => readable.pipe(Effect.andThen(file.stat)))(),
        seek: Effect.fn("FileSystem.File.seek")(file.seek),
        sync: Effect.fn("FileSystem.File.sync")(() => writable.pipe(Effect.andThen(file.sync)))(),
        read: Effect.fn("FileSystem.File.read")((buffer) => readable.pipe(Effect.andThen(file.read(buffer)))),
        readAlloc: Effect.fn("FileSystem.File.readAlloc")((size) =>
          readable.pipe(Effect.andThen(file.readAlloc(size)))
        ),
        truncate: Effect.fn("FileSystem.File.truncate")((length) =>
          writable.pipe(Effect.andThen(file.truncate(length)))
        ),
        write: Effect.fn("FileSystem.File.write")((buffer) => writable.pipe(Effect.andThen(file.write(buffer)))),
        writeAll: Effect.fn("FileSystem.File.writeAll")((buffer) =>
          writable.pipe(Effect.andThen(file.writeAll(buffer)))
        )
      }
    }
    // `EffectFileSystem.make` brands the implementation with Effect's own
    // (non-exported) type id. The five operations `make` would derive from
    // the primitives are overridden below with guarded delegates to the host
    // implementation, so delegation semantics do not change.
    const guarded: EffectFileSystem.FileSystem = {
      ...EffectFileSystem.make({
        access: Effect.fn("FileSystem.access")((value, options) => {
          const captured = snapshotOptions(options)
          return isolatedOne("fs:read", value, "access", (host) => host.access(normalize(value), captured))
        }),
        copy: Effect.fn("FileSystem.copy")((from, to, options) => {
          const captured = snapshotOptions(options)
          return (
          isolatedTwo(
            ["fs:read", from],
            ["fs:write", to],
            "copy",
            (host) => host.copy(normalize(from), normalize(to), captured)
          )
          )
        }),
        copyFile: Effect.fn("FileSystem.copyFile")((from, to) =>
          isolatedTwo(
            ["fs:read", from],
            ["fs:write", to],
            "copyFile",
            (host) => host.copyFile(normalize(from), normalize(to))
          )
        ),
        chmod: Effect.fn("FileSystem.chmod")((value, mode) =>
          isolatedOne("fs:write", value, "chmod", (host) => host.chmod(normalize(value), mode))
        ),
        chown: Effect.fn("FileSystem.chown")((value, uid, gid) =>
          isolatedOne("fs:write", value, "chown", (host) => host.chown(normalize(value), uid, gid))
        ),
        glob: Effect.fn("FileSystem.glob")((pattern, options) => {
          const captured = snapshotOptions(options)
          const root = captured?.root === undefined ? workspace.root : normalize(captured.root)
          const normalizedPattern = normalizeFrom(root, pattern)
          return atomicOne<Array<string>>("fs:read", normalizedPattern, "glob", {
            operation: "glob",
            pattern: normalizedPattern,
            root,
            options: captured === undefined ? undefined : { exclude: captured.exclude ?? [] }
          })
        }),
        link: Effect.fn("FileSystem.link")((from, to) =>
          isolatedTwo(["fs:read", from], ["fs:write", to], "link", (host) => host.link(normalize(from), normalize(to)))
        ),
        makeDirectory: Effect.fn("FileSystem.makeDirectory")((value, options) => {
          const captured = snapshotOptions(options)
          return atomicOne<void>("fs:write", value, "makeDirectory", {
            operation: "makeDirectory",
            path: normalize(value),
            options: captured
          })
        }),
        makeTempDirectory: Effect.fn("FileSystem.makeTempDirectory")((options) => {
          const captured = snapshotOptions(options)
          return (
          atomic?.isolated === undefined
            ? Effect.fail(atomicUnavailable("fs:write", captured?.directory ?? "../<system-temp>", "makeTempDirectory"))
            : temp(captured?.directory).pipe(
              Effect.andThen(atomic.isolated.makeTempDirectory(normalizeTempOptions(captured)))
            )
          )
        }),
        makeTempDirectoryScoped: Effect.fn("FileSystem.makeTempDirectoryScoped")((options) => {
          const captured = snapshotOptions(options)
          return (
          atomic?.isolated === undefined
            ? Effect.fail(
              atomicUnavailable("fs:write", captured?.directory ?? "../<system-temp>", "makeTempDirectoryScoped")
            )
            : temp(captured?.directory).pipe(
              Effect.andThen(atomic.isolated.makeTempDirectoryScoped(normalizeTempOptions(captured)))
            )
          )
        }),
        makeTempFile: Effect.fn("FileSystem.makeTempFile")((options) => {
          const captured = snapshotOptions(options)
          return (
          atomic?.isolated === undefined
            ? Effect.fail(atomicUnavailable("fs:write", captured?.directory ?? "../<system-temp>", "makeTempFile"))
            : temp(captured?.directory).pipe(
              Effect.andThen(atomic.isolated.makeTempFile(normalizeTempOptions(captured)))
            )
          )
        }),
        makeTempFileScoped: Effect.fn("FileSystem.makeTempFileScoped")((options) => {
          const captured = snapshotOptions(options)
          return (
          atomic?.isolated === undefined
            ? Effect.fail(atomicUnavailable("fs:write", captured?.directory ?? "../<system-temp>", "makeTempFileScoped"))
            : temp(captured?.directory).pipe(
              Effect.andThen(atomic.isolated.makeTempFileScoped(normalizeTempOptions(captured)))
            )
          )
        }),
        open: Effect.fn("FileSystem.open")((value, options) => {
          const captured = snapshotOptions(options)
          const flag = captured?.flag ?? "r"
          const isolated = atomic?.isolated
          return isolated === undefined
            ? Effect.fail(atomicUnavailable("fs:read", value, "open"))
            : openChecks(value, flag).pipe(
              Effect.andThen(isolated.open(normalize(value), captured)),
              // fstat the handle the moment it exists: the authorization the
              // open checks granted binds to THIS resource identity, and every
              // later handle operation verifies the authorized path still
              // names it before delegating to the descriptor.
              Effect.flatMap((file) =>
                file.stat.pipe(
                  Effect.map((info) => wrapFile(isolated, file, value, identityOf(info)))
                )
              )
            )
        }),
        readDirectory: Effect.fn("FileSystem.readDirectory")((value, options) => {
          const captured = snapshotOptions(options)
          return atomicOne<Array<string>>("fs:read", value, "readDirectory", {
            operation: "readDirectory",
            path: normalize(value),
            options: captured
          })
        }),
        readFile: Effect.fn("FileSystem.readFile")((value) =>
          atomicOne<Uint8Array>("fs:read", value, "readFile", {
            operation: "readFile",
            path: normalize(value)
          })
        ),
        readLink: Effect.fn("FileSystem.readLink")((value) =>
          atomicOne<string>("fs:read", value, "readLink", {
            operation: "readLink",
            path: normalize(value)
          })
        ),
        realPath: Effect.fn("FileSystem.realPath")((value) =>
          atomicOne<string>("fs:read", value, "realPath", {
            operation: "realPath",
            path: normalize(value)
          })
        ),
        remove: Effect.fn("FileSystem.remove")((value, options) => {
          const captured = snapshotOptions(options)
          return atomicOne<void>("fs:write", value, "remove", {
            operation: "remove",
            path: normalize(value),
            options: captured
          })
        }),
        rename: Effect.fn("FileSystem.rename")((from, to) =>
          atomicTwo<void>(["fs:write", from], ["fs:write", to], "rename", {
            operation: "rename",
            from: normalize(from),
            to: normalize(to)
          })
        ),
        stat: Effect.fn("FileSystem.stat")((value) =>
          atomicOne<EffectFileSystem.File.Info>("fs:read", value, "stat", {
            operation: "stat",
            path: normalize(value)
          })
        ),
        symlink: Effect.fn("FileSystem.symlink")((from, to) =>
          isolatedOne("fs:write", to, "symlink", (host) => host.symlink(from, normalize(to)))
        ),
        truncate: Effect.fn("FileSystem.truncate")((value, length) =>
          isolatedOne("fs:write", value, "truncate", (host) => host.truncate(normalize(value), length))
        ),
        utimes: Effect.fn("FileSystem.utimes")((value, atime, mtime) =>
          isolatedOne("fs:write", value, "utimes", (host) => host.utimes(normalize(value), atime, mtime))
        ),
        watch: (value) =>
          Stream.unwrap(
            Effect.fn("FileSystem.watch")(() =>
              Effect.suspend(() =>
                atomic?.isolated === undefined
                  ? Effect.fail(atomicUnavailable("fs:read", value, "watch"))
                  : read(value).pipe(Effect.map(() => atomic.isolated!.watch(normalize(value))))
              )
            )()
          ),
        writeFile: Effect.fn("FileSystem.writeFile")((value, data, options) => {
          const captured = snapshotOptions(options)
          const bytes = data.slice()
          return atomicOne<void>("fs:write", value, "writeFile", {
            operation: "writeFile",
            path: normalize(value),
            data: Encoding.encodeBase64(bytes),
            options: captured
          })
        })
      }),
      exists: Effect.fn("FileSystem.exists")((value) =>
        atomicOne<boolean>("fs:read", value, "exists", {
          operation: "exists",
          path: normalize(value)
        })
      ),
      readFileString: Effect.fn("FileSystem.readFileString")((value, encoding) =>
        atomicOne<string>("fs:read", value, "readFileString", {
          operation: "readFileString",
          path: normalize(value),
          encoding
        })
      ),
      sink: (value, options) => {
        const captured = snapshotOptions(options)
        return (
        Sink.unwrap(
          Effect.fn("FileSystem.sink")(
            () =>
              Effect.suspend(() =>
                atomic?.isolated === undefined
                  ? Effect.fail(atomicUnavailable("fs:write", value, "sink"))
                  : write(value).pipe(Effect.map(() => atomic.isolated!.sink(normalize(value), captured)))
              )
          )()
        )
        )
      },
      stream: (value, options) => {
        const captured = snapshotOptions(options)
        return (
        Stream.unwrap(
          Effect.fn("FileSystem.stream")(() =>
            Effect.suspend(() =>
              atomic?.isolated === undefined
                ? Effect.fail(atomicUnavailable("fs:read", value, "stream"))
                : read(value).pipe(Effect.map(() => atomic.isolated!.stream(normalize(value), captured)))
            )
          )()
        )
        )
      },
      writeFileString: Effect.fn("FileSystem.writeFileString")((value, data, options) => {
        const captured = snapshotOptions(options)
        return atomicOne<void>("fs:write", value, "writeFileString", {
          operation: "writeFileString",
          path: normalize(value),
          data,
          options: captured
        })
      })
    }
    return guarded
  })
)
