/**
 * The adapter is exercised two ways.
 *
 * Error mapping runs against stub backends, because the point is which thrown
 * value produces which `PlatformError` tag — a real backend cannot be made to
 * throw `EACCES` on demand. The operations run against **`node:fs/promises` in a
 * temp directory**: it satisfies `ZenFsPromisesLike` structurally, which is the
 * whole reason the seam is a structural slice, so the contract is checked
 * against a real filesystem rather than against a second in-memory
 * implementation we would then have to keep honest.
 */
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Option, PlatformError, Stream } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import * as NodeFsPromises from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as BrowserFileSystem from "../src/BrowserFileSystem/index.ts"

const decoder = new TextDecoder()
const encoder = new TextEncoder()

/** A backend where every method rejects with the same value, to pin error mapping. */
const throwingFs = (cause: unknown): BrowserFileSystem.ZenFsPromisesLike => {
  const boom = async (): Promise<never> => {
    throw cause
  }
  return {
    open: boom,
    readFile: boom,
    writeFile: boom,
    mkdir: boom,
    readdir: boom,
    stat: boom,
    rm: boom
  }
}

const codeError = (code: string): Error => Object.assign(new Error(`${code}: boom`), { code })

describe("BrowserFileSystem error mapping", () => {
  /**
   * Every tag here is one `effect/PlatformError` already declares. Collapsing
   * them onto `Unknown` throws away the only thing a caller can branch on:
   * after `exists` stopped swallowing failures, "not there" and "could not
   * look" have to be distinguishable.
   */
  it.effect("normalizes each backend code onto the PlatformError tag that carries its meaning", () =>
    Effect.gen(function*() {
      const cases = [
        [codeError("ENOENT"), "NotFound"],
        [codeError("EEXIST"), "AlreadyExists"],
        [codeError("EACCES"), "PermissionDenied"],
        [codeError("EPERM"), "PermissionDenied"],
        [codeError("EISDIR"), "BadResource"],
        [codeError("ENOTDIR"), "BadResource"],
        [codeError("ELOOP"), "BadResource"],
        [codeError("EBUSY"), "Busy"],
        [codeError("EIO"), "Unknown"]
      ] as const

      for (const [cause, tag] of cases) {
        const fileSystem = BrowserFileSystem.make(throwingFs(cause))
        const error = yield* (Effect.flip(fileSystem.readFile("/denied")))

        expect(error.reason).toMatchObject({
          _tag: tag,
          method: "readFile",
          pathOrDescriptor: "/denied",
          description: `${(cause as Error & { code: string }).code}: boom`,
          cause
        })
      }
    }))

  it.effect("falls back to Unknown for a rejection carrying no usable code", () =>
    Effect.gen(function*() {
      const causes = [new Error("no code at all"), Object.assign(new Error("numeric code"), { code: 2 })]

      for (const cause of causes) {
        const fileSystem = BrowserFileSystem.make(throwingFs(cause))
        const error = yield* (Effect.flip(fileSystem.readFile("/p")))

        expect(error.reason._tag).toBe("Unknown")
      }
    }))

  it.effect("stringifies a non-Error rejection value into the description", () =>
    Effect.gen(function*() {
      const fileSystem = BrowserFileSystem.make(throwingFs("plain string failure"))

      const error = yield* (Effect.flip(fileSystem.stat("/x")))

      expect(error.reason._tag).toBe("Unknown")
      expect(error.reason.description).toBe("plain string failure")
    }))

  it.effect("names the failing method for every wired operation", () =>
    Effect.gen(function*() {
      const fileSystem = BrowserFileSystem.make(throwingFs(codeError("ENOENT")))
      const operations: ReadonlyArray<
        readonly [string, Effect.Effect<unknown, { readonly reason: { readonly method: string } }>]
      > = [
        ["readFile", fileSystem.readFile("/p")],
        ["writeFile", fileSystem.writeFile("/p", encoder.encode("x"))],
        ["makeDirectory", fileSystem.makeDirectory("/p")],
        ["readDirectory", fileSystem.readDirectory("/p")],
        ["stat", fileSystem.stat("/p")],
        ["realPath", fileSystem.realPath("/p")],
        ["remove", fileSystem.remove("/p")],
        ["access", fileSystem.access("/p")],
        ["stream", Stream.runCollect(fileSystem.stream("/p"))]
      ]

      for (const [method, effect] of operations) {
        const error = yield* (Effect.flip(effect))
        expect(error.reason.method).toBe(method)
      }
    }))

  it.effect("reports an undecodable encoding as a BadArgument rather than a system failure", () =>
    Effect.gen(function*() {
      const fileSystem = BrowserFileSystem.make({
        ...throwingFs(codeError("ENOENT")),
        readFile: async () => encoder.encode("alpha")
      })

      const error = yield* (
        Effect.flip(fileSystem.readFileString("/p", "not-a-real-encoding"))
      )

      expect(error.reason).toMatchObject({
        _tag: "BadArgument",
        method: "readFileString",
        description: "invalid encoding"
      })
    }))

  it.effect("reports an unencodable string as a BadArgument before touching the backend", () =>
    Effect.gen(function*() {
      const written: Array<unknown> = []
      const fileSystem = BrowserFileSystem.make({
        ...throwingFs(codeError("ENOENT")),
        writeFile: async (_path, data) => {
          written.push(data)
        }
      })
      /** `TextEncoder.encode` coerces its argument, so a throwing `toString` is the only way in. */
      const hostile = {
        toString: (): string => {
          throw new Error("not stringifiable")
        }
      } as unknown as string

      const error = yield* (Effect.flip(fileSystem.writeFileString("/p", hostile)))

      expect(error.reason).toMatchObject({
        _tag: "BadArgument",
        method: "writeFileString",
        description: "could not encode string"
      })
      expect(written).toEqual([])
    }))

  it.effect("reports `exists` as false for a path that is absent", () =>
    Effect.gen(function*() {
      const fileSystem = BrowserFileSystem.make(throwingFs(codeError("ENOENT")))

      expect(yield* (fileSystem.exists("/missing"))).toBe(false)
    }))

  /**
   * `false` means "this path is not there". A backend that refused to look
   * answered a different question, and effect's own derivation propagates it
   * rather than reporting absence.
   */
  it.effect("propagates a non-NotFound failure from `exists` instead of reporting absence", () =>
    Effect.gen(function*() {
      const fileSystem = BrowserFileSystem.make(throwingFs(codeError("EACCES")))

      const error = yield* (Effect.flip(fileSystem.exists("/denied")))

      expect(error.reason).toMatchObject({ _tag: "PermissionDenied", method: "exists", pathOrDescriptor: "/denied" })
    }))

  /**
   * A backend that reports more bytes than it was given a buffer for would
   * move the read position backwards and grow the remaining count, so the
   * unfold would loop without bound. It is refused instead.
   */
  it.effect("refuses a read length the backend cannot have produced", () =>
    Effect.gen(function*() {
      const fileSystem = BrowserFileSystem.make({
        ...throwingFs(codeError("ENOENT")),
        open: async () => ({
          read: async (buffer: Uint8Array) => ({ bytesRead: buffer.length + 1 }),
          close: async () => {}
        })
      })

      const error = yield* (Effect.flip(Stream.runCollect(fileSystem.stream("/p"))))

      expect(error.reason).toMatchObject({ _tag: "BadResource", method: "stream.read", pathOrDescriptor: "/p" })
    }))

  /**
   * A backend with `lstat` never descends into a symlinked directory, so a
   * cycle cannot form. One with only `stat` follows the link, which is why the
   * walk also refuses to visit a directory it has already canonicalized.
   */
  it.effect("terminates a recursive listing over a backend whose directories loop", () =>
    Effect.gen(function*() {
      const directory: BrowserFileSystem.ZenFsStatsLike = {
        size: 0,
        mode: 0o755,
        mtimeMs: 0,
        isFile: () => false,
        isDirectory: () => true,
        isSymbolicLink: () => false
      }
      const fileSystem = BrowserFileSystem.make({
        ...throwingFs(codeError("ENOENT")),
        readdir: async () => ["loop"],
        stat: async () => directory,
        realpath: async () => "/root"
      })

      expect(yield* (fileSystem.readDirectory("/root", { recursive: true }))).toEqual(["loop"])
    }))

  it.effect("dies rather than fails when closing a streamed handle throws", () =>
    Effect.gen(function*() {
      const backend: BrowserFileSystem.ZenFsPromisesLike = {
        ...throwingFs(codeError("ENOENT")),
        open: async () => ({
          read: async () => ({ bytesRead: 0 }),
          close: async () => {
            throw codeError("EIO")
          }
        })
      }
      const fileSystem = BrowserFileSystem.make(backend)

      const exit = yield* Effect.exit(Stream.runCollect(fileSystem.stream("/p")))

      expect(exit._tag).toBe("Failure")
      const defect = exit._tag === "Failure" ? Cause.findDefect(exit.cause) : undefined
      expect(defect).toMatchObject({
        _tag: "Success",
        success: { reason: { _tag: "Unknown", method: "stream.close" } }
      })
    }))

  it.effect("reports SymbolicLink and Unknown for stats that are neither file nor directory", () =>
    Effect.gen(function*() {
      const stats = (kind: "link" | "other"): BrowserFileSystem.ZenFsStatsLike => ({
        size: 0,
        mode: 0,
        mtimeMs: 0,
        isFile: () => false,
        isDirectory: () => false,
        isSymbolicLink: () => kind === "link"
      })
      const make = (kind: "link" | "other") =>
        BrowserFileSystem.make({ ...throwingFs(codeError("ENOENT")), stat: async () => stats(kind) })

      expect(yield* (make("link").stat("/l"))).toMatchObject({ type: "SymbolicLink" })
      expect(yield* (make("other").stat("/o"))).toMatchObject({ type: "Unknown" })
    }))

  // Effect's makeNoop defects on makeTemp*, so BrowserFileSystem wires those four explicitly to NotFound.
  it.effect("fails every deliberately unsupported operation with NotFound", () =>
    Effect.gen(function*() {
      const fileSystem = BrowserFileSystem.make(throwingFs(codeError("ENOENT")))
      const operations: ReadonlyArray<
        readonly [string, Effect.Effect<unknown, PlatformError.PlatformError>]
      > = [
        ["chmod", fileSystem.chmod("/p", 0o644)],
        ["chown", fileSystem.chown("/p", 1, 1)],
        ["copy", fileSystem.copy("/from", "/to")],
        ["copyFile", fileSystem.copyFile("/from", "/to")],
        ["glob", fileSystem.glob("**/*.txt")],
        ["link", fileSystem.link("/from", "/to")],
        ["symlink", fileSystem.symlink("/from", "/to")],
        ["readLink", fileSystem.readLink("/p")],
        ["open", Effect.scoped(fileSystem.open("/p"))],
        ["rename", fileSystem.rename("/from", "/to")],
        ["sink", Stream.run(Stream.make(encoder.encode("x")), fileSystem.sink("/p"))],
        ["truncate", fileSystem.truncate("/p", 0)],
        ["utimes", fileSystem.utimes("/p", 0, 0)],
        ["watch", Stream.runDrain(fileSystem.watch("/p"))],
        ["makeTempDirectory", fileSystem.makeTempDirectory()],
        ["makeTempDirectoryScoped", Effect.scoped(fileSystem.makeTempDirectoryScoped())],
        ["makeTempFile", fileSystem.makeTempFile()],
        ["makeTempFileScoped", Effect.scoped(fileSystem.makeTempFileScoped())]
      ]

      const observed = yield* Effect.forEach(operations, ([name, operation]) =>
        Effect.map(Effect.exit(operation), (exit) => {
          if (Exit.isSuccess(exit)) {
            return [name, "Success"] as const
          }
          const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
          return [name, failure?.reason._tag ?? "Defect"] as const
        }), { concurrency: "unbounded" })

      expect(observed).toEqual(operations.map(([name]) => [name, "NotFound"]))
    }))
})

