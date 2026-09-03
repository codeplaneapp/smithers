import { describe, expect, it } from "@effect/vitest"
import type * as Capability from "@smthrs/capability/Capability"
import { permissionDenied } from "@smthrs/capability/Permission"
import { Effect, FileSystem as EffectFileSystem, Path as EffectPath, Sink, Stream } from "effect"
import * as FileSystem from "../src/FileSystem.ts"
import { GrantStore } from "../src/GrantStore.ts"
import * as Workspace from "../src/Workspace.ts"

/**
 * The permission decorator has to classify every filesystem operation, not
 * just the common ones: a single unguarded method is a hole in the kernel. Each
 * case below pins the exact capabilities one operation requests and proves that
 * a denial short-circuits before the host filesystem is ever touched.
 */

const scriptedStore = (
  allowed: (capability: Capability.Capability) => boolean,
  checks: Array<Capability.Capability>
) =>
  GrantStore.of({
    check: (capability) => {
      checks.push(capability)
      return allowed(capability)
        ? Effect.void
        : Effect.fail(permissionDenied(capability, "denied by test"))
    },
    reply: () => Effect.die("not used by filesystem decorator tests"),
    list: Effect.succeed([]),
    grantEnvelope: () => Effect.void
  })

const file = (calls: Array<string>): EffectFileSystem.File => ({
  [EffectFileSystem.FileTypeId]: EffectFileSystem.FileTypeId,
  stat: Effect.sync(() => {
    calls.push("file.stat")
    return {} as EffectFileSystem.File.Info
  }),
  seek: () =>
    Effect.sync(() => {
      calls.push("file.seek")
    }),
  sync: Effect.sync(() => {
    calls.push("file.sync")
  }),
  read: () =>
    Effect.sync(() => {
      calls.push("file.read")
      return EffectFileSystem.Size(BigInt(0))
    }),
  readAlloc: () =>
    Effect.sync(() => {
      calls.push("file.readAlloc")
      return new Uint8Array()
    }),
  truncate: () =>
    Effect.sync(() => {
      calls.push("file.truncate")
    }),
  write: () =>
    Effect.sync(() => {
      calls.push("file.write")
      return EffectFileSystem.Size(BigInt(0))
    }),
  writeAll: () =>
    Effect.sync(() => {
      calls.push("file.writeAll")
    })
} as unknown as EffectFileSystem.File)

const makeHostFileSystem = (calls: Array<string>): EffectFileSystem.FileSystem => {
  const record = <A>(name: string, value: A) =>
    Effect.sync(() => {
      calls.push(name)
      return value
    })
  return EffectFileSystem.makeNoop({
    realPath: (path) => Effect.succeed(path),
    access: () => record("access", undefined),
    copy: () => record("copy", undefined),
    copyFile: () => record("copyFile", undefined),
    chmod: () => record("chmod", undefined),
    chown: () => record("chown", undefined),
    glob: () => record("glob", [] as Array<string>),
    exists: () => record("exists", false),
    link: () => record("link", undefined),
    makeDirectory: () => record("makeDirectory", undefined),
    makeTempDirectory: () => record("makeTempDirectory", "/tmp/dir"),
    makeTempDirectoryScoped: () => record("makeTempDirectoryScoped", "/tmp/dir"),
    makeTempFile: () => record("makeTempFile", "/tmp/file"),
    makeTempFileScoped: () => record("makeTempFileScoped", "/tmp/file"),
    open: () => record("open", file(calls)),
    readDirectory: () => record("readDirectory", [] as Array<string>),
    readFile: () => record("readFile", new Uint8Array()),
    readFileString: () => record("readFileString", ""),
    readLink: () => record("readLink", "/workspace/target"),
    remove: () => record("remove", undefined),
    rename: () => record("rename", undefined),
    sink: () =>
      Sink.forEach(() =>
        Effect.sync(() => {
          calls.push("sink")
        })
      ),
    stat: () => record("stat", {} as EffectFileSystem.File.Info),
    stream: () => Stream.fromEffect(record("stream", new Uint8Array())),
    symlink: () => record("symlink", undefined),
    truncate: () => record("truncate", undefined),
    utimes: () => record("utimes", undefined),
    watch: () => Stream.fromEffect(record("watch", {} as EffectFileSystem.WatchEvent)),
    writeFile: () => record("writeFile", undefined),
    writeFileString: () => record("writeFileString", undefined)
  })
}

