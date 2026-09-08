import { describe, expect, it } from "@effect/vitest"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import { Effect, FileSystem, Path } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { vi } from "vitest"
import * as BrowserServices from "../src/BrowserServices.ts"

const backend = () => {
  const unexpected = vi.fn(async (): Promise<never> => {
    throw new Error("unexpected backend operation during layer construction")
  })
  return {
    unexpected,
    bash: { exec: unexpected },
    fs: {
      open: unexpected,
      readFile: unexpected,
      writeFile: unexpected,
      mkdir: unexpected,
      readdir: unexpected,
      stat: unexpected,
      lstat: unexpected,
      realpath: unexpected,
      rm: unexpected
    }
  }
}

const services = Effect.gen(function*() {
  return {
    fileSystem: yield* FileSystem.FileSystem,
    path: yield* Path.Path,
    spawner: yield* ChildProcessSpawner
  }
})

describe("BrowserServices isolation root", () => {
  it.effect.each([undefined, "/"])("builds with workspaceRoot %s", (workspaceRoot) =>
    Effect.gen(function*() {
      const { unexpected, ...options } = backend()
      const built = yield* services.pipe(Effect.provide(BrowserServices.layer({
        ...options,
        ...(workspaceRoot === undefined ? {} : { workspaceRoot })
      })))
      expect(typeof built.spawner.spawn).toBe("function")
      expect(built.path.normalize("/repo/..")).toBe("/")
      expect(
        (built.fileSystem as KernelFileSystem.AtomicHostFileSystem)[KernelFileSystem.AtomicFileSystemTypeId].isolated
      )
        .toBe(built.fileSystem)
      expect(unexpected).not.toHaveBeenCalled()
    }))

  it.effect.each(["/repo", "repo", "/repo/", "/.", ""])(
    "refuses workspaceRoot %s before backend use",
    (workspaceRoot) =>
      Effect.gen(function*() {
        const { unexpected, ...options } = backend()
        const error = yield* Effect.flip(services.pipe(
          Effect.provide(BrowserServices.layer({ ...options, workspaceRoot }))
        ))
        expect(error._tag).toBe("PlatformError")
        expect(error.reason).toMatchObject({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "layer",
          pathOrDescriptor: workspaceRoot,
          description: "isolation requires the workspace root to equal the mount root /"
        })
        expect(unexpected).not.toHaveBeenCalled()
      })
  )
})
