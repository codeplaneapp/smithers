/**
 * A pack is a directory that ships flows, and the registry has to be able to
 * take two of them at once.
 *
 * Everything under the manifest is the real discovery pipeline: the same
 * `Discovery.scan`, the same `FlowDescriptor`, the same first-found merge the
 * single-source registry already performs. What is new is that a descriptor
 * now says which pack it came from, that a local pack shadows an installed one
 * by name rather than by scan order, and that a pack has a content address a
 * lock file can pin.
 */
import * as NodePath from "@effect/platform-node/NodePath"
import { Effect, FileSystem, Layer, Option, Path, PlatformError } from "effect"
import { describe, expect, it } from "vitest"
import * as Discovery from "../src/Discovery.ts"
import * as Pack from "../src/Pack.ts"
import * as Registry from "../src/Registry.ts"

type Node =
  | { readonly kind: "file"; readonly contents: string }
  | { readonly kind: "directory"; readonly entries: ReadonlyArray<string> }

const denied = (method: string, path: string) =>
  PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method,
    pathOrDescriptor: path
  })

const info = (type: FileSystem.File.Type, size: number): FileSystem.File.Info => ({
  type,
  mtime: Option.none(),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 0,
  ino: Option.none(),
  mode: 0o644,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: FileSystem.Size(size),
  blksize: Option.none(),
  blocks: Option.none()
})

const virtualFileSystem = (nodes: Map<string, Node>): FileSystem.FileSystem =>
  FileSystem.makeNoop({
    exists: (path) => Effect.succeed(nodes.has(path)),
    stat: (path) => {
      const node = nodes.get(path)
      if (node?.kind === "file") return Effect.succeed(info("File", node.contents.length))
      if (node?.kind === "directory") return Effect.succeed(info("Directory", 0))
      return Effect.fail(denied("stat", path))
    },
    readDirectory: (path) => {
      const node = nodes.get(path)
      return node?.kind === "directory" ? Effect.succeed([...node.entries]) : Effect.fail(denied("readDirectory", path))
    },
    readFile: (path) => {
      const node = nodes.get(path)
      return node?.kind === "file"
        ? Effect.succeed(new TextEncoder().encode(node.contents))
        : Effect.fail(denied("readFile", path))
    },
    readFileString: (path) => {
      const node = nodes.get(path)
      return node?.kind === "file" ? Effect.succeed(node.contents) : Effect.fail(denied("readFileString", path))
    }
  })

const flowFile = (description: string, body: string): Node => ({
  kind: "file",
  contents: `---\ndescription: ${description}\n---\n\n${body}\n`
})

const manifestFile = (value: unknown): Node => ({ kind: "file", contents: JSON.stringify(value, null, 2) })

/**
 * One pack on disk: a manifest at the root and a `flows` directory holding one
 * entry directory per flow.
 */
const packTree = (options: {
  readonly dir: string
  readonly manifest: unknown
  readonly flows: Readonly<Record<string, string>>
}): Array<readonly [string, Node]> => {
  const names = Object.keys(options.flows)
  return [
    [options.dir, { kind: "directory", entries: ["pack.json", "flows"] }] as const,
    [`${options.dir}/pack.json`, manifestFile(options.manifest)] as const,
    [`${options.dir}/flows`, { kind: "directory", entries: names }] as const,
    ...names.flatMap((name) => [
      [`${options.dir}/flows/${name}`, { kind: "directory", entries: ["flow.mdx"] }] as const,
      [
        `${options.dir}/flows/${name}/flow.mdx`,
        flowFile(`Flow ${name} from ${options.dir}.`, options.flows[name]!)
      ] as const
    ])
  ]
}

const localManifest = {
  name: "acme/review",
  version: "1.2.0",
  flows: ["flows"]
}

const installedManifest = {
  name: "vendor/review",
  version: "0.4.1",
  flows: ["flows"]
}

const tree = (entries: ReadonlyArray<readonly [string, Node]>): Map<string, Node> => new Map(entries)

const readPack = (nodes: Map<string, Node>, dir: string) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const path = yield* Path.Path
      return yield* Pack.read(virtualFileSystem(nodes), path, dir)
    }).pipe(Effect.provide(NodePath.layer))
  )