describe("BrowserFileSystem operations over node:fs/promises", () => {
  let root: string

  /**
   * `node:fs/promises` is a structural `ZenFsPromisesLike`: the slice was drawn
   * so that it is. Nothing here is cast — if the shapes drift, this line stops
   * compiling, which is the point.
   */
  const backend: BrowserFileSystem.ZenFsPromisesLike = NodeFsPromises
  const fileSystem = BrowserFileSystem.make(backend)
  const path = (...segments: ReadonlyArray<string>): string => join(root, ...segments)

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "flows-platform-browser-fs-"))
    await NodeFsPromises.mkdir(join(root, "sub"), { recursive: true })
    await NodeFsPromises.writeFile(join(root, "a.txt"), encoder.encode("alpha"))
    await NodeFsPromises.writeFile(join(root, "sub", "b.txt"), encoder.encode("beta"))
    // A symlink, a read-only file, and a write-only file: the three shapes
    // `realPath` and `access` used to answer wrongly about.
    await NodeFsPromises.symlink(join(root, "a.txt"), join(root, "link.txt"))
    await NodeFsPromises.writeFile(join(root, "ro.txt"), encoder.encode("ro"))
    await NodeFsPromises.chmod(join(root, "ro.txt"), 0o444)
    await NodeFsPromises.writeFile(join(root, "wo.txt"), encoder.encode("wo"))
    await NodeFsPromises.chmod(join(root, "wo.txt"), 0o222)
    // A tree nothing else in this file mutates, for recursive listing.
    await NodeFsPromises.mkdir(join(root, "tree", "nested"), { recursive: true })
    await NodeFsPromises.writeFile(join(root, "tree", "top.txt"), encoder.encode("top"))
    await NodeFsPromises.writeFile(join(root, "tree", "nested", "deep.txt"), encoder.encode("deep"))
    await NodeFsPromises.symlink(join(root, "tree", "nested"), join(root, "tree", "loop"), "dir")
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it.effect("round-trips a written file and reports it as existing", () =>
    Effect.gen(function*() {
      const contents = yield* (
        Effect.gen(function*() {
          yield* fileSystem.writeFile(path("c.txt"), encoder.encode("gamma"))
          const bytes = yield* fileSystem.readFile(path("c.txt"))
          const exists = yield* fileSystem.exists(path("c.txt"))
          const missing = yield* fileSystem.exists(path("nope.txt"))
          return { text: decoder.decode(bytes), exists, missing }
        })
      )

      expect(contents).toEqual({ text: "gamma", exists: true, missing: false })
    }))

  /**
   * `makeNoop` hardcodes both string helpers to `NotFound` instead of deriving
   * them from `readFile`/`writeFile` the way `make` does, so these pin that the
   * adapter wires them up rather than inheriting the stub.
   */
  it.effect("round-trips a string through the derived string helpers", () =>
    Effect.gen(function*() {
      const text = yield* (
        Effect.gen(function*() {
          yield* fileSystem.writeFileString(path("s.txt"), "delta")
          return yield* fileSystem.readFileString(path("s.txt"))
        })
      )

      expect(text).toBe("delta")
    }))

  /**
   * Dropping `flag` would silently turn an append into a truncating write, so
   * it is forwarded to the backend rather than ignored.
   */
  it.effect("forwards `flag` so an append extends the file and `wx` refuses to clobber", () =>
    Effect.gen(function*() {
      const outcome = yield* (
        Effect.gen(function*() {
          yield* fileSystem.writeFileString(path("log.txt"), "one\n")
          yield* fileSystem.writeFileString(path("log.txt"), "two\n", { flag: "a" })
          yield* fileSystem.writeFile(path("log.txt"), encoder.encode("three\n"), { flag: "a", mode: 0o644 })
          const appended = yield* fileSystem.readFileString(path("log.txt"))
          const clobber = yield* Effect.flip(
            fileSystem.writeFile(path("log.txt"), encoder.encode("x"), { flag: "wx" })
          )
          return { appended, clobber }
        })
      )

      expect(outcome.appended).toBe("one\ntwo\nthree\n")
      expect(outcome.clobber.reason).toMatchObject({ _tag: "AlreadyExists", method: "writeFile" })
    }))

  it.effect("stats files and directories with the corresponding type, size, and mtime", () =>
    Effect.gen(function*() {
      const [file, directory] = yield* (
        Effect.all([fileSystem.stat(path("a.txt")), fileSystem.stat(path("sub"))])
      )

      expect(file.type).toBe("File")
      expect(Number(file.size)).toBe(5)
      expect(Option.getOrThrow(file.mtime)).toBeInstanceOf(Date)
      expect(directory.type).toBe("Directory")
    }))

  it.effect("creates directories recursively and lists their entries", () =>
    Effect.gen(function*() {
      const entries = yield* (
        Effect.gen(function*() {
          yield* fileSystem.makeDirectory(path("deep", "nested"), { recursive: true })
          yield* fileSystem.writeFile(path("deep", "nested", "z.txt"), encoder.encode("z"))
          return yield* fileSystem.readDirectory(path("deep", "nested"))
        })
      )

      expect(entries).toEqual(["z.txt"])
    }))

  it.effect("fails a non-recursive makeDirectory whose parent is missing", () =>
    Effect.gen(function*() {
      const error = yield* (
        Effect.flip(fileSystem.makeDirectory(path("absent", "child")))
      )

      expect(error.reason).toMatchObject({ _tag: "NotFound", method: "makeDirectory" })
    }))

  it.effect("resolves realPath and access only for paths that exist", () =>
    Effect.gen(function*() {
      const canonical = yield* Effect.promise(() => NodeFsPromises.realpath(path("a.txt")))

      expect(yield* (fileSystem.realPath(path("a.txt")))).toBe(canonical)
      expect(yield* (fileSystem.access(path("a.txt")))).toBeUndefined()
      expect(yield* (Effect.flip(fileSystem.realPath(path("gone"))))).toMatchObject({
        reason: { _tag: "NotFound", method: "realPath" }
      })
      expect(yield* (Effect.flip(fileSystem.access(path("gone"))))).toMatchObject({
        reason: { _tag: "NotFound", method: "access" }
      })
    }))

  /**
   * `@smthrs/kernel` resolves every guarded path through `realPath` before it
   * checks the grant, so that a symlink cannot name a resource outside the
   * workspace. Returning the input verbatim would make that defense a no-op.
   */
  it.effect("canonicalizes a symlink and a relative path rather than echoing the input", () =>
    Effect.gen(function*() {
      const canonical = yield* Effect.promise(() => NodeFsPromises.realpath(path("a.txt")))

      const observed = {
        link: yield* fileSystem.realPath(path("link.txt")),
        dotted: yield* fileSystem.realPath(`${root}/sub/./../a.txt`),
        // A tab has no working directory, so a relative path resolves against
        // the volume root rather than an ambient cwd that does not exist.
        relative: yield* fileSystem.realPath(".")
      }

      expect(observed).toEqual({ link: canonical, dotted: canonical, relative: "/" })
    }))

  /**
   * A volume with no `realpath` has no links to follow, so lexical
   * canonicalization is the whole answer; the path is still stat'ed so a
   * missing one fails the way Node's own `realpath` fails.
   */
  it.effect("normalizes lexically when the backend cannot follow links", () =>
    Effect.gen(function*() {
      const lexical = BrowserFileSystem.make({ ...NodeFsPromises, realpath: undefined })

      expect(yield* (lexical.realPath(`${root}/sub/./../a.txt`))).toBe(path("a.txt"))
      expect(yield* (lexical.realPath("."))).toBe("/")
      expect(yield* (Effect.flip(lexical.realPath("/nowhere/at/all")))).toMatchObject({
        reason: { _tag: "NotFound", method: "realPath" }
      })
    }))

  /**
   * Effect documents `recursive` as "recursively list the contents of nested
   * directories", and `NodeFileSystem` honours it, so a flow that lists a tree
   * must not quietly lose every nested entry under `BrowserHost`.
   */
  it.effect("lists nested entries for `recursive`, without descending into a symlinked directory", () =>
    Effect.gen(function*() {
      const flat = yield* fileSystem.readDirectory(path("tree"))
      const deep = yield* fileSystem.readDirectory(path("tree"), { recursive: true })

      expect([...flat].sort()).toEqual(["loop", "nested", "top.txt"])
      expect([...deep].sort()).toEqual(["loop", "nested", "nested/deep.txt", "top.txt"])
      // The canonicalization the walk needs must not rename the failure.
      expect(yield* (Effect.flip(fileSystem.readDirectory(path("gone"), { recursive: true })))).toMatchObject({
        reason: { _tag: "NotFound", method: "readDirectory" }
      })
    }))

  /**
   * A caller using `access` as a permission pre-check gets a false green when
   * the option is dropped: a read-only file answers "yes, writable".
   */
  it.effect("answers `readable` and `writable` from the mode rather than dropping them", () =>
    Effect.gen(function*() {
      const outcome = {
        existence: yield* Effect.exit(fileSystem.access(path("ro.txt"), { ok: true })),
        readableOnReadOnly: yield* Effect.exit(fileSystem.access(path("ro.txt"), { readable: true })),
        writableOnReadOnly: yield* Effect.exit(fileSystem.access(path("ro.txt"), { writable: true })),
        readableOnWriteOnly: yield* Effect.exit(fileSystem.access(path("wo.txt"), { readable: true })),
        writableOnWriteOnly: yield* Effect.exit(fileSystem.access(path("wo.txt"), { writable: true }))
      }

      expect(Exit.isSuccess(outcome.existence)).toBe(true)
      expect(Exit.isSuccess(outcome.readableOnReadOnly)).toBe(true)
      expect(Exit.isSuccess(outcome.writableOnWriteOnly)).toBe(true)
      expect(yield* (Effect.flip(fileSystem.access(path("ro.txt"), { writable: true })))).toMatchObject({
        reason: { _tag: "PermissionDenied", method: "access", pathOrDescriptor: path("ro.txt") }
      })
      expect(Exit.isFailure(outcome.writableOnReadOnly)).toBe(true)
      expect(Exit.isFailure(outcome.readableOnWriteOnly)).toBe(true)
    }))

  /**
   * `writeFile` forwards `mode`; creating a directory 0755 when the caller
   * asked for 0700 is the same silent permission widening.
   */
  it.effect("creates a directory with the requested mode", () =>
    Effect.gen(function*() {
      yield* fileSystem.makeDirectory(path("moded"), { mode: 0o700 })
      yield* fileSystem.makeDirectory(path("default"))
      const moded = yield* fileSystem.stat(path("moded"))
      const byDefault = yield* fileSystem.stat(path("default"))

      expect(moded.mode & 0o777).toBe(0o700)
      expect(byDefault.mode & 0o077).not.toBe(0)
    }))

  it.effect("round-trips text outside the basic plane and honours a byte-per-character encoding", () =>
    Effect.gen(function*() {
      const astral = "flag \u{1F1EF}\u{1F1F5} \u{1D11E} café"
      yield* fileSystem.writeFileString(path("unicode.txt"), astral)
      const roundTrip = yield* fileSystem.readFileString(path("unicode.txt"))
      const asLatin1 = yield* fileSystem.readFileString(path("unicode.txt"), "latin1")

      expect(roundTrip).toBe(astral)
      // The encoding argument is honoured: latin1 reads one character per
      // stored byte, so the multi-byte sequences stop collapsing.
      expect(asLatin1).toHaveLength(encoder.encode(astral).length)
      expect(asLatin1).not.toBe(astral)
    }))

  it.effect("removes recursively, tolerates a forced removal of a missing path, and fails otherwise", () =>
    Effect.gen(function*() {
      const outcome = yield* (
        Effect.gen(function*() {
          yield* fileSystem.remove(path("sub"), { recursive: true })
          yield* fileSystem.remove(path("never"), { force: true })
          const failure = yield* Effect.flip(fileSystem.remove(path("never")))
          const exists = yield* fileSystem.exists(path("sub"))
          return { failure, exists }
        })
      )

      expect(outcome.exists).toBe(false)
      expect(outcome.failure).toMatchObject({ reason: { _tag: "NotFound", method: "remove" } })
    }))

  it.effect("streams a whole file when no bounds are given", () =>
    Effect.gen(function*() {
      const chunks = yield* (Stream.runCollect(fileSystem.stream(path("a.txt"))))

      expect(Array.from(chunks).map((chunk) => decoder.decode(chunk)).join("")).toBe("alpha")
    }))

  it.effect("emits nothing when `bytesToRead` is zero and chunks the file at the requested size", () =>
    Effect.gen(function*() {
      const empty = yield* (
        Stream.runCollect(fileSystem.stream(path("a.txt"), { bytesToRead: 0 }))
      )
      const chunked = yield* (
        Stream.runCollect(fileSystem.stream(path("a.txt"), { offset: 0, chunkSize: 2 }))
      )

      expect(Array.from(empty)).toEqual([])
      expect(Array.from(chunked).map((chunk) => decoder.decode(chunk))).toEqual(["al", "ph", "a"])
    }))

  /**
   * Clamping a negative offset to the start, or turning a NaN chunk size into
   * an empty stream, answers a question the caller did not ask. Each of these
   * is refused before the file is opened.
   */
  it.effect.each<[string, Parameters<typeof fileSystem.stream>[1], string]>([
    ["a negative offset", { offset: -10 }, "offset must be"],
    ["a fractional offset", { offset: 1.5 }, "offset must be"],
    ["a negative bytesToRead", { bytesToRead: -1 }, "bytesToRead must be"],
    ["a NaN chunkSize", { chunkSize: Number.NaN }, "chunkSize must be"],
    ["a zero chunkSize", { chunkSize: 0 }, "chunkSize must be"],
    ["an unallocatable chunkSize", { chunkSize: 64 * 1024 * 1024 + 1 }, "chunkSize must be"]
  ])("refuses %s rather than answering with something else", ([_name, options, message]) =>
    Effect.gen(function*() {
      const error = yield* (Effect.flip(Stream.runCollect(fileSystem.stream(path("a.txt"), options))))

      expect(error.reason).toMatchObject({ _tag: "BadArgument", module: "FileSystem", method: "stream" })
      expect(error.message).toContain(message)
    }))

  it.effect("truncates the final chunk when fewer bytes remain than the chunk size", () =>
    Effect.gen(function*() {
      const chunks = yield* (
        Stream.runCollect(fileSystem.stream(path("a.txt"), { offset: 3, bytesToRead: 99, chunkSize: 4 }))
      )

      expect(Array.from(chunks).map((chunk) => chunk.length)).toEqual([2])
      expect(decoder.decode(Array.from(chunks)[0])).toBe("ha")
    }))
})
