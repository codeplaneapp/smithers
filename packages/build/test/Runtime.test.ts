import { NodeServices } from "@effect/platform-node"
import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Runtime from "../src/Runtime.ts"

const platform = { os: "linux", arch: "x64", libc: null }

const withFixture = async <A>(use: (root: string) => Promise<A>): Promise<A> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-runtime-")))
  try {
    return await use(root)
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
}

const writeExecutable = async (path: string, body: string): Promise<void> => {
  await Fs.writeFile(path, `#!/usr/bin/env node\n${body}\n`, "utf8")
  await Fs.chmod(path, 0o755)
}

describe("Runtime.satisfies", () => {
  it("accepts an exact version and rejects any other", () => {
    expect(Runtime.satisfies("24.9.0", "24.9.0")).toBe(true)
    expect(Runtime.satisfies("=24.9.0", "24.9.0")).toBe(true)
    expect(Runtime.satisfies("24.9.0", "24.9.1")).toBe(false)
    expect(Runtime.satisfies("24.9.0", "24.10.0")).toBe(false)
  })

  it("compares each comparator form", () => {
    expect(Runtime.satisfies(">=22.19.0", "24.9.0")).toBe(true)
    expect(Runtime.satisfies(">=22.19.0", "22.19.0")).toBe(true)
    expect(Runtime.satisfies(">=22.19.0", "22.18.9")).toBe(false)
    expect(Runtime.satisfies(">22", "24.0.0")).toBe(true)
    expect(Runtime.satisfies(">22", "22.0.0")).toBe(false)
    expect(Runtime.satisfies("<=24", "24.0.0")).toBe(true)
    expect(Runtime.satisfies("<=24", "24.0.1")).toBe(false)
    expect(Runtime.satisfies("<25", "24.9.0")).toBe(true)
    expect(Runtime.satisfies("<25", "25.0.0")).toBe(false)
  })

  it("treats a shorter version as zero-padded", () => {
    expect(Runtime.satisfies(">=22", "22.0.0")).toBe(true)
    expect(Runtime.satisfies("22", "22.0.0")).toBe(true)
    expect(Runtime.satisfies("22.0", "22.0.0")).toBe(true)
  })

  it("drops a prerelease suffix rather than guessing its precedence", () => {
    expect(Runtime.satisfies("1.3.0", "1.3.0-canary.2")).toBe(true)
    expect(Runtime.satisfies(">=1.3.0", "1.3.0+build.7")).toBe(true)
  })

  it("accepts a leading v on either side", () => {
    expect(Runtime.satisfies("24.9.0", "v24.9.0")).toBe(true)
    expect(Runtime.satisfies("v24.9.0", "24.9.0")).toBe(true)
  })

  it("reports an unsupported requirement rather than passing it", () => {
    expect(Runtime.satisfies("^24.0.0", "24.9.0")).toBe("unsupported_requirement")
    expect(Runtime.satisfies("~24.9", "24.9.0")).toBe("unsupported_requirement")
    expect(Runtime.satisfies(">=22 <25", "24.9.0")).toBe("unsupported_requirement")
    expect(Runtime.satisfies("latest", "24.9.0")).toBe("unsupported_requirement")
    expect(Runtime.satisfies("", "24.9.0")).toBe("unsupported_requirement")
    expect(Runtime.satisfies("24.9.0", "not-a-version")).toBe("unsupported_requirement")
  })
})

describe("Runtime.makeNoop", () => {
  it("reports the declaration and the fixed version without spawning", async () => {
    const service = Runtime.makeNoop("node", { requirement: ">=22.19.0", version: "24.9.0", platform })
    expect(service.name).toBe("node")
    expect(service.executable).toBe("node")
    expect(service.requirement).toBe(">=22.19.0")
    expect(service.platform).toEqual(platform)
    expect(await Effect.runPromise(service.version)).toBe("24.9.0")
    expect(await Effect.runPromise(service.verify)).toBe("24.9.0")
  })

  it("honours an executable override", () => {
    const service = Runtime.makeNoop("bun", {
      requirement: "1.3.0",
      version: "1.3.0",
      platform,
      executable: "/opt/bun/bin/bun"
    })
    expect(service.executable).toBe("/opt/bun/bin/bun")
  })

  it("refuses a host that does not satisfy the declaration", async () => {
    const service = Runtime.makeNoop("node", { requirement: ">=24.0.0", version: "22.19.0", platform })
    await expect(Effect.runPromise(service.verify)).rejects.toThrow(
      /this host runs node 22\.19\.0, and the workspace declares >=24\.0\.0/
    )
  })

  it("provides itself as a layer", async () => {
    const layer = Runtime.layerNoop("bun", { requirement: "1.3.0", version: "1.3.0", platform })
    const name = await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* Runtime.Runtime
        return runtime.name
      }).pipe(Effect.provide(layer))
    )
    expect(name).toBe("bun")
  })
})