const readPackError = (nodes: Map<string, Node>, dir: string) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const path = yield* Path.Path
      return yield* Effect.flip(Pack.read(virtualFileSystem(nodes), path, dir))
    }).pipe(Effect.provide(NodePath.layer))
  )

const withRegistry = <A, E>(
  nodes: Map<string, Node>,
  packs: ReadonlyArray<Pack.Installed>,
  runtimeVersion: string,
  effect: (registry: Registry.Registry) => Effect.Effect<A, E>
) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const path = yield* Path.Path
      const fs = virtualFileSystem(nodes)
      return yield* Effect.provide(
        Effect.flatMap(Registry.Registry, effect),
        Registry.layerFromPacks(packs, { runtimeVersion }).pipe(
          Layer.provide(Layer.succeed(Discovery.Discovery)(Discovery.make(fs, path))),
          Layer.provide(Layer.succeed(FileSystem.FileSystem)(fs)),
          Layer.provide(Layer.succeed(Path.Path)(path))
        )
      )
    }).pipe(Effect.provide(NodePath.layer))
  )

const both = tree([
  ...packTree({ dir: "/local", manifest: localManifest, flows: { review: "Review it locally.", lint: "Lint it." } }),
  ...packTree({
    dir: "/installed",
    manifest: installedManifest,
    flows: { review: "Review it as the vendor does.", release: "Release it." }
  })
])

const installed = (
  dir: string,
  manifest: Record<string, unknown>,
  origin: Pack.Origin
): Pack.Installed => ({
  manifest: new Pack.Manifest(manifest as never),
  dir,
  origin
})

describe("Pack.read", () => {
  it("decodes a manifest and reports the pack root it was read from", async () => {
    const pack = await readPack(both, "/local")

    expect(pack.manifest.name).toBe("acme/review")
    expect(pack.manifest.version).toBe("1.2.0")
    expect(pack.manifest.flows).toEqual(["flows"])
    expect(pack.dir).toBe("/local")
  })

  it("fails invalid_pack when the manifest is absent", async () => {
    const error = await readPackError(tree([["/empty", { kind: "directory", entries: [] }]]), "/empty")

    expect(error).toMatchObject({ code: "invalid_pack" })
    expect(error.message).toContain("/empty/pack.json")
  })

  it("fails invalid_pack when the manifest is not valid JSON", async () => {
    const nodes = tree([
      ["/broken", { kind: "directory", entries: ["pack.json"] }],
      ["/broken/pack.json", { kind: "file", contents: "{ not json" }]
    ])

    expect(await readPackError(nodes, "/broken")).toMatchObject({ code: "invalid_pack" })
  })

  it("fails invalid_pack when the manifest omits a required field", async () => {
    const nodes = tree([
      ["/partial", { kind: "directory", entries: ["pack.json"] }],
      ["/partial/pack.json", manifestFile({ name: "acme/review" })]
    ])

    expect(await readPackError(nodes, "/partial")).toMatchObject({ code: "invalid_pack" })
  })
})

describe("Pack.digest", () => {
  const files = [
    { path: "flows/review/flow.mdx", contents: "Review it." },
    { path: "flows/lint/flow.mdx", contents: "Lint it." }
  ]

  it("is stable across file order", () => {
    const manifest = new Pack.Manifest(localManifest)

    expect(Pack.digest(manifest, files)).toBe(Pack.digest(manifest, [...files].reverse()))
  })

  it("changes when a flow body changes", () => {
    const manifest = new Pack.Manifest(localManifest)
    const edited = [files[0]!, { path: "flows/lint/flow.mdx", contents: "Lint it harder." }]

    expect(Pack.digest(manifest, edited)).not.toBe(Pack.digest(manifest, files))
  })

  it("covers the optional manifest halves in the address", () => {
    const bare = new Pack.Manifest(localManifest)
    const full = new Pack.Manifest({
      ...localManifest,
      skills: ["skills"],
      requires: { smithers: ">=1.0.0" }
    })

    expect(Pack.digest(full, files)).not.toBe(Pack.digest(bare, files))
  })

  it("changes when the manifest version changes", () => {
    const manifest = new Pack.Manifest(localManifest)
    const bumped = new Pack.Manifest({ ...localManifest, version: "1.3.0" })

    expect(Pack.digest(bumped, files)).not.toBe(Pack.digest(manifest, files))
  })
})

