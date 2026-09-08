import { describe, expect, it } from "@effect/vitest"
import { Jj } from "@smthrs/jj"
import type { SyncFsLike } from "@smthrs/jj/browser/WasiFs"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import { Effect, FileSystem, Path } from "effect"
import { HttpClient } from "effect/unstable/http/HttpClient"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { posix } from "node:path"
import { vi } from "vitest"
import * as BrowserHost from "../src/BrowserHost.ts"

describe("BrowserHost roots", () => {
  it.effect.each([undefined, "/", "/repo"])(
    "keeps the mount isolated at / with jj.root %s",
    (root) =>
      Effect.gen(function*() {
        const unexpected = vi.fn(async (): Promise<never> => {
          throw new Error("unexpected backend operation during layer construction")
        })
        const realpath = vi.fn(async (path: string) => posix.normalize(path))
        const fs = {
          open: unexpected,
          readFile: unexpected,
          writeFile: unexpected,
          mkdir: unexpected,
          readdir: unexpected,
          stat: unexpected,
          rm: unexpected,
          realpath
        }
        const services = yield* Effect.gen(function*() {
          return {
            fileSystem: yield* FileSystem.FileSystem,
            path: yield* Path.Path,
            spawner: yield* ChildProcessSpawner,
            jj: yield* Jj,
            http: yield* HttpClient
          }
        }).pipe(Effect.provide(BrowserHost.layer({
          bash: { exec: unexpected },
          fs,
          // BrowserJj loads wasm on its first operation, not while building the host.
          jj: { wasm: new Uint8Array(), fs: {} as SyncFsLike, ...(root === undefined ? {} : { root }) }
        })))

        expect(unexpected).not.toHaveBeenCalled()
        expect(realpath).not.toHaveBeenCalled()
        expect(typeof services.spawner.spawn).toBe("function")
        expect(typeof services.jj.status).toBe("function")
        expect(yield* services.jj.root!("/repo")).toBe(root ?? "/")
        expect(typeof services.http.execute).toBe("function")
        expect(services.path.normalize("/repo/..")).toBe("/")
        const attestation = (services.fileSystem as KernelFileSystem.AtomicHostFileSystem)[
          KernelFileSystem.AtomicFileSystemTypeId
        ]
        expect(attestation.isolated).toBe(services.fileSystem)
        expect(yield* services.fileSystem.realPath(".")).toBe("/")
        expect(realpath).toHaveBeenCalledExactlyOnceWith("/.")
      })
  )
})
