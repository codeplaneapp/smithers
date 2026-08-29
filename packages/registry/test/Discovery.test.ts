import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Effect, FileSystem, Layer, Option, Path, PlatformError } from "effect"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { type Source, SourceScan } from "../src/Descriptor.ts"
import * as Discovery from "../src/Discovery.ts"

const projectRoot = fileURLToPath(new URL("./fixtures/project/flows", import.meta.url))
const foreignRoot = fileURLToPath(new URL("./fixtures/foreign", import.meta.url))
const missingRoot = fileURLToPath(new URL("./fixtures/does-not-exist", import.meta.url))

const discoveryLayer = Discovery.layer.pipe(
  Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))
)

const scan = (source: Source) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const discovery = yield* Discovery.Discovery
      return yield* discovery.scan(source)
    }).pipe(Effect.provide(discoveryLayer))
  )

describe("Discovery", () => {
  it("discovers path-named markdown and module flows without loading their bodies", async () => {
    const result = await scan({
      source: "project",
      root: projectRoot,
      naming: "path"
    })

    expect(result.entries.map((entry) => entry.name)).toEqual([
      "changelog",
      "hidden",
      "review",
      "review/read-pr"
    ])
    expect(
      result.warnings.some((item) => item.code === "name_field_ignored" && item.path.endsWith("/review/flow.mdx"))
    ).toBe(true)
    expect(
      result.warnings.some((item) => item.code === "missing_description" && item.path.endsWith("/broken/flow.mdx"))
    ).toBe(true)
    expect(result.entries.some((entry) => entry.name === "broken")).toBe(false)

    const hidden = result.entries.find((entry) => entry.name === "hidden")
    expect(hidden?.modelInvocable).toBe(false)

    const moduleFlow = result.entries.find((entry) => entry.name === "review/read-pr")
    expect(moduleFlow?.body).toMatchObject({
      _tag: "Module",
      path: expect.stringMatching(/review\/read-pr\/flow\.ts$/)
    })
    expect(moduleFlow?.input).toMatchObject({
      _tag: "Module",
      path: expect.stringMatching(/review\/read-pr\/flow\.ts$/),
      field: "input"
    })
    expect(moduleFlow?.output).toMatchObject({
      _tag: "Module",
      path: expect.stringMatching(/review\/read-pr\/flow\.ts$/),
      field: "output"
    })
    expect(moduleFlow?.capabilities).toEqual(["fs:read:.", "net:get:api.github.com"])
    expect(moduleFlow?.effects.tier).toBe("irreversible")
    expect(Option.getOrUndefined(moduleFlow?.placement ?? Option.none())).toBe("local")
    expect(moduleFlow?.description).toBe("Reads a PR and summarizes it.")
  })

  it("discovers unmodified foreign skills using frontmatter names", async () => {
    const result = await scan({
      source: "foreign",
      root: foreignRoot,
      naming: "frontmatter"
    })

    expect(result.entries.map((entry) => entry.name)).toEqual(["pdf-processing", "review", "template-skill"])
    expect(result.entries.find((entry) => entry.name === "pdf-processing")?.flows).toEqual([
      "Read",
      "Write",
      "Bash(pdftotext:*)",
      "Bash(pdfinfo:*)",
      "Bash(qpdf:*)"
    ])
    expect(result.entries.find((entry) => entry.name === "pdf-processing")?.capabilities).toEqual(["*"])
    expect(result.entries.find((entry) => entry.name === "pdf-processing")?.effects.tier).toBe("irreversible")
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "unprojectable_authority",
      path: expect.stringMatching(/pdf\/SKILL\.md$/)
    }))
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "directory_name_mismatch",
      name: "pdf-processing"
    }))
  })

  it("fails a missing source root with the stable root_missing code", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function*() {
          const discovery = yield* Discovery.Discovery
          return yield* discovery.scan({
            source: "missing",
            root: missingRoot,
            naming: "path"
          })
        }).pipe(Effect.provide(discoveryLayer))
      )
    )

    expect(error.code).toBe("root_missing")
  })

  it("reads only metadata during discovery and never calls readFileString", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const discovery = Discovery.make(
          FileSystem.makeNoop({
            exists: fs.exists,
            stat: fs.stat,
            readDirectory: fs.readDirectory,
            stream: fs.stream,
            readFile: fs.readFile,
            readFileString: () => Effect.die("discovery must not load complete bodies")
          }),
          path
        )
        return yield* discovery.scan({
          source: "project",
          root: projectRoot,
          naming: "path"
        })
      }).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)))
    )

    expect(result.entries.map((entry) => entry.name)).toContain("review/read-pr")
  })

  it("preserves an underlying FileSystem cause on source access failure", async () => {
    const cause = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "access",
      pathOrDescriptor: projectRoot
    })
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const path = yield* Path.Path
        const discovery = Discovery.make(
          FileSystem.makeNoop({ exists: () => Effect.fail(cause) }),
          path
        )
        return yield* Effect.flip(discovery.scan({
          source: "project",
          root: projectRoot,
          naming: "path"
        }))
      }).pipe(Effect.provide(NodePath.layer))
    )

    expect(error).toMatchObject({ code: "read_failed", cause })
  })

  it("scans nothing from a stub and keeps overridden methods", async () => {
    const source: Source = { source: "stub", root: projectRoot, naming: "path" }
    const overridden = new SourceScan({ entries: [], warnings: [] })

    const result = await Effect.runPromise(
      Effect.all([
        Discovery.makeNoop().scan(source),
        Discovery.makeNoop({ scan: () => Effect.succeed(overridden) }).scan(source),
        Effect.gen(function*() {
          const discovery = yield* Discovery.Discovery
          return yield* discovery.scan(source)
        }).pipe(Effect.provide(Discovery.layerNoop())),
        Effect.gen(function*() {
          const discovery = yield* Discovery.Discovery
          return yield* discovery.scan(source)
        }).pipe(Effect.provide(Discovery.layerNoop({ scan: () => Effect.succeed(overridden) })))
      ])
    )

    expect(result).toEqual([
      new SourceScan({ entries: [], warnings: [] }),
      overridden,
      new SourceScan({ entries: [], warnings: [] }),
      overridden
    ])
  })

  it("returns deterministic scans", async () => {
    const source = {
      source: "project",
      root: projectRoot,
      naming: "path"
    } as const

    const first = await scan(source)
    const second = await scan(source)

    expect(second).toEqual(first)
  })
})