describe("Pack.compatible", () => {
  it("accepts a runtime inside the declared range and refuses one below it", () => {
    expect(Pack.compatible(">=1.0.0", "1.2.3")).toBe(true)
    expect(Pack.compatible(">=1.0.0", "0.9.0")).toBe(false)
    expect(Pack.compatible("^1.2.0", "1.9.0")).toBe(true)
    expect(Pack.compatible("^1.2.0", "2.0.0")).toBe(false)
    expect(Pack.compatible("~1.2.0", "1.2.9")).toBe(true)
    expect(Pack.compatible("~1.2.0", "1.3.0")).toBe(false)
    expect(Pack.compatible("1.2.3", "1.2.3")).toBe(true)
    expect(Pack.compatible("1.2.3", "1.2.4")).toBe(false)
    expect(Pack.compatible(">=1.0.0 <2.0.0", "1.5.0")).toBe(true)
    expect(Pack.compatible(">=1.0.0 <2.0.0", "2.1.0")).toBe(false)
    expect(Pack.compatible("<=1.2.3", "1.2.3")).toBe(true)
    expect(Pack.compatible("<=1.2.3", "1.2.4")).toBe(false)
    expect(Pack.compatible(">1.2.3", "1.2.4")).toBe(true)
    expect(Pack.compatible(">1.2.3", "1.2.3")).toBe(false)
    expect(Pack.compatible("<1.2.3", "1.2.2")).toBe(true)
    expect(Pack.compatible("<1.2.3", "1.2.3")).toBe(false)
    expect(Pack.compatible("=1.2.3", "1.2.3")).toBe(true)
    expect(Pack.compatible("^1.2.0", "1.1.0")).toBe(false)
    expect(Pack.compatible("~1.2.3", "1.2.2")).toBe(false)
    expect(Pack.compatible("~1.2.0", "2.2.0")).toBe(false)
    expect(Pack.compatible("^0.9.0", "1.0.0")).toBe(false)
    expect(Pack.compatible("*", "3.0.0")).toBe(true)
    expect(Pack.compatible("1.2.3", "1.3.3")).toBe(false)
    expect(Pack.compatible("1.2.3", "2.2.3")).toBe(false)
  })

  it("reads a caret on a zero-major line as npm does: the minor is the pin", () => {
    // `^0.2.3` is `>=0.2.3 <0.3.0`. A pre-1.0 line has no compatibility
    // promise across minors, so a caret that only pinned the major would let a
    // pack written for 0.2 load against the rewritten 0.9.
    expect(Pack.compatible("^0.2.3", "0.2.9")).toBe(true)
    expect(Pack.compatible("^0.2.3", "0.9.0")).toBe(false)
    expect(Pack.compatible("^0.2.3", "0.3.0")).toBe(false)
    expect(Pack.compatible("^0.2.3", "0.2.2")).toBe(false)
    // `^0.0.3` is `>=0.0.3 <0.0.4`: on a zero-minor line every patch is a
    // breaking release.
    expect(Pack.compatible("^0.0.3", "0.0.3")).toBe(true)
    expect(Pack.compatible("^0.0.3", "0.0.4")).toBe(false)
  })

  it("refuses an empty range", () => {
    expect(Pack.compatible("   ", "1.0.0")).toBe(false)
  })

  it("refuses a range or a version it cannot parse rather than guessing", () => {
    expect(Pack.compatible("not-a-range", "1.0.0")).toBe(false)
    expect(Pack.compatible(">=1.0.0", "not-a-version")).toBe(false)
  })

  it("compares prerelease-tagged runtimes on their release numbers", () => {
    expect(Pack.compatible(">=1.0.0", "1.0.0-rc.3")).toBe(true)
  })
})

