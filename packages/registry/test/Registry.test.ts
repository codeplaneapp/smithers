import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Effect, FileSystem, Layer, Option } from "effect"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  BodyRefMarkdown,
  FlowDescriptor,
  Provenance,
  SchemaRefMarkdownArgs,
  SchemaRefMarkdownOutput,
  type Source,
  SourceScan
} from "../src/Descriptor.ts"
import * as Discovery from "../src/Discovery.ts"
import * as Registry from "../src/Registry.ts"
import type { DiscoveryError, RegistryError } from "../src/RegistryError.ts"
import { discoveryError } from "../src/RegistryError.ts"

const fixtures = fileURLToPath(new URL("./fixtures", import.meta.url))
const projectRoot = `${fixtures}/project/flows`
const foreignRoot = `${fixtures}/foreign`

const project: Source = {
  source: "project",
  root: projectRoot,
  naming: "path"
}

const foreign: Source = {
  source: "foreign",
  root: foreignRoot,
  naming: "frontmatter"
}

const platformLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const provideRegistry = <A, E>(
  effect: Effect.Effect<A, E, Registry.Registry>,
  sources: ReadonlyArray<Source> = [project, foreign]
): Effect.Effect<A, E | DiscoveryError | RegistryError> =>
  effect.pipe(
    Effect.provide(Registry.layer({ sources })),
    Effect.provide(Discovery.layer),
    Effect.provide(platformLayer)
  )

const descriptor = (
  name: string,
  options: { readonly path?: string; readonly modelInvocable?: boolean } = {}
): FlowDescriptor => {
  const path = options.path ?? `${fixtures}/${name}.md`
  return new FlowDescriptor({
    name,
    description: `Flow ${name}.`,
    body: new BodyRefMarkdown({ path, baseDirectory: fixtures }),
    input: new SchemaRefMarkdownArgs({}),
    output: new SchemaRefMarkdownOutput({}),
    model: Option.none(),
    flows: [],
    capabilities: [],
    effects: {
      reads: [],
      writes: [],
      mode: "hermetic",
      onConflict: "serialize",
      tier: "sealed"
    },
    placement: Option.none(),
    modelInvocable: options.modelInvocable ?? true,
    path,
    frontmatter: {},
    provenance: new Provenance({ source: "test", root: fixtures })
  })
}

const fromDescriptors = (entries: ReadonlyArray<FlowDescriptor>) =>
  Registry.layerFromDescriptors(entries).pipe(Layer.provide(platformLayer))

