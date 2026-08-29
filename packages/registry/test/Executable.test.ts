/**
 * The descriptor-to-runtime bridge, seen from the outside.
 *
 * Discovery hands back metadata; this suite is about what the bridge does with
 * it before the engine ever sees a flow. Delegate resolution, annotation
 * lowering, and every refusal happen here, at load time, because a wiring
 * mistake surfaced at dispatch reaches an operator as an empty `AnyOf` defect
 * that names nothing.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import { Annotations, Flow as CoreFlow, Placement as CorePlacement } from "@smthrs/core"
import { Action, Flow, FlowRuntime, Graph } from "@smthrs/flow"
import * as CacheEnvironment from "@smthrs/flow/CacheEnvironment"
import { Node } from "@smthrs/plan"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"
import * as Schema from "effect/Schema"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import * as Descriptor from "../src/Descriptor.ts"
import * as Discovery from "../src/Discovery.ts"
import * as Executable from "../src/Executable.ts"
import * as Registry from "../src/Registry.ts"
import greetModule from "./fixtures/executable/flows/greet/flow.ts"

const flowsRoot = fileURLToPath(new URL("./fixtures/executable/flows", import.meta.url))
const projectRoot = fileURLToPath(new URL("./fixtures/executable", import.meta.url))
const modulesRoot = fileURLToPath(new URL("./fixtures/executable/modules", import.meta.url))
const fixturesRoot = fileURLToPath(new URL("./fixtures", import.meta.url))

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)

/** The delegate every fixture that resolves one names. */
const Echo = Flow.make("test/echo", {
  payload: Executable.Invocation,
  success: Schema.String,
  body: (payload) => Node.succeed(payload.flow)
})

/** A second registered flow, so an ambiguous declaration has two real targets. */
const Other = Flow.make("test/other", {
  payload: Executable.Invocation,
  success: Schema.String,
  body: (payload) => Node.succeed(payload.flow)
})

/** The agent driver a descriptor falls back to when it names no single flow. */
const Agent = Flow.make("agent", {
  payload: Executable.Invocation,
  success: Schema.String,
  body: (payload) => Node.succeed(payload.prompt)
})

/**
 * The options every case starts from.
 *
 * `load` is deliberately absent, so the default loader — a dynamic `import` of
 * the `file:` specifier {@link module:Executable} builds — is the path under
 * test everywhere a fixture module is read. A stand-in is passed only by the
 * cases that need a module no file can contain, such as one with no default
 * export.
 */
const options = (
  overrides: Partial<Executable.Options> = {}
): Executable.Options => ({ delegates: [Echo, Other, Agent], ...overrides })

const scan = Effect.gen(function*() {
  const discovery = yield* Discovery.Discovery
  return yield* discovery.scan({ source: "project", root: flowsRoot, naming: "path" })
}).pipe(Effect.provide(Discovery.layer.pipe(Layer.provide(platform))), Effect.provide(platform))

const descriptorNamed = (name: string) =>
  Effect.map(scan, (result) => {
    const found = result.entries.find((entry) => entry.name === name)
    expect(found, name).toBeDefined()
    return found as Descriptor.FlowDescriptor
  })

const registryLayer = Registry.layer({
  sources: [{ source: "project", root: flowsRoot, naming: "path" }]
}).pipe(Layer.provide(Layer.merge(Discovery.layer.pipe(Layer.provide(platform)), platform)))