describe("Registry.layerFromPacks", () => {
  it("names the pack and version in every descriptor's provenance", async () => {
    const entries = await withRegistry(
      both,
      [installed("/installed", installedManifest, "installed")],
      "1.0.0",
      (registry) => registry.list()
    )

    expect(entries.map((entry) => entry.name).sort()).toEqual(["release", "review"])
    for (const entry of entries) {
      expect(entry.provenance.pack).toEqual({
        name: "vendor/review",
        version: "0.4.1",
        origin: "installed"
      })
    }
  })

  it("shadows an installed flow with the local one and warns naming both packs", async () => {
    const result = await withRegistry(
      both,
      [
        installed("/installed", installedManifest, "installed"),
        installed("/local", localManifest, "local")
      ],
      "1.0.0",
      (registry) =>
        Effect.all({
          review: registry.get("review"),
          names: Effect.map(registry.list(), (entries) => entries.map((entry) => entry.name).sort()),
          warnings: registry.warnings()
        })
    )

    expect(result.names).toEqual(["lint", "release", "review"])
    expect(result.review.provenance.pack?.name).toBe("acme/review")
    const shadowed = result.warnings.filter((warning) => warning.code === "shadowed")
    expect(shadowed).toHaveLength(1)
    expect(shadowed[0]!.name).toBe("review")
    expect(shadowed[0]!.message).toContain("acme/review@1.2.0")
    expect(shadowed[0]!.message).toContain("vendor/review@0.4.1")
  })

  it("keeps the first local pack when two local packs declare one name", async () => {
    const result = await withRegistry(
      both,
      [
        installed("/local", localManifest, "local"),
        installed("/installed", { ...installedManifest, name: "vendor/other" }, "local")
      ],
      "1.0.0",
      (registry) =>
        Effect.all({
          review: registry.get("review"),
          warnings: registry.warnings()
        })
    )

    expect(result.review.provenance.pack?.name).toBe("acme/review")
    expect(result.warnings.filter((warning) => warning.code === "shadowed")).toHaveLength(1)
  })

  it("fails incompatible_pack when the runtime is outside requires.smithers", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.promise(() =>
          withRegistry(
            both,
            [installed("/local", { ...localManifest, requires: { smithers: ">=2.0.0" } }, "local")],
            "1.0.0",
            (registry) => registry.list()
          )
        )
      )
    )

    expect(exit._tag).toBe("Failure")
    expect(JSON.stringify(exit)).toContain("incompatible_pack")
  })

  it("admits a pack whose requires.smithers the runtime satisfies", async () => {
    const entries = await withRegistry(
      both,
      [installed("/local", { ...localManifest, requires: { smithers: ">=1.0.0" } }, "local")],
      "1.0.0",
      (registry) => registry.list()
    )

    expect(entries.map((entry) => entry.name).sort()).toEqual(["lint", "review"])
  })

  it("scans a pack's declared skills directories alongside its flows", async () => {
    const nodes = tree([
      ["/skilled", { kind: "directory", entries: ["pack.json", "flows", "skills"] }],
      ["/skilled/pack.json", manifestFile({ ...localManifest, skills: ["skills"] })],
      ["/skilled/flows", { kind: "directory", entries: ["review"] }],
      ["/skilled/flows/review", { kind: "directory", entries: ["flow.mdx"] }],
      ["/skilled/flows/review/flow.mdx", flowFile("Review it.", "Review it.")],
      ["/skilled/skills", { kind: "directory", entries: ["triage"] }],
      ["/skilled/skills/triage", { kind: "directory", entries: ["SKILL.md"] }],
      ["/skilled/skills/triage/SKILL.md", flowFile("Triage it.", "Triage it.")]
    ])

    const entries = await withRegistry(
      nodes,
      [installed("/skilled", { ...localManifest, skills: ["skills"] }, "local")],
      "1.0.0",
      (registry) => registry.list()
    )

    expect(entries.map((entry) => entry.name).sort()).toEqual(["review", "triage"])
  })

  it("loads a flow body through the pack's own root", async () => {
    const body = await withRegistry(
      both,
      [installed("/local", localManifest, "local")],
      "1.0.0",
      (registry) => registry.loadBody("lint")
    )

    expect(JSON.stringify(body)).toContain("Lint it.")
  })
})