describe("Registry", () => {
  it("merges sources in order, warns on duplicates, and keeps first provenance", async () => {
    const result = await Effect.runPromise(
      provideRegistry(
        Effect.gen(function*() {
          const registry = yield* Registry.Registry
          const entries = yield* registry.list()
          const warnings = yield* registry.warnings()
          return { entries, warnings }
        })
      )
    )

    const review = result.entries.find((entry) => entry.name === "review")
    expect(review?.provenance).toEqual(new Provenance({ source: "project", root: projectRoot }))
    expect(
      result.warnings.some((warning) => warning.code === "duplicate_name" && warning.name === "review")
    ).toBe(true)
  })

  it("loads an unmodified third-party skill through progressive disclosure", async () => {
    const result = await Effect.runPromise(
      provideRegistry(
        Effect.gen(function*() {
          const registry = yield* Registry.Registry
          const entries = yield* registry.list()
          const descriptor = yield* registry.get("pdf-processing")
          const body = yield* registry.loadBody("pdf-processing")
          const rendered = yield* registry.runPrompt("pdf-processing", { args: "Extract report.pdf" })
          return { entries, descriptor, body, rendered }
        })
      )
    )

    expect(result.entries.map((entry) => entry.name)).toContain("pdf-processing")
    expect(result.descriptor.name).toBe("pdf-processing")
    expect(result.descriptor.output._tag).toBe("MarkdownOutput")
    expect(result.body._tag).toBe("Prompt")
    expect(result.rendered).toContain("Do not overwrite the source document")
    expect(result.rendered).toContain(`- Base directory: ${foreignRoot}/pdf`)
    expect(result.rendered.endsWith("\n\nExtract report.pdf")).toBe(true)
    if (result.body._tag === "Prompt") {
      expect(result.body.text).toContain("# PDF Processing")
      expect(result.body.text).not.toContain("name: pdf-processing")
      expect(result.body.text.startsWith("---")).toBe(false)
      expect(result.body.baseDirectory).toBe(`${foreignRoot}/pdf`)
    }
  })

  it("keeps hidden entries lookup- and body-loadable while excluding them from visible", async () => {
    const result = await Effect.runPromise(
      provideRegistry(
        Effect.gen(function*() {
          const registry = yield* Registry.Registry
          const visible = yield* registry.visible()
          const hidden = yield* registry.get("hidden")
          const body = yield* registry.loadBody("hidden")
          return { visible, hidden, body }
        })
      )
    )

    expect(result.visible.map((entry) => entry.name)).not.toContain("hidden")
    expect(result.hidden.name).toBe("hidden")
    expect(result.body._tag).toBe("Prompt")
  })

  it("rejects module flows at the markdown prompt boundary", async () => {
    const error = await Effect.runPromise(
      provideRegistry(
        Effect.gen(function*() {
          const registry = yield* Registry.Registry
          return yield* Effect.flip(registry.runPrompt("review/read-pr", { args: "4821" }))
        })
      )
    )

    expect(error.code).toBe("not_prompt_flow")
  })

  it("fails unknown lookup with not_found", async () => {
    const error = await Effect.runPromise(
      provideRegistry(
        Effect.gen(function*() {
          const registry = yield* Registry.Registry
          return yield* Effect.flip(registry.get("does-not-exist"))
        })
      )
    )

    expect(error.code).toBe("not_found")
  })

  it("fails construction when either colliding source is system", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        return yield* registry.list()
      }).pipe(
        Effect.provide(Registry.layer({ sources: [{ ...project, system: true }, foreign] })),
        Effect.provide(Discovery.layer),
        Effect.provide(platformLayer),
        Effect.flip
      )
    )

    expect(error.code).toBe("system_collision")
  })

  it("defers body reads until loadBody and returns a typed read failure", async () => {
    const descriptor = new FlowDescriptor({
      name: "lazy",
      description: "Loads only when requested.",
      body: new BodyRefMarkdown({
        path: `${fixtures}/does-not-exist.md`,
        baseDirectory: fixtures
      }),
      input: new SchemaRefMarkdownArgs({}),
      output: new SchemaRefMarkdownOutput({}),
      model: Option.none(),
      flows: [],
      capabilities: [],
      effects: {
        reads: [],
        writes: [],
        mode: "hermetic",
        onConflict: "serialize",
        tier: "sealed"
      },
      placement: Option.none(),
      modelInvocable: true,
      path: `${fixtures}/does-not-exist.md`,
      frontmatter: {},
      provenance: new Provenance({ source: "test", root: fixtures })
    })
    const registryLayer = Registry.layerFromDescriptors([descriptor]).pipe(Layer.provide(platformLayer))

    const entries = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        return yield* registry.list()
      }).pipe(Effect.provide(registryLayer))
    )
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        return yield* Effect.flip(registry.loadBody("lazy"))
      }).pipe(Effect.provide(registryLayer))
    )

    expect(entries.map((entry) => entry.name)).toEqual(["lazy"])
    expect(error.code).toBe("body_unavailable")
    expect(error.cause).toMatchObject({ _tag: "PlatformError" })
  })

  it("refreshes all sources atomically for same-session rediscovery", async () => {
    const before = new FlowDescriptor({
      name: "before",
      description: "Present before refresh.",
      body: new BodyRefMarkdown({
        path: `${fixtures}/before.md`,
        baseDirectory: fixtures
      }),
      input: new SchemaRefMarkdownArgs({}),
      output: new SchemaRefMarkdownOutput({}),
      model: Option.none(),
      flows: [],
      capabilities: [],
      effects: {
        reads: [],
        writes: [],
        mode: "hermetic",
        onConflict: "serialize",
        tier: "sealed"
      },
      placement: Option.none(),
      modelInvocable: true,
      path: `${fixtures}/before.md`,
      frontmatter: {},
      provenance: new Provenance({ source: "test", root: fixtures })
    })
    const after = new FlowDescriptor({
      name: "after",
      description: "Present after refresh.",
      body: new BodyRefMarkdown({
        path: `${fixtures}/after.md`,
        baseDirectory: fixtures
      }),
      input: new SchemaRefMarkdownArgs({}),
      output: new SchemaRefMarkdownOutput({}),
      model: Option.none(),
      flows: [],
      capabilities: [],
      effects: {
        reads: [],
        writes: [],
        mode: "hermetic",
        onConflict: "serialize",
        tier: "sealed"
      },
      placement: Option.none(),
      modelInvocable: true,
      path: `${fixtures}/after.md`,
      frontmatter: {},
      provenance: new Provenance({ source: "test", root: fixtures })
    })
    let scans = 0
    const discovery = Discovery.makeNoop({
      scan: () => {
        scans++
        return scans <= 2
          ? Effect.succeed(new SourceScan({ entries: scans === 1 ? [before] : [after], warnings: [] }))
          : Effect.fail(discoveryError({ code: "read_failed", method: "scan" }))
      }
    })

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        const initial = yield* registry.list()
        yield* registry.refresh()
        const refreshed = yield* registry.list()
        const refreshError = yield* Effect.flip(registry.refresh())
        const preserved = yield* registry.list()
        return { initial, refreshed, refreshError, preserved }
      }).pipe(
        Effect.provide(Registry.layer({ sources: [{ source: "test", root: fixtures, naming: "path" }] })),
        Effect.provide(Layer.succeed(Discovery.Discovery)(discovery)),
        Effect.provide(platformLayer)
      )
    )

    expect(result.initial.map((entry) => entry.name)).toEqual(["before"])
    expect(result.refreshed.map((entry) => entry.name)).toEqual(["after"])
    expect(result.refreshError.code).toBe("read_failed")
    expect(result.preserved.map((entry) => entry.name)).toEqual(["after"])
  })

  it("returns an optional lookup for a known and an unknown name", async () => {
    const result = await Effect.runPromise(
      provideRegistry(
        Effect.gen(function*() {
          const registry = yield* Registry.Registry
          return {
            known: yield* registry.getOption("changelog"),
            unknown: yield* registry.getOption("does-not-exist"),
            empty: yield* registry.getOption("")
          }
        })
      )
    )

    expect(Option.getOrThrow(result.known).name).toBe("changelog")
    expect(result.unknown).toEqual(Option.none())
    expect(result.empty).toEqual(Option.none())
  })

  it("is empty in every projection when no descriptors are supplied", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        return {
          entries: yield* registry.list(),
          visible: yield* registry.visible(),
          warnings: yield* registry.warnings(),
          missing: yield* registry.getOption("anything")
        }
      }).pipe(Effect.provide(fromDescriptors([])))
    )

    expect(result.entries).toEqual([])
    expect(result.visible).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.missing).toEqual(Option.none())
  })

  it("keeps the first of two same-named descriptors and warns about the rest", async () => {
    const first = descriptor("review", { path: `${fixtures}/first-review.md` })
    const second = descriptor("review", { path: `${fixtures}/second-review.md` })
    const third = descriptor("review", { path: `${fixtures}/third-review.md` })
    const hidden = descriptor("hidden", { modelInvocable: false })

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        return {
          entries: yield* registry.list(),
          visible: yield* registry.visible(),
          found: yield* registry.get("review"),
          warnings: yield* registry.warnings()
        }
      }).pipe(Effect.provide(fromDescriptors([first, second, third, hidden])))
    )

    expect(result.entries.map((entry) => entry.path)).toEqual([first.path, hidden.path])
    expect(result.visible.map((entry) => entry.name)).toEqual(["review"])
    expect(result.found.path).toBe(first.path)
    expect(result.warnings.map((warning) => warning.path)).toEqual([second.path, third.path])
    expect(result.warnings[0]).toMatchObject({
      code: "duplicate_name",
      name: "review",
      message: `Duplicate flow name "review"; keeping first entry from "${first.path}"`
    })
  })

  it("reads one complete snapshot per operation while a refresh replaces it", async () => {
    const before = descriptor("before")
    const after = descriptor("after")
    let scans = 0
    const discovery = Discovery.makeNoop({
      scan: () =>
        Effect.sync(() => {
          scans++
          return new SourceScan({ entries: scans === 1 ? [before] : [after], warnings: [] })
        })
    })

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        const [names, refreshed] = yield* Effect.all(
          [
            Effect.all(
              Array.from({ length: 8 }, () => Effect.map(registry.list(), (entries) => entries.map((e) => e.name))),
              { concurrency: "unbounded" }
            ),
            registry.refresh()
          ],
          { concurrency: "unbounded" }
        )
        return { names, refreshed, final: yield* registry.list() }
      }).pipe(
        Effect.provide(Registry.layer({ sources: [{ source: "test", root: fixtures, naming: "path" }] })),
        Effect.provide(Layer.succeed(Discovery.Discovery)(discovery)),
        Effect.provide(platformLayer)
      )
    )

    expect(result.names.every((names) => names.length === 1)).toBe(true)
    expect(result.names.every((names) => names[0] === "before" || names[0] === "after")).toBe(true)
    expect(result.final.map((entry) => entry.name)).toEqual(["after"])
  })

  it("preserves lenient discovery warnings without logging or throwing", async () => {
    const warnings = await Effect.runPromise(
      provideRegistry(
        Effect.gen(function*() {
          const registry = yield* Registry.Registry
          return yield* registry.warnings()
        })
      )
    )

    expect(
      warnings.some(
        (warning) => warning.code === "missing_description" && warning.path.endsWith("/broken/flow.mdx")
      )
    ).toBe(true)
  })
})