describe("delegate resolution", () => {
  it.effect("delegates to the one flow a descriptor names", () =>
    Effect.gen(function*() {
      const descriptor = yield* descriptorNamed("greet")
      const executable = yield* Executable.fromDescriptor(descriptor, options())
      expect(executable.delegate).toBe("test/echo")
      expect(executable.flow._tag).toBe("greet")
    }).pipe(Effect.provide(platform)))

  it.effect("delegates a markdown flow to the flow its frontmatter names", () =>
    Effect.gen(function*() {
      const descriptor = yield* descriptorNamed("changelog")
      const executable = yield* Executable.fromDescriptor(descriptor, options())
      expect(executable.delegate).toBe("test/echo")
      // The prompt is the rendered body, not the raw file: frontmatter is gone
      // and the skill-resources block a driver reads is present.
      expect(executable.invocation(null).prompt).toContain("Summarize the changes")
      expect(executable.invocation(null).prompt).not.toContain("description:")
    }).pipe(Effect.provide(platform)))

  it.effect("delegates to the agent when a descriptor names no flow", () =>
    Effect.gen(function*() {
      const descriptor = new Descriptor.FlowDescriptor({
        ...(yield* descriptorNamed("greet")),
        name: "bare",
        flows: []
      })
      const executable = yield* Executable.fromDescriptor(descriptor, options())
      expect(executable.delegate).toBe(Executable.defaultAgent)
    }).pipe(Effect.provide(platform)))

  it.effect("delegates to the agent a host renamed", () =>
    Effect.gen(function*() {
      const descriptor = new Descriptor.FlowDescriptor({
        ...(yield* descriptorNamed("greet")),
        name: "bare",
        flows: []
      })
      const driver = Flow.make("host/driver", {
        payload: Executable.Invocation,
        success: Schema.String,
        body: (payload) => Node.succeed(payload.flow)
      })
      const executable = yield* Executable.fromDescriptor(
        descriptor,
        options({ delegates: [driver], agent: "host/driver" })
      )
      expect(executable.delegate).toBe("host/driver")
    }).pipe(Effect.provide(platform)))

  it.effect("delegates a model-backed descriptor to the agent even when it names tools", () =>
    Effect.gen(function*() {
      const descriptor = new Descriptor.FlowDescriptor({
        ...(yield* descriptorNamed("undecided")),
        model: Option.some("smart")
      })
      const executable = yield* Executable.fromDescriptor(descriptor, options())
      expect(executable.delegate).toBe(Executable.defaultAgent)
      expect(executable.invocation(null).flows).toEqual(["test/echo", "test/other"])
    }).pipe(Effect.provide(platform)))
})

describe("refusals", () => {
  it.effect("names the missing flow rather than dying inside the engine", () =>
    Effect.gen(function*() {
      const descriptor = yield* descriptorNamed("orphan")
      const failure = yield* Effect.flip(Executable.fromDescriptor(descriptor, options()))
      expect(failure.code).toBe("missing_delegate")
      expect(failure.delegate).toBe("test/missing")
      expect(failure.flow).toBe("orphan")
      expect(failure.message).toContain("test/missing")
      // The refusal also says what IS registered, so an operator can see the
      // spelling they missed.
      expect(failure.available).toEqual(["agent", "test/echo", "test/other"])
    }).pipe(Effect.provide(platform)))

  it.effect("refuses a declaration with nothing to choose between", () =>
    Effect.gen(function*() {
      const descriptor = yield* descriptorNamed("undecided")
      const failure = yield* Effect.flip(Executable.fromDescriptor(descriptor, options()))
      expect(failure.code).toBe("ambiguous_delegate")
      expect(failure.message).toContain("undecided")
    }).pipe(Effect.provide(platform)))

  it.effect("refuses a markdown body it cannot read", () =>
    Effect.gen(function*() {
      const descriptor = new Descriptor.FlowDescriptor({
        ...(yield* descriptorNamed("changelog")),
        body: new Descriptor.BodyRefMarkdown({
          path: `${flowsRoot}/changelog/absent.mdx`,
          baseDirectory: `${flowsRoot}/changelog`
        })
      })
      const failure = yield* Effect.flip(Executable.fromDescriptor(descriptor, options()))
      expect(failure.code).toBe("body_unavailable")
      expect(failure.message).toContain("absent.mdx")
    }).pipe(Effect.provide(platform)))

  it.effect("refuses a module body the loader cannot load", () =>
    Effect.gen(function*() {
      const descriptor = new Descriptor.FlowDescriptor({
        ...(yield* descriptorNamed("greet")),
        body: new Descriptor.BodyRefModule({ path: `${modulesRoot}/absent.mjs` })
      })
      const failure = yield* Effect.flip(Executable.fromDescriptor(descriptor, options()))
      expect(failure.code).toBe("body_unavailable")
      expect(failure.message).toContain("absent.mjs")
    }).pipe(Effect.provide(platform)))

  it.effect("accepts a body path already written as a file URL", () =>
    Effect.gen(function*() {
      const descriptor = new Descriptor.FlowDescriptor({
        ...(yield* descriptorNamed("greet")),
        body: new Descriptor.BodyRefModule({ path: `file://${modulesRoot}/plain.mjs` })
      })
      // The loader reached the module — it refused what the module exports,
      // not the specifier it was given.
      const failure = yield* Effect.flip(Executable.fromDescriptor(descriptor, options()))
      expect(failure.code).toBe("invalid_module")
    }).pipe(Effect.provide(platform)))

  it.effect("refuses a body path that is not absolute", () =>
    Effect.gen(function*() {
      const descriptor = new Descriptor.FlowDescriptor({
        ...(yield* descriptorNamed("greet")),
        body: new Descriptor.BodyRefModule({ path: "fixtures/executable/modules/plain.mjs" })
      })
      const failure = yield* Effect.flip(Executable.fromDescriptor(descriptor, options()))
      expect(failure.code).toBe("body_unavailable")
    }).pipe(Effect.provide(platform)))

  it.effect("refuses a module that default-exports something other than a flow", () =>
    Effect.gen(function*() {
      const descriptor = new Descriptor.FlowDescriptor({
        ...(yield* descriptorNamed("greet")),
        body: new Descriptor.BodyRefModule({ path: `${modulesRoot}/plain.mjs` })
      })
      const failure = yield* Effect.flip(Executable.fromDescriptor(descriptor, options()))
      expect(failure.code).toBe("invalid_module")
      expect(failure.message).toContain("plain.mjs")
    }).pipe(Effect.provide(platform)))

  it.effect("refuses a module with no default export at all", () =>
    Effect.gen(function*() {
      const descriptor = yield* descriptorNamed("greet")
      const failure = yield* Effect.flip(
        Executable.fromDescriptor(descriptor, options({ load: () => Effect.succeed({}) }))
      )
      expect(failure.code).toBe("invalid_module")
    }).pipe(Effect.provide(platform)))
})

