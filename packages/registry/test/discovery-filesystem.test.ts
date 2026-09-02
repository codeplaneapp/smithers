import * as NodePath from "@effect/platform-node/NodePath"
import { Effect, FileSystem, Layer, Option, Path, PlatformError } from "effect"
import { describe, expect, it } from "vitest"
import type { Source } from "../src/Descriptor.ts"
import * as Discovery from "../src/Discovery.ts"
import * as Registry from "../src/Registry.ts"

/**
 * A virtual host tree. Discovery reads directories, inspects entries, and
 * reads entry metadata, so the stub models exactly those three operations plus
 * the failures each of them can report.
 */
type Node =
  | { readonly kind: "file"; readonly contents: string; readonly reportedSize?: number }
  | { readonly kind: "unreadable-file" }
  | { readonly kind: "directory"; readonly entries: ReadonlyArray<string> }
  | { readonly kind: "unreadable-directory" }
  | { readonly kind: "special"; readonly type: FileSystem.File.Type }
  | { readonly kind: "unstattable" }

type FileNode = Extract<Node, { readonly kind: "file" }>

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

interface FileSystemCalls {
  readonly readFile: Array<string>
}

const virtualFileSystem = (nodes: Map<string, Node>, calls?: FileSystemCalls): FileSystem.FileSystem =>
  FileSystem.makeNoop({
    exists: (path) => Effect.succeed(nodes.has(path)),
    stat: (path) => {
      const node = nodes.get(path)
      switch (node?.kind) {
        case "file":
          return Effect.succeed(info("File", node.reportedSize ?? node.contents.length))
        case "unreadable-file":
          return Effect.succeed(info("File", 0))
        case "directory":
        case "unreadable-directory":
          return Effect.succeed(info("Directory", 0))
        case "special":
          return Effect.succeed(info(node.type, 0))
        default:
          return Effect.fail(denied("stat", path))
      }
    },
    readDirectory: (path) => {
      const node = nodes.get(path)
      return node?.kind === "directory" ? Effect.succeed([...node.entries]) : Effect.fail(denied("readDirectory", path))
    },
    readFile: (path) => {
      calls?.readFile.push(path)
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

const root = "/vfs"
const expectedEntrySizeLimit = 4 * 1024 * 1024

const tree = (nodes: Readonly<Record<string, Node>>): Map<string, Node> => new Map(Object.entries(nodes))

const scan = (nodes: Map<string, Node>, source: Partial<Source> = {}, calls?: FileSystemCalls) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const path = yield* Path.Path
      return yield* Discovery.make(virtualFileSystem(nodes, calls), path).scan({
        source: "virtual",
        root,
        naming: "path",
        ...source
      })
    }).pipe(Effect.provide(NodePath.layer))
  )

const scanError = (nodes: Map<string, Node>, source: Partial<Source> = {}) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const path = yield* Path.Path
      return yield* Effect.flip(
        Discovery.make(virtualFileSystem(nodes), path).scan({
          source: "virtual",
          root,
          naming: "path",
          ...source
        })
      )
    }).pipe(Effect.provide(NodePath.layer))
  )

const skill = (description: string, name?: string): FileNode => ({
  kind: "file",
  contents: [
    "---",
    ...(name === undefined ? [] : [`name: ${name}`]),
    `description: ${description}`,
    "capabilities: []",
    "---",
    `Body for ${description}`,
    ""
  ].join("\n")
})

const flowModule = (body: string): Node => ({
  kind: "file",
  contents: `export default Flow.make({\n${body}\n})\n`
})