describe("Registry stubs", () => {
  it("answers every method from an empty stub", async () => {
    const registry = Registry.makeNoop()

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        return {
          entries: yield* registry.list(),
          visible: yield* registry.visible(),
          warnings: yield* registry.warnings(),
          option: yield* registry.getOption("missing"),
          refreshed: yield* registry.refresh(),
          get: yield* Effect.flip(registry.get("missing")),
          body: yield* Effect.flip(registry.loadBody("missing")),
          prompt: yield* Effect.flip(registry.runPrompt("missing", { args: "" }))
        }
      })
    )

    expect(result.entries).toEqual([])
    expect(result.visible).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.option).toEqual(Option.none())
    expect(result.refreshed).toBeUndefined()
    expect(result.get).toMatchObject({
      code: "not_found",
      message: `not_found: Registry.get: flow "missing" was not found`
    })
    expect(result.body.code).toBe("not_found")
    expect(result.prompt.code).toBe("not_found")
  })

  it("keeps stub methods that are not overridden", async () => {
    const entry = descriptor("stubbed")
    const registry = Registry.makeNoop({
      list: () => Effect.succeed([entry]),
      get: () => Effect.succeed(entry)
    })

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        return {
          entries: yield* registry.list(),
          visible: yield* registry.visible(),
          found: yield* registry.get("stubbed"),
          option: yield* registry.getOption("stubbed")
        }
      })
    )

    expect(result.entries.map((item) => item.name)).toEqual(["stubbed"])
    expect(result.visible).toEqual([])
    expect(result.found.name).toBe("stubbed")
    expect(result.option).toEqual(Option.none())
  })

  it.each([
    ["without overrides", undefined, []],
    ["with overrides", [descriptor("stubbed")], ["stubbed"]]
  ])("provides a stub layer %s", async (_label, entries, names) => {
    const layer = entries === undefined
      ? Registry.layerNoop()
      : Registry.layerNoop({ list: () => Effect.succeed(entries) })

    const listed = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        return yield* registry.list()
      }).pipe(Effect.provide(layer))
    )

    expect(listed.map((entry) => entry.name)).toEqual(names)
  })
})