const hostFileSystem = (calls: Array<string>): EffectFileSystem.FileSystem =>
  FileSystem.withIsolatedFileSystem(makeHostFileSystem(calls))

interface Case {
  readonly name: string
  readonly capabilities: ReadonlyArray<Capability.Capability>
  /** Undefined when the guard itself uses this host method, making it unobservable. */
  readonly hostCall?: string | undefined
  readonly run: (fileSystem: EffectFileSystem.FileSystem) => Effect.Effect<unknown, unknown, never>
}

const read = (resource: string): Capability.Capability => ({ action: "fs:read", resource })
const write = (resource: string): Capability.Capability => ({ action: "fs:write", resource })

const cases: ReadonlyArray<Case> = [
  {
    name: "access",
    capabilities: [read("/workspace/a")],
    hostCall: "access",
    run: (fs) => fs.access("a")
  },
  {
    name: "copyFile",
    capabilities: [read("/workspace/a"), write("/workspace/b")],
    hostCall: "copyFile",
    run: (fs) => fs.copyFile("a", "b")
  },
  {
    name: "copy",
    capabilities: [read("/workspace/a"), write("/workspace/b")],
    hostCall: "copy",
    run: (fs) => fs.copy("a", "b")
  },
  {
    name: "chmod",
    capabilities: [write("/workspace/a")],
    hostCall: "chmod",
    run: (fs) => fs.chmod("a", 0o644)
  },
  {
    name: "chown",
    capabilities: [write("/workspace/a")],
    hostCall: "chown",
    run: (fs) => fs.chown("a", 1, 1)
  },
  {
    name: "glob",
    capabilities: [read("/workspace/**/*.ts")],
    hostCall: "glob",
    run: (fs) => fs.glob("**/*.ts")
  },
  {
    name: "exists",
    capabilities: [read("/workspace/a")],
    hostCall: "exists",
    run: (fs) => fs.exists("a")
  },
  {
    name: "link",
    capabilities: [read("/workspace/a"), write("/workspace/b")],
    hostCall: "link",
    run: (fs) => fs.link("a", "b")
  },
  {
    name: "makeDirectory",
    capabilities: [write("/workspace/a")],
    hostCall: "makeDirectory",
    run: (fs) => fs.makeDirectory("a")
  },
  {
    name: "makeTempDirectory in the system location",
    capabilities: [write("/<system-temp>")],
    hostCall: "makeTempDirectory",
    run: (fs) => fs.makeTempDirectory()
  },
  {
    name: "makeTempDirectory in an explicit directory",
    capabilities: [write("/workspace/scratch")],
    hostCall: "makeTempDirectory",
    run: (fs) => fs.makeTempDirectory({ directory: "scratch" })
  },
  {
    name: "makeTempDirectoryScoped in the system location",
    capabilities: [write("/<system-temp>")],
    hostCall: "makeTempDirectoryScoped",
    run: (fs) => Effect.scoped(fs.makeTempDirectoryScoped())
  },
  {
    name: "makeTempDirectoryScoped in an explicit directory",
    capabilities: [write("/workspace/scratch")],
    hostCall: "makeTempDirectoryScoped",
    run: (fs) => Effect.scoped(fs.makeTempDirectoryScoped({ directory: "scratch" }))
  },
  {
    name: "makeTempFile in the system location",
    capabilities: [write("/<system-temp>")],
    hostCall: "makeTempFile",
    run: (fs) => fs.makeTempFile()
  },
  {
    name: "makeTempFile in an explicit directory",
    capabilities: [write("/workspace/scratch")],
    hostCall: "makeTempFile",
    run: (fs) => fs.makeTempFile({ directory: "scratch" })
  },
  {
    name: "makeTempFileScoped in the system location",
    capabilities: [write("/<system-temp>")],
    hostCall: "makeTempFileScoped",
    run: (fs) => Effect.scoped(fs.makeTempFileScoped())
  },
  {
    name: "open for reading",
    capabilities: [read("/workspace/a")],
    hostCall: "open",
    run: (fs) => Effect.scoped(fs.open("a"))
  },
  {
    name: "open for writing",
    capabilities: [write("/workspace/a")],
    hostCall: "open",
    run: (fs) => Effect.scoped(fs.open("a", { flag: "w" }))
  },
  {
    name: "open for reading and writing",
    capabilities: [read("/workspace/a"), write("/workspace/a")],
    hostCall: "open",
    run: (fs) => Effect.scoped(fs.open("a", { flag: "w+" }))
  },
  {
    name: "open with r+",
    capabilities: [read("/workspace/a"), write("/workspace/a")],
    hostCall: "open",
    run: (fs) => Effect.scoped(fs.open("a", { flag: "r+" }))
  },
  {
    name: "open with wx",
    capabilities: [write("/workspace/a")],
    hostCall: "open",
    run: (fs) => Effect.scoped(fs.open("a", { flag: "wx" }))
  },
  {
    name: "open with wx+",
    capabilities: [read("/workspace/a"), write("/workspace/a")],
    hostCall: "open",
    run: (fs) => Effect.scoped(fs.open("a", { flag: "wx+" }))
  },
  {
    name: "open with a",
    capabilities: [write("/workspace/a")],
    hostCall: "open",
    run: (fs) => Effect.scoped(fs.open("a", { flag: "a" }))
  },
  {
    name: "open with a+",
    capabilities: [read("/workspace/a"), write("/workspace/a")],
    hostCall: "open",
    run: (fs) => Effect.scoped(fs.open("a", { flag: "a+" }))
  },
  {
    name: "open with ax",
    capabilities: [write("/workspace/a")],
    hostCall: "open",
    run: (fs) => Effect.scoped(fs.open("a", { flag: "ax" }))
  },
  {
    name: "open with ax+",
    capabilities: [read("/workspace/a"), write("/workspace/a")],
    hostCall: "open",
    run: (fs) => Effect.scoped(fs.open("a", { flag: "ax+" }))
  },
  {
    name: "readDirectory",
    capabilities: [read("/workspace/a")],
    hostCall: "readDirectory",
    run: (fs) => fs.readDirectory("a")
  },
  {
    name: "readFile",
    capabilities: [read("/workspace/a")],
    hostCall: "readFile",
    run: (fs) => fs.readFile("a")
  },
  {
    name: "readFileString",
    capabilities: [read("/workspace/a")],
    hostCall: "readFileString",
    run: (fs) => fs.readFileString("a")
  },
  {
    name: "readLink",
    capabilities: [read("/workspace/a")],
    hostCall: "readLink",
    run: (fs) => fs.readLink("a")
  },
  {
    name: "realPath",
    capabilities: [read("/workspace/a")],
    run: (fs) => fs.realPath("a")
  },
  {
    name: "remove",
    capabilities: [write("/workspace/a")],
    hostCall: "remove",
    run: (fs) => fs.remove("a")
  },
  {
    name: "rename",
    capabilities: [write("/workspace/a"), write("/workspace/b")],
    hostCall: "rename",
    run: (fs) => fs.rename("a", "b")
  },
  {
    name: "sink",
    capabilities: [write("/workspace/a")],
    hostCall: "sink",
    run: (fs) => Stream.make(new Uint8Array()).pipe(Stream.run(fs.sink("a")))
  },
  {
    name: "stat",
    capabilities: [read("/workspace/a")],
    run: (fs) => fs.stat("a")
  },
  {
    name: "stream",
    capabilities: [read("/workspace/a")],
    hostCall: "stream",
    run: (fs) => Stream.runDrain(fs.stream("a"))
  },
  {
    name: "symlink",
    capabilities: [write("/workspace/b")],
    hostCall: "symlink",
    run: (fs) => fs.symlink("a", "b")
  },
  {
    name: "truncate",
    capabilities: [write("/workspace/a")],
    hostCall: "truncate",
    run: (fs) => fs.truncate("a")
  },
  {
    name: "utimes",
    capabilities: [write("/workspace/a")],
    hostCall: "utimes",
    run: (fs) => fs.utimes("a", new Date(0), new Date(0))
  },
  {
    name: "watch",
    capabilities: [read("/workspace/a")],
    hostCall: "watch",
    run: (fs) => Stream.runDrain(fs.watch("a"))
  },
  {
    name: "writeFile",
    capabilities: [write("/workspace/a")],
    hostCall: "writeFile",
    run: (fs) => fs.writeFile("a", new Uint8Array())
  },
  {
    name: "writeFileString",
    capabilities: [write("/workspace/a")],
    hostCall: "writeFileString",
    run: (fs) => fs.writeFileString("a", "contents")
  }
]