describe("Discovery host failures", () => {
  it("fails with invalid_root when the source root is not a directory", async () => {
    const error = await scanError(tree({ [root]: { kind: "file", contents: "" } }))

    expect(error).toMatchObject({
      code: "invalid_root",
      message: `invalid_root: Discovery.scan: source root "${root}" is not a directory`
    })
  })

  it("fails with read_failed when the source root cannot be inspected", async () => {
    const error = await scanError(tree({ [root]: { kind: "unstattable" } }))

    expect(error).toMatchObject({
      code: "read_failed",
      message: `read_failed: Discovery.scan: could not inspect source root "${root}"`,
      cause: { _tag: "PlatformError" }
    })
  })

  it("fails with read_failed when the source root cannot be listed", async () => {
    const error = await scanError(tree({ [root]: { kind: "unreadable-directory" } }))

    expect(error).toMatchObject({
      code: "read_failed",
      message: `read_failed: Discovery.scan: could not read source root "${root}"`
    })
  })

  it("returns an empty scan for an empty source root", async () => {
    const result = await scan(tree({ [root]: { kind: "directory", entries: [] } }))

    expect(result.entries).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it("warns and keeps scanning when a nested directory cannot be listed", async () => {
    const result = await scan(tree({
      [root]: { kind: "directory", entries: ["ok", "sealed"] },
      [`${root}/sealed`]: { kind: "unreadable-directory" },
      [`${root}/ok`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/ok/SKILL.md`]: skill("Reads a file.")
    }))

    expect(result.entries.map((entry) => entry.name)).toEqual(["ok"])
    expect(result.warnings).toEqual([expect.objectContaining({
      code: "unreadable",
      path: `${root}/sealed`,
      message: `Could not read directory "${root}/sealed"`,
      cause: expect.objectContaining({ _tag: "PlatformError" })
    })])
    expect(result.warnings[0]).not.toHaveProperty("name")
  })

  it("warns and keeps scanning when an entry cannot be inspected", async () => {
    const result = await scan(tree({
      [root]: { kind: "directory", entries: ["ghost", "ok"] },
      [`${root}/ghost`]: { kind: "unstattable" },
      [`${root}/ok`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/ok/SKILL.md`]: skill("Reads a file.")
    }))

    expect(result.entries.map((entry) => entry.name)).toEqual(["ok"])
    expect(result.warnings).toEqual([expect.objectContaining({
      code: "unreadable",
      path: `${root}/ghost`,
      message: `Could not inspect "${root}/ghost"`
    })])
  })

  it("warns when entry metadata cannot be read and drops the entry", async () => {
    const result = await scan(tree({
      [root]: { kind: "directory", entries: ["sealed"] },
      [`${root}/sealed`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/sealed/SKILL.md`]: { kind: "unreadable-file" }
    }))

    expect(result.entries).toEqual([])
    expect(result.warnings).toEqual([expect.objectContaining({
      code: "unreadable",
      path: `${root}/sealed/SKILL.md`,
      message: `Could not read entry metadata from "${root}/sealed/SKILL.md"`
    })])
  })

  it.each(
    [
      ["a symbolic link", "SymbolicLink"],
      ["a fifo", "FIFO"],
      ["a socket", "Socket"],
      ["an unknown node", "Unknown"]
    ] as const
  )("ignores a host-reported %s node without warning", async (_label, type) => {
    const result = await scan(tree({
      [root]: { kind: "directory", entries: ["other"] },
      [`${root}/other`]: { kind: "special", type }
    }))

    expect(result.entries).toEqual([])
    expect(result.warnings).toEqual([])
  })
})

describe("Discovery traversal", () => {
  const nested = () =>
    tree({
      [root]: {
        kind: "directory",
        entries: [".git", ".hidden", "node_modules", "channels", "connections", "flows"]
      },
      [`${root}/.git`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/.git/SKILL.md`]: skill("Hidden by dot.", "git"),
      [`${root}/.hidden`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/.hidden/SKILL.md`]: skill("Hidden by dot.", "hidden"),
      [`${root}/node_modules`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/node_modules/SKILL.md`]: skill("Vendored.", "vendored"),
      [`${root}/channels`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/channels/SKILL.md`]: skill("A channel.", "channels"),
      [`${root}/connections`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/connections/SKILL.md`]: skill("A connection.", "connections"),
      [`${root}/flows`]: { kind: "directory", entries: ["SKILL.md", "channels"] },
      [`${root}/flows/SKILL.md`]: skill("A flow.", "flows"),
      [`${root}/flows/channels`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/flows/channels/SKILL.md`]: skill("A nested channel.", "nested-channel")
    })

  it("skips reserved directories at the root of a path-named source", async () => {
    const result = await scan(nested())

    expect(result.entries.map((entry) => entry.name)).toEqual(["flows", "flows/channels"])
  })

  it("scans root-level channels and connections when names come from frontmatter", async () => {
    const result = await scan(nested(), { naming: "frontmatter" })

    expect(result.entries.map((entry) => entry.name)).toEqual([
      "channels",
      "connections",
      "flows",
      "nested-channel"
    ])
  })

  it("warns about a root-level entry in a path-named source and keeps its children", async () => {
    const result = await scan(tree({
      [root]: { kind: "directory", entries: ["SKILL.md", "nested"] },
      [`${root}/SKILL.md`]: skill("At the root."),
      [`${root}/nested`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/nested/SKILL.md`]: skill("Nested.")
    }))

    expect(result.entries.map((entry) => entry.name)).toEqual(["nested"])
    expect(result.warnings).toEqual([expect.objectContaining({
      code: "root_level_entry",
      path: `${root}/SKILL.md`,
      message: "Path-named sources cannot contain a root-level entry"
    })])
  })

  it("discovers a root-level entry when names come from frontmatter", async () => {
    const result = await scan(
      tree({
        [root]: { kind: "directory", entries: ["SKILL.md"] },
        [`${root}/SKILL.md`]: skill("At the root.", "vfs")
      }),
      { naming: "frontmatter" }
    )

    expect(result.entries.map((entry) => entry.name)).toEqual(["vfs"])
    expect(result.warnings).toEqual([])
  })

  it("warns once when a directory holds several entry files and uses the precedence order", async () => {
    const result = await scan(tree({
      [root]: { kind: "directory", entries: ["multi"] },
      [`${root}/multi`]: { kind: "directory", entries: ["SKILL.md", "flow.mdx", "flow.ts"] },
      [`${root}/multi/SKILL.md`]: skill("From the skill file."),
      [`${root}/multi/flow.mdx`]: skill("From the markdown flow."),
      [`${root}/multi/flow.ts`]: flowModule("  description: \"From the module.\",\n  capabilities: []")
    }))

    expect(result.entries.map((entry) => entry.description)).toEqual(["From the module."])
    expect(result.warnings).toEqual([expect.objectContaining({
      code: "multiple_entry_files",
      path: `${root}/multi`,
      message: "Multiple entry files found (flow.ts, flow.mdx, SKILL.md); using flow.ts"
    })])
  })

  it("orders entries and warnings by path even when traversal finds them out of order", async () => {
    const result = await scan(tree({
      [root]: { kind: "directory", entries: ["a", "a-b"] },
      [`${root}/a`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/a/SKILL.md`]: skill("Discovered first.", "a"),
      [`${root}/a-b`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/a-b/SKILL.md`]: skill("Discovered second.", "a-b")
    }))

    expect(result.entries.map((entry) => entry.path)).toEqual([
      `${root}/a-b/SKILL.md`,
      `${root}/a/SKILL.md`
    ])
    expect(result.warnings.map((warning) => warning.path)).toEqual([
      `${root}/a-b/SKILL.md`,
      `${root}/a/SKILL.md`
    ])
  })

  it("sorts warnings that share a path by code and then by message", async () => {
    const result = await scan(tree({
      [root]: { kind: "directory", entries: ["keys"] },
      [`${root}/keys`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/keys/SKILL.md`]: {
        kind: "file",
        contents: [
          "---",
          "description: Declares unknown keys.",
          "capabilities: []",
          "zeta: 1",
          "alpha: 2",
          "middle: 3",
          "---",
          "body"
        ].join("\n")
      }
    }))

    expect(result.warnings.map((warning) => warning.message)).toEqual([
      "Unknown frontmatter key: alpha",
      "Unknown frontmatter key: middle",
      "Unknown frontmatter key: zeta"
    ])
  })

  it("bounds a duplicate directory listing by physical identity", async () => {
    const result = await scan(tree({
      [root]: { kind: "directory", entries: ["dup", "dup", "dup"] },
      [`${root}/dup`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/dup/SKILL.md`]: {
        kind: "file",
        contents: "---\ndescription: Listed twice.\nunknown: 1\n---\nbody"
      }
    }))

    expect(result.entries.map((entry) => entry.path)).toEqual([`${root}/dup/SKILL.md`])
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "symlink_cycle",
      "symlink_cycle",
      "unknown_frontmatter_key",
      "unprojectable_authority"
    ])
  })

  it("stops parsing entry metadata at the 64 KiB parsing ceiling", async () => {
    const result = await scan(tree({
      [root]: { kind: "directory", entries: ["huge"] },
      [`${root}/huge`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/huge/SKILL.md`]: {
        kind: "file",
        contents: [
          "---",
          "description: Declared past the ceiling.",
          `padding: ${"x".repeat(70 * 1024)}`,
          "---",
          "body"
        ].join("\n")
      }
    }))

    expect(result.entries).toEqual([])
    expect(result.warnings).toEqual([expect.objectContaining({
      code: "missing_description",
      path: `${root}/huge/SKILL.md`
    })])
  })

  it("skips an oversized entry before reading its bytes", async () => {
    const location = `${root}/huge/SKILL.md`
    const calls: FileSystemCalls = { readFile: [] }
    const result = await scan(
      tree({
        [root]: { kind: "directory", entries: ["huge"] },
        [`${root}/huge`]: { kind: "directory", entries: ["SKILL.md"] },
        [location]: {
          ...skill("Too large to read."),
          reportedSize: expectedEntrySizeLimit + 1
        }
      }),
      {},
      calls
    )

    expect(result.entries).toEqual([])
    expect(result.warnings).toEqual([expect.objectContaining({
      code: "entry_too_large",
      path: location,
      message: expect.stringContaining(String(expectedEntrySizeLimit + 1))
    })])
    expect(calls.readFile).toEqual([])
  })

  /**
   * The stat pre-check is a fast path, not the bound. A host whose `stat`
   * under-reports or omits a size — an in-memory or remote FileSystem, a
   * special file — walks straight past it, so the bytes actually read decide.
   * `readFile` IS called here; the guarantee is that an oversized entry is
   * refused with the same code before it is hashed, parsed, or registered.
   */
  it("refuses an oversized entry whose reported size was wrong", async () => {
    const location = `${root}/lying/SKILL.md`
    const body = "x".repeat(expectedEntrySizeLimit)
    const calls: FileSystemCalls = { readFile: [] }
    const contents = [
      "---",
      "description: The host under-reported this entry.",
      "capabilities: []",
      "---",
      body,
      ""
    ].join("\n")
    const result = await scan(
      tree({
        [root]: { kind: "directory", entries: ["lying"] },
        [`${root}/lying`]: { kind: "directory", entries: ["SKILL.md"] },
        [location]: { kind: "file", contents, reportedSize: 0 }
      }),
      {},
      calls
    )

    expect(result.entries).toEqual([])
    expect(result.warnings).toEqual([expect.objectContaining({
      code: "entry_too_large",
      path: location,
      message: expect.stringContaining(String(new TextEncoder().encode(contents).length))
    })])
    expect(calls.readFile).toEqual([location])
  })

  it("still discovers an entry reported just below the input ceiling", async () => {
    const location = `${root}/bounded/SKILL.md`
    const calls: FileSystemCalls = { readFile: [] }
    const result = await scan(
      tree({
        [root]: { kind: "directory", entries: ["bounded"] },
        [`${root}/bounded`]: { kind: "directory", entries: ["SKILL.md"] },
        [location]: {
          ...skill("Within the input ceiling."),
          reportedSize: expectedEntrySizeLimit - 1
        }
      }),
      {},
      calls
    )

    expect(result.entries.map((entry) => entry.name)).toEqual(["bounded"])
    expect(result.warnings).toEqual([])
    expect(calls.readFile).toEqual([location])
  })
})

describe("Discovery module entries", () => {
  it("projects a module without declared schemas and warns about its ignored name", async () => {
    const result = await scan(tree({
      [root]: { kind: "directory", entries: ["tools"] },
      [`${root}/tools`]: { kind: "directory", entries: ["report"] },
      [`${root}/tools/report`]: { kind: "directory", entries: ["flow.ts"] },
      [`${root}/tools/report/flow.ts`]: flowModule(
        "  name: \"ignored\",\n  description: \"Reports a result.\",\n  capabilities"
      )
    }))
    const entry = result.entries[0]

    expect(entry?.name).toBe("tools/report")
    expect(entry?.input).toMatchObject({ _tag: "None" })
    expect(entry?.output).toMatchObject({ _tag: "None" })
    expect(entry?.capabilities).toEqual(["*"])
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "name_field_ignored",
        name: "tools/report",
        message: "Ignoring Flow.make name because this source uses path-derived names"
      }),
      expect.objectContaining({
        code: "unsupported_module_metadata",
        name: "tools/report",
        message: "Capabilities must be a string-literal array for discovery; using the conservative wildcard"
      })
    ])
  })

  it("drops a module flow that declares no description", async () => {
    const result = await scan(tree({
      [root]: { kind: "directory", entries: ["report"] },
      [`${root}/report`]: { kind: "directory", entries: ["flow.ts"] },
      [`${root}/report/flow.ts`]: flowModule("  capabilities: []")
    }))

    expect(result.entries).toEqual([])
    expect(result.warnings).toEqual([expect.objectContaining({
      code: "missing_description",
      name: "report",
      message: "Module flows require a literal description in the default Flow.make or Flow.agent value"
    })])
  })

  it("names a module flow after its directory when names come from frontmatter", async () => {
    const result = await scan(
      tree({
        [root]: { kind: "directory", entries: ["report"] },
        [`${root}/report`]: { kind: "directory", entries: ["flow.ts"] },
        [`${root}/report/flow.ts`]: flowModule(
          "  name: \"declared\",\n  description: \"Reports a result.\",\n  input: Schema.String,\n  capabilities: []"
        )
      }),
      { naming: "frontmatter" }
    )
    const entry = result.entries[0]

    expect(entry?.name).toBe("report")
    expect(entry?.input).toMatchObject({ _tag: "Module", field: "input" })
    expect(entry?.output).toMatchObject({ _tag: "None" })
    expect(result.warnings).toEqual([])
  })
})

describe("Registry over a virtual host", () => {
  const registryLayer = (nodes: Map<string, Node>, sources: ReadonlyArray<Source>) => {
    const platform = Layer.merge(Layer.succeed(FileSystem.FileSystem)(virtualFileSystem(nodes)), NodePath.layer)
    return Registry.layer({ sources }).pipe(
      Layer.provide(Layer.merge(Discovery.layer.pipe(Layer.provide(platform)), platform))
    )
  }

  it("refuses same-path body drift until the registry refreshes its content address", async () => {
    const nodes = tree({
      [root]: { kind: "directory", entries: ["review"] },
      [`${root}/review`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/review/SKILL.md`]: {
        kind: "file",
        contents: "---\ndescription: Reviews a change.\ncapabilities: []\n---\nOriginal body."
      }
    })
    const layer = registryLayer(nodes, [{ source: "virtual", root, naming: "path" }])

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        const declaredBefore = yield* registry.get("review")
        const before = yield* registry.loadBody("review")
        yield* Effect.sync(() => {
          nodes.set(`${root}/review/SKILL.md`, {
            kind: "file",
            contents: "---\ndescription: Reviews a change.\ncapabilities: []\n---\nRewritten body."
          })
        })
        const stale = yield* Effect.flip(registry.loadBody("review"))
        yield* registry.refresh()
        const declaredAfter = yield* registry.get("review")
        const after = yield* registry.loadBody("review")
        return { after, before, declaredAfter, declaredBefore, stale }
      }).pipe(Effect.provide(layer))
    )

    expect(result.before).toMatchObject({ _tag: "Prompt", text: "Original body." })
    expect(result.stale).toMatchObject({ code: "body_unavailable", method: "loadBody" })
    expect(result.stale.path).toBe(`${root}/review/SKILL.md`)
    expect(result.after).toMatchObject({ _tag: "Prompt", text: "Rewritten body." })
    expect(result.declaredBefore.body.contentDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(result.declaredAfter.body.contentDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(result.declaredAfter.body.contentDigest).not.toBe(result.declaredBefore.body.contentDigest)
  })

  it("keeps one entry when the host lists one physical directory twice", async () => {
    const nodes = tree({
      [root]: { kind: "directory", entries: ["review", "review"] },
      [`${root}/review`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/review/SKILL.md`]: skill("Reviews a change.")
    })

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        return { entries: yield* registry.list(), warnings: yield* registry.warnings() }
      }).pipe(Effect.provide(registryLayer(nodes, [{ source: "virtual", root, naming: "path" }])))
    )

    expect(result.entries.map((entry) => entry.name)).toEqual(["review"])
    expect(result.warnings).toEqual([expect.objectContaining({
      code: "symlink_cycle",
      path: `${root}/review`,
      message:
        `Directory "${root}/review" resolves to already visited directory "${root}/review"; skipping recursive traversal`
    })])
  })
})