describe("Runtime measurement", () => {
  it("measures a version and holds the host to the declaration", async () => {
    await withFixture(async (root) => {
      const executable = NodePath.join(root, "fake-node.mjs")
      await writeExecutable(executable, "process.stdout.write(\"v24.9.0\\n\")")
      const service = await Effect.runPromise(
        Runtime.make("node", { requirement: ">=22.19.0", platform, executable }).pipe(
          Effect.provide(NodeServices.layer)
        )
      )
      expect(await Effect.runPromise(service.version)).toBe("24.9.0")
      expect(await Effect.runPromise(service.verify)).toBe("24.9.0")
    })
  })

  it("reads the first version-shaped token on the first line", async () => {
    await withFixture(async (root) => {
      const executable = NodePath.join(root, "chatty-bun.mjs")
      await writeExecutable(
        executable,
        "process.stdout.write(\"bun 1.3.0 (stable)\\nwebkit 1.2\\ntypescript 5.6\\n\")"
      )
      const service = await Effect.runPromise(
        Runtime.make("bun", { requirement: "1.3.0", platform, executable }).pipe(
          Effect.provide(NodeServices.layer)
        )
      )
      expect(await Effect.runPromise(service.version)).toBe("1.3.0")
    })
  })

  it("refuses a measured version the declaration excludes", async () => {
    await withFixture(async (root) => {
      const executable = NodePath.join(root, "old-node.mjs")
      await writeExecutable(executable, "process.stdout.write(\"v20.11.0\\n\")")
      const service = await Effect.runPromise(
        Runtime.make("node", { requirement: ">=22.19.0", platform, executable }).pipe(
          Effect.provide(NodeServices.layer)
        )
      )
      await expect(Effect.runPromise(service.verify)).rejects.toThrow(
        /this host runs node 20\.11\.0, and the workspace declares >=22\.19\.0/
      )
    })
  })

  it("reports an unsupported requirement against the measured version", async () => {
    await withFixture(async (root) => {
      const executable = NodePath.join(root, "fake-node.mjs")
      await writeExecutable(executable, "process.stdout.write(\"v24.9.0\\n\")")
      const service = await Effect.runPromise(
        Runtime.make("node", { requirement: "^24.0.0", platform, executable }).pipe(
          Effect.provide(NodeServices.layer)
        )
      )
      await expect(Effect.runPromise(service.verify)).rejects.toThrow(
        /is not an exact version or a single comparator/
      )
    })
  })

  it("fails when the probe prints no version", async () => {
    await withFixture(async (root) => {
      const executable = NodePath.join(root, "silent.mjs")
      await writeExecutable(executable, "process.stdout.write(\"no idea\\n\")")
      const service = await Effect.runPromise(
        Runtime.make("node", { requirement: "24.9.0", platform, executable }).pipe(
          Effect.provide(NodeServices.layer)
        )
      )
      await expect(Effect.runPromise(service.version)).rejects.toThrow(/printed no version/)
    })
  })

  it("fails when the probe exits non-zero", async () => {
    await withFixture(async (root) => {
      const executable = NodePath.join(root, "broken.mjs")
      await writeExecutable(executable, "process.exit(3)")
      const service = await Effect.runPromise(
        Runtime.make("node", { requirement: "24.9.0", platform, executable }).pipe(
          Effect.provide(NodeServices.layer)
        )
      )
      await expect(Effect.runPromise(service.version)).rejects.toThrow(/exited with status 3/)
    })
  })

  it("fails when the executable does not exist", async () => {
    await withFixture(async (root) => {
      const service = await Effect.runPromise(
        Runtime.make("node", {
          requirement: "24.9.0",
          platform,
          executable: NodePath.join(root, "absent")
        }).pipe(Effect.provide(NodeServices.layer))
      )
      await expect(Effect.runPromise(service.version)).rejects.toThrow(/failed/)
    })
  })

  it("builds each runtime layer", async () => {
    await withFixture(async (root) => {
      const executable = NodePath.join(root, "fake.mjs")
      await writeExecutable(executable, "process.stdout.write(\"1.3.0\\n\")")
      for (
        const [name, layer] of [
          ["node", Runtime.layerNode({ requirement: "1.3.0", platform, executable })],
          ["bun", Runtime.layerBun({ requirement: "1.3.0", platform, executable })]
        ] as const
      ) {
        const measured = await Effect.runPromise(
          Effect.gen(function*() {
            const runtime = yield* Runtime.Runtime
            expect(runtime.name).toBe(name)
            return yield* runtime.verify
          }).pipe(Effect.provide(layer), Effect.provide(NodeServices.layer))
        )
        expect(measured).toBe("1.3.0")
      }
    })
  })
})