describe("the module specifier", () => {
  it("escapes the characters a path and a URL both claim", () => {
    // `#`, `?`, and a literal `%` are legal in a filename and structural in a
    // URL. Concatenating one truncates the specifier at it, so the loader
    // addresses a shorter path and reports a module that is right there as
    // missing.
    expect(Executable.fileSpecifier("/flows/rev#2/flow.ts")).toBe("file:///flows/rev%232/flow.ts")
    expect(Executable.fileSpecifier("/flows/a?b/flow.ts")).toBe("file:///flows/a%3Fb/flow.ts")
    // `%` is escaped FIRST, so a path that already contains `%23` survives as
    // a literal instead of decoding back into a `#`.
    expect(Executable.fileSpecifier("/flows/a%23b/flow.ts")).toBe("file:///flows/a%2523b/flow.ts")
    // Anything already written as a specifier is the caller's own, untouched.
    expect(Executable.fileSpecifier("file:///flows/greet/flow.ts")).toBe("file:///flows/greet/flow.ts")
  })

  it("builds a specifier Node's own loader resolves", async () => {
    // The default loader's `import` runs under whatever loader the host has,
    // and this suite's is vite-node, which resolves neither form. So the proof
    // is Node itself: a real subprocess, the real ESM resolver, the production
    // specifier, and a fixture that really does live under a directory named
    // `rev#2`.
    const specifier = Executable.fileSpecifier(`${modulesRoot}/rev#2/plain.mjs`)
    const loaded = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const m = await import(${JSON.stringify(specifier)}); process.stdout.write(m.default.notAFlow)`
        ],
        (error, stdout, stderr) => error === null ? resolve(stdout) : reject(new Error(stderr))
      )
    })
    expect(loaded).toBe("rev#2")
  })
})

describe("annotation lowering", () => {
  it.effect("reads the cache policy, the priority, and the placement a body declares", () =>
    Effect.gen(function*() {
      const descriptor = yield* descriptorNamed("tuned")
      const executable = yield* Executable.fromDescriptor(descriptor, options())
      expect(executable.lowered.cache).toEqual({ ttlMs: 60_000, scope: "shared" })
      expect(executable.lowered.priority).toBe(7)
      expect(executable.lowered.placement).toEqual(CorePlacement.sandbox())
    }).pipe(Effect.provide(platform)))

  it.effect("puts the policy under the identifier the engine reads at dispatch", () =>
    Effect.gen(function*() {
      const descriptor = yield* descriptorNamed("tuned")
      const executable = yield* Executable.fromDescriptor(descriptor, options())
      // The declaration and the dispatch name ONE key. This assertion is the
      // drift guard: it reads the bridge's bag back with `@smthrs/flow`'s own
      // reader, so it fails the moment the two identifiers stop matching.
      expect(CacheEnvironment.cachePolicyOf(executable.flow.annotations)).toEqual({
        ttlMs: 60_000,
        scope: "shared"
      })
    }).pipe(Effect.provide(platform)))

  it.effect("carries the placement into the plan and into the delegate's envelope", () =>
    Effect.gen(function*() {
      const descriptor = yield* descriptorNamed("tuned")
      const executable = yield* Executable.fromDescriptor(descriptor, options())
      expect(Context.getOption(executable.flow.annotations, Flow.Placement)).toEqual(
        Option.some(CorePlacement.sandbox())
      )
      expect(executable.invocation(null).placement).toBe("sandbox")
    }).pipe(Effect.provide(platform)))

  it.effect("prefers a placement the body annotates over the descriptor's directive", () =>
    Effect.gen(function*() {
      const descriptor = yield* descriptorNamed("greet")
      const annotated = CoreFlow.within(greetModule, CorePlacement.remote({ profile: "builder" }))
      const executable = yield* Executable.fromDescriptor(
        descriptor,
        options({ load: () => Effect.succeed({ default: annotated }) })
      )
      expect(executable.lowered.placement).toEqual(CorePlacement.remote({ profile: "builder" }))
      // The descriptor's own directive still travels, because it is what a
      // driver that never loaded the module can read.
      expect(executable.invocation(null).placement).toBe("local")
    }).pipe(Effect.provide(platform)))

  it.effect("lowers every placement literal a descriptor can carry", () =>
    Effect.gen(function*() {
      const base = yield* descriptorNamed("greet")
      const lowered = (placement: Descriptor.Placement) =>
        Executable.lower(
          new Descriptor.FlowDescriptor({ ...base, placement: Option.some(placement) }),
          Context.empty()
        ).placement
      expect(lowered("client")).toEqual(CorePlacement.client())
      expect(lowered("local")).toEqual(CorePlacement.local())
      expect(lowered("sandbox")).toEqual(CorePlacement.sandbox())
      expect(lowered("remote")).toEqual(CorePlacement.remote())
    }).pipe(Effect.provide(platform)))

  it.effect("leaves an undeclared policy, priority, and placement undeclared", () =>
    Effect.gen(function*() {
      const descriptor = yield* descriptorNamed("changelog")
      const executable = yield* Executable.fromDescriptor(descriptor, options())
      expect(executable.lowered.cache).toBeUndefined()
      expect(executable.lowered.priority).toBeUndefined()
      expect(executable.lowered.placement).toBeUndefined()
      expect(Context.getOption(executable.flow.annotations, Flow.Placement)).toEqual(Option.none())
    }).pipe(Effect.provide(platform)))

  it.effect("puts an authored priority on the delegating node", () =>
    Effect.gen(function*() {
      const tuned = yield* Executable.fromDescriptor(yield* descriptorNamed("tuned"), options())
      const plain = yield* Executable.fromDescriptor(yield* descriptorNamed("greet"), options())
      const priorityOf = (flow: Flow.Any) =>
        Graph.drafts(Graph.build(flow, { input: null })).map((draft) => draft.priority ?? 0)
      // The root is the flow's own call and states none; the delegating node
      // beneath it carries what the body declared.
      expect(priorityOf(tuned.flow)).toContain(7)
      expect(priorityOf(plain.flow).every((priority) => priority === 0)).toBe(true)
    }).pipe(Effect.provide(platform)))

  it.effect("makes a changed policy a changed step key", () =>
    Effect.gen(function*() {
      const descriptor = yield* descriptorNamed("greet")
      const withPolicy = (policy: CacheEnvironment.CachePolicy | undefined) =>
        Executable.fromDescriptor(
          descriptor,
          options({
            load: () =>
              Effect.succeed({
                default: policy === undefined
                  ? greetModule
                  : CoreFlow.annotate(greetModule, CacheEnvironment.CachePolicyAnnotation, policy)
              })
          })
        )
      const keys = (flow: Flow.Any) =>
        Graph.drafts(Graph.build(flow, { input: null })).map((draft) => JSON.stringify(draft.material))
      const first = yield* withPolicy({ ttlMs: 1000 })
      const same = yield* withPolicy({ ttlMs: 1000 })
      const other = yield* withPolicy({ ttlMs: 2000 })
      const none = yield* withPolicy(undefined)
      expect(keys(first.flow)).toEqual(keys(same.flow))
      expect(keys(first.flow)).not.toEqual(keys(other.flow))
      // An undeclared policy captures nothing, so a flow that never declared
      // one keys exactly as it did before the policy existed.
      expect(keys(none.flow).length).toBeLessThan(keys(first.flow).length)
    }).pipe(Effect.provide(platform)))

  it.effect("lowers a priority a flow states through Node.priority on its body", () =>
    Effect.gen(function*() {
      const descriptor = yield* descriptorNamed("greet")
      const bag = Context.add(Context.empty(), Annotations.Priority, -3)
      expect(Executable.lower(descriptor, bag).priority).toBe(-3)
    }).pipe(Effect.provide(platform)))
})

describe("the host's catalog", () => {
  it.effect("makes every runnable discovered flow available and reports the rest", () =>
    Effect.gen(function*() {
      const built = yield* Executable.catalog(options())
      expect(built.executables.map((executable) => executable.descriptor.name).sort()).toEqual([
        "changelog",
        "greet",
        "scoped",
        "tuned"
      ])
      expect(built.refused.map((failure) => `${failure.flow}:${failure.code}`).sort()).toEqual([
        "orphan:missing_delegate",
        "undecided:ambiguous_delegate"
      ])
    }).pipe(Effect.provide(registryLayer), Effect.provide(platform)))

  it.effect("reports a defective entry instead of failing the whole catalog", () =>
    Effect.gen(function*() {
      // Every module body is now unreadable; only the markdown flow survives.
      // `flows/` is a directory a person edits, so one entry being broken is an
      // ordinary state, and taking the host's other flows down with it would
      // make `ls` and every unrelated `up` fail for an unrelated typo.
      const built = yield* Executable.catalog(options({ load: () => Effect.succeed({}) }))
      expect(built.executables.map((executable) => executable.descriptor.name)).toEqual(["changelog"])
      expect(built.refused.map((failure) => `${failure.flow}:${failure.code}`).sort()).toEqual([
        "greet:invalid_module",
        "orphan:missing_delegate",
        "scoped:invalid_module",
        "tuned:invalid_module",
        "undecided:ambiguous_delegate"
      ])
    }).pipe(Effect.provide(registryLayer), Effect.provide(platform)))

  it.effect("looks one flow up by registry name", () =>
    Effect.gen(function*() {
      const executable = yield* Executable.fromRegistry("greet", options())
      expect(executable.delegate).toBe("test/echo")
    }).pipe(Effect.provide(registryLayer), Effect.provide(platform)))

  it.effect("fails a name the registry does not hold", () =>
    Effect.gen(function*() {
      const failure = yield* Effect.flip(Executable.fromRegistry("absent", options()))
      expect(failure._tag).toBe("flows/registry/RegistryError")
    }).pipe(Effect.provide(registryLayer), Effect.provide(platform)))
})

describe("the project registry", () => {
  it.effect("discovers a project's own flows", () =>
    Effect.gen(function*() {
      const registry = yield* Registry.Registry
      const names = (yield* registry.list()).map((entry) => entry.name).sort()
      expect(names).toEqual(["changelog", "greet", "orphan", "scoped", "tuned", "undecided"])
    }).pipe(
      Effect.provide(Executable.layerProject({ root: projectRoot })),
      Effect.provide(platform)
    ))

  it.effect("treats a project with no flows directory as a project with no flows", () =>
    Effect.gen(function*() {
      const registry = yield* Registry.Registry
      expect(yield* registry.list()).toEqual([])
    }).pipe(
      Effect.provide(Executable.layerProject({ root: `${projectRoot}/absent` })),
      Effect.provide(platform)
    ))

  it.effect("scans installed packs beside the project's own flows, local packs first", () =>
    Effect.gen(function*() {
      const registry = yield* Registry.Registry
      const entries = yield* registry.list()
      const names = entries.map((entry) => entry.name)
      expect(names).toContain("greet")
      expect(names).toContain("pdf")
      expect(names).toContain("template-skill")
      // Pack entries carry the pack they came from. A host that cannot say
      // which pack a flow arrived in cannot answer "why is this here" or
      // "which pack do I uninstall".
      const pdf = entries.find((entry) => entry.name === "pdf")
      expect(pdf?.provenance.pack?.name).toBe("fixtures")
      expect(pdf?.provenance.pack?.origin).toBe("local")
      // The project's own flows are not pack flows.
      expect(entries.find((entry) => entry.name === "greet")?.provenance.pack).toBeUndefined()
    }).pipe(
      Effect.provide(
        Executable.layerProject({
          root: projectRoot,
          packs: {
            runtimeVersion: "1.0.0-rc.0",
            installed: [
              {
                dir: fixturesRoot,
                origin: "installed",
                manifest: { name: "installed", version: "1.0.0", flows: ["foreign"] } as never
              },
              {
                dir: fixturesRoot,
                origin: "local",
                manifest: { name: "fixtures", version: "1.0.0", flows: ["foreign"] } as never
              }
            ]
          }
        })
      ),
      Effect.provide(platform)
    ))

  it.effect("reports a name two packs both define as shadowed, naming both", () =>
    Effect.gen(function*() {
      const registry = yield* Registry.Registry
      const warnings = yield* registry.warnings()
      const shadowed = warnings.filter((warning) => warning.code === "shadowed")
      // Two packs over one directory define the same names. The `local` pack
      // wins whatever order the host listed them in, and the loser is named:
      // `duplicate_name` would say only "kept the first", which is the caller's
      // order and not the rule that actually decided.
      expect(shadowed.length).toBeGreaterThan(0)
      expect(shadowed[0]!.message).toContain("fixtures@1.0.0 (local)")
      expect(shadowed[0]!.message).toContain("installed@1.0.0 (installed)")
    }).pipe(
      Effect.provide(
        Executable.layerProject({
          root: projectRoot,
          packs: {
            runtimeVersion: "1.0.0-rc.0",
            installed: [
              {
                dir: fixturesRoot,
                origin: "installed",
                manifest: { name: "installed", version: "1.0.0", flows: ["foreign"] } as never
              },
              {
                dir: fixturesRoot,
                origin: "local",
                manifest: { name: "fixtures", version: "1.0.0", flows: ["foreign"] } as never
              }
            ]
          }
        })
      ),
      Effect.provide(platform)
    ))

  it.effect("names the pack when it declares a flows directory it does not ship", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(Effect.provide(
        Effect.void,
        Executable.layerProject({
          root: projectRoot,
          packs: {
            runtimeVersion: "1.0.0-rc.0",
            installed: [{
              dir: projectRoot,
              origin: "installed",
              manifest: { name: "broken", version: "1.0.0", flows: ["does-not-exist"] } as never
            }]
          }
        })
      ))
      // The regression this pins: the missing root used to be caught as "this
      // project has no flows", replacing the WHOLE registry with an empty one,
      // so the project's own five flows silently disappeared behind one
      // defective pack.
      expect(exit._tag).toBe("Failure")
      expect(JSON.stringify(exit)).toContain("invalid_pack")
      expect(JSON.stringify(exit)).toContain("broken@1.0.0")
    }).pipe(Effect.provide(platform)))

  it.effect("fails loudly when the project root cannot be read at all", () =>
    Effect.gen(function*() {
      const unreadable = Layer.succeed(FileSystem.FileSystem)(FileSystem.makeNoop({
        exists: () =>
          Effect.fail(
            PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "exists" })
          )
      }))
      const exit = yield* Effect.exit(Effect.provide(
        Effect.void,
        Executable.layerProject({ root: projectRoot }).pipe(Layer.provide(Layer.merge(unreadable, NodePath.layer)))
      ))
      // "I could not look" is not "there is nothing there". Reporting an
      // unreadable root as an empty project would hide every flow behind a
      // permissions mistake.
      expect(exit._tag).toBe("Failure")
      expect(JSON.stringify(exit)).toContain("read_failed")
    }))

  it.effect("keeps a pack's flows when the project has no flows directory of its own", () =>
    Effect.gen(function*() {
      const registry = yield* Registry.Registry
      const names = (yield* registry.list()).map((entry) => entry.name)
      expect(names).toContain("pdf")
    }).pipe(
      Effect.provide(
        Executable.layerProject({
          root: `${projectRoot}/absent`,
          packs: {
            runtimeVersion: "1.0.0-rc.0",
            installed: [{
              dir: fixturesRoot,
              origin: "local",
              manifest: { name: "fixtures", version: "1.0.0", flows: ["foreign"] } as never
            }]
          }
        })
      ),
      Effect.provide(platform)
    ))

  it.effect("dies on a pack source that is not a directory", () =>
    Effect.gen(function*() {
      const built = yield* Effect.exit(Effect.provide(
        Effect.void,
        Executable.layerProject({
          root: projectRoot,
          packs: {
            runtimeVersion: "1.0.0-rc.0",
            installed: [{
              dir: modulesRoot,
              origin: "local",
              manifest: { name: "broken", version: "1.0.0", flows: ["plain.mjs"] } as never
            }]
          }
        })
      ))
      expect(built._tag).toBe("Failure")
    }).pipe(Effect.provide(platform)))

  it.effect("refuses a pack this runtime is too old for", () =>
    Effect.gen(function*() {
      const registry = yield* Effect.exit(Effect.provide(
        Effect.void,
        Executable.layerProject({
          root: projectRoot,
          packs: {
            runtimeVersion: "1.0.0-rc.0",
            installed: [{
              dir: projectRoot,
              origin: "installed",
              manifest: {
                name: "future",
                version: "2.0.0",
                flows: ["flows"],
                requires: { smithers: ">=9.0.0" }
              } as never
            }]
          }
        })
      ))
      expect(registry._tag).toBe("Failure")
    }).pipe(Effect.provide(platform)))
})

describe("the delegating body", () => {
  it.effect("hands the delegate the descriptor's metadata and the caller's input", () =>
    Effect.gen(function*() {
      const descriptor = yield* descriptorNamed("greet")
      const executable = yield* Executable.fromDescriptor(descriptor, options())
      expect(executable.invocation({ name: "world" })).toEqual({
        flow: "greet",
        input: { name: "world" },
        prompt: "",
        model: null,
        placement: "local",
        capabilities: ["*"],
        flows: ["test/echo"]
      })
    }).pipe(Effect.provide(platform)))

  it.effect("defaults an absent input to null rather than to undefined", () =>
    Effect.gen(function*() {
      const descriptor = yield* descriptorNamed("greet")
      const executable = yield* Executable.fromDescriptor(descriptor, options())
      const graph = Graph.build(executable.flow, {})
      expect(Graph.diagnostics(graph)).toEqual([])
    }).pipe(Effect.provide(platform)))
})

describe("registration", () => {
  it.effect("hands the host the refusals it registered around", () =>
    Effect.gen(function*() {
      const logs: Array<string> = []
      const capture = Logger.make((entry) => void logs.push(String(entry.message)))
      const runtime = Layer.succeed(
        FlowRuntime.FlowRuntime,
        { register: () => Effect.void } as never
      )
      const built = yield* Effect.provide(
        Executable.Catalog,
        Executable.layer(options()).pipe(
          Layer.provideMerge(Layer.merge(runtime, Action.layerImplementations))
        )
      ).pipe(Effect.provide(Logger.layer([capture])))

      // Registration is where a host learns what it CANNOT run. Without this
      // the refusals were computed and thrown away, so `up orphan` reached the
      // runtime's generic unregistered-flow failure instead of the typed
      // refusal that names the missing delegate.
      expect(built.refused.map((failure) => failure.flow).sort()).toEqual(["orphan", "undecided"])
      expect(logs.filter((message) => message.includes("not runnable")).length).toBe(2)
    }).pipe(Effect.scoped, Effect.provide(registryLayer), Effect.provide(platform)))

  it.effect("registers every runnable flow with the runtime", () =>
    Effect.gen(function*() {
      const registered: Array<string> = []
      const runtime = Layer.succeed(
        FlowRuntime.FlowRuntime,
        {
          register: (flow: Flow.Any) => Effect.sync(() => void registered.push(flow._tag))
        } as never
      )
      yield* Layer.build(
        Executable.layer(options()).pipe(
          Layer.provideMerge(Layer.merge(runtime, Action.layerImplementations))
        )
      )
      expect(registered.sort()).toEqual(["changelog", "greet", "scoped", "tuned"])
    }).pipe(Effect.scoped, Effect.provide(registryLayer), Effect.provide(platform)))
})