const provide = <A, E>(
  program: (fileSystem: EffectFileSystem.FileSystem) => Effect.Effect<A, E, never>,
  host: EffectFileSystem.FileSystem,
  grants: ReturnType<typeof scriptedStore>
) =>
  Effect.gen(function*() {
    const fileSystem = yield* EffectFileSystem.FileSystem
    return yield* Effect.exit(program(fileSystem))
  }).pipe(
    Effect.provide(FileSystem.layer),
    Effect.provideService(EffectFileSystem.FileSystem, host),
    Effect.provide(EffectPath.layer),
    Effect.provide(Workspace.layer("/workspace")),
    Effect.provideService(GrantStore, grants)
  )

describe("FileSystem operation guards", () => {
  for (const testCase of cases) {
    it.effect(`requests ${testCase.capabilities.length} capability check(s) for ${testCase.name}`, () =>
      Effect.gen(function*() {
        const checks: Array<Capability.Capability> = []
        const calls: Array<string> = []
        const exit = yield* (
          provide(testCase.run, hostFileSystem(calls), scriptedStore(() => true, checks))
        )

        expect(exit._tag).toBe("Success")
        // The `<system-temp>` resource is resolved outside the workspace root.
        expect(checks.map((check) => ({ ...check, resource: check.resource.replace("/workspace/..", "") })))
          .toEqual(testCase.capabilities)
        if (testCase.hostCall !== undefined) expect(calls).toContain(testCase.hostCall)
      }))

    it.effect(`denies ${testCase.name} before the host filesystem runs`, () =>
      Effect.gen(function*() {
        const checks: Array<Capability.Capability> = []
        const calls: Array<string> = []
        const exit = yield* (
          provide(testCase.run, hostFileSystem(calls), scriptedStore(() => false, checks))
        )

        expect(exit._tag).toBe("Failure")
        expect(checks).toHaveLength(1)
        if (testCase.hostCall !== undefined) expect(calls).not.toContain(testCase.hostCall)
      }))
  }

  it.effect("uses the resolved outside-workspace sentinel for every implicit system-temp operation", () =>
    Effect.gen(function*() {
      const checks: Array<Capability.Capability> = []
      const calls: Array<string> = []
      const exit = yield* (
        provide(
          (fileSystem) =>
            Effect.gen(function*() {
              yield* fileSystem.makeTempDirectory()
              yield* Effect.scoped(fileSystem.makeTempDirectoryScoped())
              yield* fileSystem.makeTempFile()
              yield* Effect.scoped(fileSystem.makeTempFileScoped())
            }),
          hostFileSystem(calls),
          scriptedStore(() => true, checks)
        )
      )

      expect(exit._tag).toBe("Success")
      expect(checks).toEqual([
        write("/<system-temp>"),
        write("/<system-temp>"),
        write("/<system-temp>"),
        write("/<system-temp>")
      ])
      expect(checks.every((check) => !check.resource.startsWith("/workspace"))).toBe(true)
      expect(calls.filter((call) => call !== "stat")).toEqual([
        "makeTempDirectory",
        "makeTempDirectoryScoped",
        "makeTempFile",
        "makeTempFileScoped"
      ])
    }))

  it.effect("guards each operation on an open file handle", () =>
    Effect.gen(function*() {
      const checks: Array<Capability.Capability> = []
      const calls: Array<string> = []
      const exit = yield* (
        provide(
          (fileSystem) =>
            Effect.scoped(
              Effect.gen(function*() {
                const handle = yield* fileSystem.open("a", { flag: "w+" })
                yield* handle.stat
                yield* handle.sync
                yield* handle.read(new Uint8Array(1))
                yield* handle.readAlloc(1)
                yield* handle.truncate(0)
                yield* handle.write(new Uint8Array(1))
                yield* handle.writeAll(new Uint8Array(1))
                yield* handle.seek(0, "current")
              })
            ),
          hostFileSystem(calls),
          scriptedStore(() => true, checks)
        )
      )

      expect(exit._tag).toBe("Success")
      // The first `file.stat` is the open-time fstat that binds the handle's
      // authorization to a resource identity; the second is the guarded
      // `handle.stat` operation itself.
      expect(calls.filter((call) => call !== "stat")).toEqual([
        "open",
        "file.stat",
        "file.stat",
        "file.sync",
        "file.read",
        "file.readAlloc",
        "file.truncate",
        "file.write",
        "file.writeAll",
        "file.seek"
      ])
      // open (read+write) then one check per guarded handle operation; `seek`
      // moves no bytes and needs none.
      expect(checks.map((check) => check.action)).toEqual([
        "fs:read",
        "fs:write",
        "fs:read",
        "fs:write",
        "fs:read",
        "fs:read",
        "fs:write",
        "fs:write",
        "fs:write"
      ])
    }))

  it.effect("fails closed when a host has no isolated filesystem attestation", () =>
    Effect.gen(function*() {
      const checks: Array<Capability.Capability> = []
      const calls: Array<string> = []
      const host = makeHostFileSystem(calls)
      const grants = scriptedStore(() => true, checks)
      const operations: ReadonlyArray<Case["run"]> = [
        (fs) => fs.access("a"),
        (fs) => fs.copy("a", "b"),
        (fs) => fs.rename("a", "b"),
        (fs) => fs.stat("a"),
        (fs) => Effect.scoped(fs.open("a")),
        (fs) => fs.makeTempDirectory(),
        (fs) => fs.makeTempDirectory({ directory: "scratch" }),
        (fs) => Effect.scoped(fs.makeTempDirectoryScoped()),
        (fs) => Effect.scoped(fs.makeTempDirectoryScoped({ directory: "scratch" })),
        (fs) => fs.makeTempFile(),
        (fs) => fs.makeTempFile({ directory: "scratch" }),
        (fs) => Effect.scoped(fs.makeTempFileScoped()),
        (fs) => Effect.scoped(fs.makeTempFileScoped({ directory: "scratch" })),
        (fs) => Stream.make(new Uint8Array()).pipe(Stream.run(fs.sink("a"))),
        (fs) => Stream.runDrain(fs.stream("a")),
        (fs) => Stream.runDrain(fs.watch("a"))
      ]

      const exits = yield* Effect.forEach(operations, (operation) => provide(operation, host, grants))

      expect(exits.every((exit) => exit._tag === "Failure")).toBe(true)
      expect(checks).toEqual([])
      expect(calls).toEqual([])

      const isolated = FileSystem.withIsolatedFileSystem(host)
      const unsupported = yield* Effect.exit(
        isolated[FileSystem.AtomicFileSystemTypeId].execute({ operation: "unsupported" })
      )
      expect(unsupported._tag).toBe("Failure")
    }))
})
