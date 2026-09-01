/**
 * The barrel, and the one dependency this package must *not* have.
 *
 * Bun used to reach into `@smthrs/platform-browser` purely to borrow a
 * `fetch`-backed transport. Outgoing requests are now Effect's own
 * `HttpClient` — `@effect/platform-bun/BunHttpClient` — so the browser package
 * has no business in a Bun bundle, and the resolved module graph says so.
 */
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { build } from "esbuild"
import { describe, expect, it } from "vitest"
import * as BunFileSystem from "../src/BunFileSystem.ts"
import * as BunHost from "../src/BunHost.ts"
import * as Index from "../src/index.ts"

describe("@smthrs/platform-bun barrel", () => {
  it("re-exports every module as a namespace", () => {
    expect(Object.keys(Index).sort()).toEqual(["BunFileSystem", "BunHost"])
    expect(Index.BunFileSystem.layer).toBe(BunFileSystem.layer)
    expect(Index.BunHost.layer).toBe(BunHost.layer)
    expect(Index.BunHost.layerAt(process.cwd()).pipe).toBeTypeOf("function")
    expect(Index.BunHost.layerContained).toBe(BunHost.layerContained)
    expect(Index.BunHost.layerContained().pipe).toBeTypeOf("function")
    expect(Index.BunHost.layerContainedAt).toBe(BunHost.layerContainedAt)
  })

  it("contains the processes it spawns and reaps what a dead incarnation left", async () => {
    const ledger = await Effect.runPromise(
      ProcessLedger.makeMemory({ hostId: "bun-host", ownerPid: process.pid })
    )
    const host = BunHost.layerContainedAt(process.cwd(), { graceMs: 250 }).pipe(
      Layer.provide(Layer.succeed(ProcessLedger.ProcessLedger)(ledger))
    )

    const live = await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        yield* spawner.spawn(ChildProcess.make("sleep", ["30"]))
        return yield* ledger.live
      }).pipe(Effect.provide(host), Effect.scoped)
    )

    expect(live).toEqual([expect.objectContaining({ commandDigest: "sleep 30" })])
    // The scope closed, so the record is retired with the process.
    expect(await Effect.runPromise(ledger.live)).toEqual([])
  })

  it("names Effect's own Bun HttpClient as the network slot implementation", () => {
    expect(Object.values(BunHost.implementationIds)).toContain("@effect/platform-bun/BunHttpClient")
  })

  it("carries the kernel atomic filesystem extension", async () => {
    const fileSystem = await Effect.runPromise(
      Effect.provide(FileSystem.FileSystem, BunFileSystem.layer)
    )
    const atomic = (fileSystem as Partial<KernelFileSystem.AtomicHostFileSystem>)[
      KernelFileSystem.AtomicFileSystemTypeId
    ]
    expect(atomic).toBeDefined()
  })
})

describe("@smthrs/platform-bun module graph", () => {
  it("never resolves @smthrs/platform-browser", async () => {
    const result = await build({
      bundle: true,
      entryPoints: [new URL("../src/index.ts", import.meta.url).pathname],
      external: ["effect", "effect/*", "@effect/*", "node:*"],
      format: "esm",
      logLevel: "silent",
      metafile: true,
      platform: "node",
      write: false
    })
    const inputs = Object.keys(result.metafile.inputs)
    expect(inputs.some((input) => input.includes("platform-browser"))).toBe(false)
  })
})
