import { NodeServices } from "@effect/platform-node"
import { Flow, Graph } from "@smthrs/flow"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Install from "../src/Install.ts"
import * as PackageManager from "../src/PackageManager.ts"
import * as Runtime from "../src/Runtime.ts"

const platform = { os: "linux", arch: "x64", libc: null }

/** A runtime that reports a fixed version and satisfies its own declaration. */
const runtimeService = (
  options: { readonly requirement?: string; readonly version?: string } = {}
): Runtime.Service =>
  Runtime.makeNoop("node", {
    requirement: options.requirement ?? ">=22.19.0",
    version: options.version ?? "24.9.0",
    platform
  })

const withFixture = async <A>(use: (root: string) => Promise<A>): Promise<A> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-build-install-")))
  try {
    await Fs.writeFile(NodePath.join(root, "package.json"), "{}\n", "utf8")
    await Fs.writeFile(NodePath.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8")
    return await use(root)
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
}

const installContent = async (root: string): Promise<Install.Content> => ({
  lockfile: {
    path: "pnpm-lock.yaml",
    digest: await Effect.runPromise(
      PackageManager.lockfileDigest(root, "pnpm-lock.yaml").pipe(Effect.provide(NodeServices.layer))
    )
  },
  npmrc: null
})

interface ManagerOptions {
  readonly root: string
  readonly evidence: PackageManager.Digest
  readonly requirement?: string
  readonly version?: string
  readonly storeDirectory?: string
  readonly lockfileName?: string
  readonly name?: PackageManager.Name
  readonly platformSensitive?: boolean
  readonly onFetch?: () => void
  readonly onLink?: () => void
  readonly onVersionRead?: () => void
}

const managerService = (options: ManagerOptions): PackageManager.Service => {
  const requirement = options.requirement ?? "11.21.0"
  const version = Effect.sync(() => {
    options.onVersionRead?.()
    return options.version ?? "11.21.0"
  })
  const name = options.name ?? "pnpm"
  return {
    name,
    projectRoot: options.root,
    storeDirectory: options.storeDirectory ?? `.flows/store/${name}`,
    lockfileName: options.lockfileName ?? (name === "pnpm" ? "pnpm-lock.yaml" : "bun.lock"),
    platformSensitive: options.platformSensitive ?? true,
    requirement,
    version,
    verify: Effect.flatMap(version, (measured) =>
      Runtime.satisfies(requirement, measured) === true
        ? Effect.succeed(measured)
        : Effect.fail(
          new PackageManager.PackageManagerError({
            code: "environment_mismatch",
            message: `this host runs pnpm ${measured}, and the workspace declares ${requirement}`
          })
        )),
    fetch: Effect.sync(() => {
      options.onFetch?.()
    }),
    link: Effect.sync(() => {
      options.onLink?.()
    }),
    linkManifest: Effect.succeed(options.evidence)
  }
}

const packageJsonDigest = (root: string) =>
  Effect.runPromise(PackageManager.packageJsonDigest(root).pipe(Effect.provide(NodeServices.layer)))

describe("Install", () => {
  it("keeps every absolute-root package-manager action out of the shared cache", () => {
    for (const action of [Install.FetchPnpm, Install.FetchBun]) {
      expect(Context.getUnsafe(action.annotations, Flow.EffectsDeclaration).boundaryMode).toBe("expected")
    }
  })

  it("runs one round: the declared manager selects the fetch without a handoff", () => {
    expect(Install.Install.maxRounds).toBe(1)
  })

  it("always reconciles node_modules instead of trusting a freshness marker", async () => {
    await withFixture(async (root) => {
      await Fs.mkdir(NodePath.join(root, "node_modules"))
      await Fs.writeFile(
        NodePath.join(root, "node_modules/.flows-link.json"),
        JSON.stringify({ store: "0".repeat(64), manifest: "1".repeat(64), linked: false }),
        "utf8"
      )
      let fetches = 0
      let links = 0
      const evidence = await packageJsonDigest(root)
      const service = managerService({
        root,
        evidence,
        onFetch: () => {
          fetches += 1
        },
        onLink: () => {
          links += 1
        }
      })
      const content = await installContent(root)
      const store = await Effect.runPromise(
        PackageManager.storeManifest({
          manager: "pnpm",
          managerVersion: "11.21.0",
          platform,
          lockfileDigest: content.lockfile.digest,
          npmrcDigest: null
        }).pipe(Effect.provide(NodeServices.layer))
      )

      const link = () =>
        Install.executeLink({ content, store }).pipe(
          Effect.provide(NodeServices.layer),
          Effect.provideService(PackageManager.PackageManager, service),
          Effect.provideService(Runtime.Runtime, runtimeService())
        )
      await Effect.runPromise(link())
      await Effect.runPromise(link())
      expect(fetches).toBe(0)
      expect(links).toBe(2)
    })
  })

  it("refuses a host manager that does not satisfy the declared version", async () => {
    await withFixture(async (root) => {
      let fetched = false
      const evidence = await packageJsonDigest(root)
      const service = managerService({
        root,
        evidence,
        requirement: "11.21.0",
        version: "10.11.0",
        onFetch: () => {
          fetched = true
        }
      })
      const content = await installContent(root)

      await expect(Effect.runPromise(
        Install.executeFetch({ content }).pipe(
          Effect.provide(NodeServices.layer),
          Effect.provideService(PackageManager.PackageManager, service),
          Effect.provideService(Runtime.Runtime, runtimeService())
        )
      )).rejects.toThrow(/this host runs pnpm 10\.11\.0, and the workspace declares 11\.21\.0/)
      expect(fetched).toBe(false)
    })
  })

  it("refuses a host runtime that does not satisfy the declared version", async () => {
    await withFixture(async (root) => {
      let fetched = false
      const evidence = await packageJsonDigest(root)
      const service = managerService({
        root,
        evidence,
        onFetch: () => {
          fetched = true
        }
      })
      const content = await installContent(root)

      await expect(Effect.runPromise(
        Install.executeFetch({ content }).pipe(
          Effect.provide(NodeServices.layer),
          Effect.provideService(PackageManager.PackageManager, service),
          Effect.provideService(Runtime.Runtime, runtimeService({ requirement: ">=24.0.0", version: "22.19.0" }))
        )
      )).rejects.toThrow(/this host runs node 22\.19\.0, and the workspace declares >=24\.0\.0/)
      expect(fetched).toBe(false)
    })
  })

  it("refuses a manager whose paths disagree with the declared Flow boundary", async () => {
    await withFixture(async (root) => {
      let versionRead = false
      let fetched = false
      const service = managerService({
        root,
        evidence: "0".repeat(64) as PackageManager.Digest,
        storeDirectory: ".flows/store/elsewhere",
        lockfileName: "nested/pnpm-lock.yaml",
        onVersionRead: () => {
          versionRead = true
        },
        onFetch: () => {
          fetched = true
        }
      })
      const content = await installContent(root)

      await expect(Effect.runPromise(
        Install.executeFetch({ content }).pipe(
          Effect.provide(NodeServices.layer),
          Effect.provideService(PackageManager.PackageManager, service),
          Effect.provideService(Runtime.Runtime, runtimeService())
        )
      )).rejects.toThrow(/install Flow boundary requires/)
      expect(versionRead).toBe(false)
      expect(fetched).toBe(false)
    })
  })

  it("refuses a store fetched by a different manager version", async () => {
    await withFixture(async (root) => {
      const evidence = await packageJsonDigest(root)
      const service = managerService({ root, evidence })
      const content = await installContent(root)
      const store = await Effect.runPromise(
        PackageManager.storeManifest({
          manager: "pnpm",
          managerVersion: "10.0.0",
          platform,
          lockfileDigest: content.lockfile.digest,
          npmrcDigest: null
        }).pipe(Effect.provide(NodeServices.layer))
      )

      await expect(Effect.runPromise(
        Install.executeLink({ content, store }).pipe(
          Effect.provide(NodeServices.layer),
          Effect.provideService(PackageManager.PackageManager, service),
          Effect.provideService(Runtime.Runtime, runtimeService())
        )
      )).rejects.toThrow(/fetched store does not match this host/)
    })
  })

  it("measures content only: two digests, no manager version and no platform", async () => {
    await withFixture(async (root) => {
      const evidence = await packageJsonDigest(root)
      const service = managerService({ root, evidence })
      const measured = await Effect.runPromise(
        Install.executeMeasure().pipe(
          Effect.provide(NodeServices.layer),
          Effect.provideService(PackageManager.PackageManager, service)
        )
      )
      expect(Object.keys(measured).sort()).toEqual(["lockfile", "npmrc"])
      expect(measured.lockfile.path).toBe("pnpm-lock.yaml")
      expect(measured.lockfile.digest).toMatch(/^[0-9a-f]{64}$/)
      expect(measured.npmrc).toBe(null)
    })
  })

  it("reports the .npmrc alongside the lockfile when a project has one", async () => {
    await withFixture(async (root) => {
      await Fs.writeFile(NodePath.join(root, ".npmrc"), "registry=https://registry.example/\n", "utf8")
      const evidence = await packageJsonDigest(root)
      const measured = await Effect.runPromise(
        Install.executeMeasure().pipe(
          Effect.provide(NodeServices.layer),
          Effect.provideService(PackageManager.PackageManager, managerService({ root, evidence }))
        )
      )
      expect(measured.npmrc?.path).toBe(".npmrc")
      expect(measured.npmrc?.digest).toMatch(/^[0-9a-f]{64}$/)
    })
  })

  it("refuses to measure through a layer whose paths disagree with the Flow boundary", async () => {
    await withFixture(async (root) => {
      const evidence = await packageJsonDigest(root)
      const error = await Effect.runPromise(
        Install.executeMeasure().pipe(
          Effect.flip,
          Effect.provide(NodeServices.layer),
          Effect.provideService(
            PackageManager.PackageManager,
            managerService({ root, evidence, lockfileName: "nested/pnpm-lock.yaml" })
          )
        )
      )
      expect(error.code).toBe("environment_mismatch")
      expect(error.message).toMatch(/install Flow boundary requires/)
    })
  })

  /**
   * `content` is in Link's payload because it is key material the
   * implementation is supposed to honour, and the implementation destructured
   * only `store`. A manifest fetched from another lockfile on the same host
   * passed every check and produced a LinkManifest attesting to content the
   * tree was never built from.
   */
  it("refuses a store fetched for a different lockfile or a different .npmrc", async () => {
    await withFixture(async (root) => {
      const evidence = await packageJsonDigest(root)
      const service = managerService({ root, evidence })
      const content = await installContent(root)
      const foreign = async (overrides: {
        readonly lockfileDigest?: string
        readonly npmrcDigest?: string | null
      }) =>
        Effect.runPromise(
          PackageManager.storeManifest({
            manager: "pnpm",
            managerVersion: "11.21.0",
            platform,
            lockfileDigest: overrides.lockfileDigest ?? content.lockfile.digest,
            npmrcDigest: overrides.npmrcDigest ?? null
          }).pipe(Effect.provide(NodeServices.layer))
        )

      for (
        const store of [
          await foreign({ lockfileDigest: "f".repeat(64) }),
          await foreign({ npmrcDigest: "e".repeat(64) })
        ]
      ) {
        const error = await Effect.runPromise(
          Install.executeLink({ content, store }).pipe(
            Effect.flip,
            Effect.provide(NodeServices.layer),
            Effect.provideService(PackageManager.PackageManager, service),
            Effect.provideService(Runtime.Runtime, runtimeService())
          )
        )
        expect(error.code).toBe("environment_mismatch")
        expect(error.message).toMatch(/this project's measured content is/)
      }
    })
  })

  /**
   * A manager whose fetch does not vary by platform drops the platform out of
   * its key material, so the store manifest it reports carries `null` there and
   * the digest differs from the platform-sensitive one for the same content.
   */
  it("keeps the platform out of a platform-independent manager's store manifest", async () => {
    await withFixture(async (root) => {
      await Fs.writeFile(NodePath.join(root, ".npmrc"), "registry=https://registry.example/\n", "utf8")
      const evidence = await packageJsonDigest(root)
      const content = await Effect.runPromise(
        Install.executeMeasure().pipe(
          Effect.provide(NodeServices.layer),
          Effect.provideService(PackageManager.PackageManager, managerService({ root, evidence }))
        )
      )
      expect(content.npmrc).not.toBe(null)

      const fetched = (platformSensitive: boolean) =>
        Effect.runPromise(
          Install.executeFetch({ content }).pipe(
            Effect.provide(NodeServices.layer),
            Effect.provideService(
              PackageManager.PackageManager,
              managerService({ root, evidence, platformSensitive })
            ),
            Effect.provideService(Runtime.Runtime, runtimeService())
          )
        )
      const independent = await fetched(false)
      const sensitive = await fetched(true)
      expect(independent.platform).toBe(null)
      expect(sensitive.platform).toEqual(platform)
      expect(independent.digest).not.toBe(sensitive.digest)
    })
  })

  it("refuses a layer whose manager name is outside the declared union", async () => {
    await withFixture(async (root) => {
      const evidence = await packageJsonDigest(root)
      const service = {
        ...managerService({ root, evidence }),
        name: "npm" as PackageManager.Name
      }
      const error = await Effect.runPromise(
        Install.executeMeasure().pipe(
          Effect.flip,
          Effect.provide(NodeServices.layer),
          Effect.provideService(PackageManager.PackageManager, service)
        )
      )
      expect(error.code).toBe("environment_mismatch")
      expect(error.message).toMatch(/declares an unknown manager/)
    })
  })

  /**
   * The manager is a plan-time declaration, so one round records measure,
   * exactly one fetch, and link. This is the assertion that the declared
   * manager reaches the recorded boundary: the fetch node names that manager's
   * lockfile and that manager's store directory, and nothing else changes.
   */
  it("records measure, one manager-specific fetch, and link in one round", () => {
    for (
      const [manager, lockfile] of [["pnpm", "pnpm-lock.yaml"], ["bun", "bun.lock"]] as const
    ) {
      const graph = Graph.build(Install.Install, { manager })
      const actions = graph.nodes.filter((node) => node.kind === "ActionCall")
      expect(actions).toHaveLength(3)
      const [measure, fetch, link] = actions
      expect(measure!.draft.effects.reads).toEqual([".npmrc", "bun.lock", "pnpm-lock.yaml"])
      expect(fetch!.draft.effects.reads).toEqual([lockfile, ".npmrc"])
      expect(fetch!.draft.effects.writes).toEqual([
        { _tag: "TreeArtifact", path: `.flows/store/${manager}` }
      ])
      expect(link!.draft.effects.reads).toEqual(["package.json"])
      for (const action of actions) expect(action.draft.effects.boundaryMode).toBe("expected")
    }
  })

  /**
   * Measure's payload was empty, so a pnpm install and a Bun install of one
   * workspace recorded the same measure key: `Graph.build` folds a call's
   * literal payload into the node's key material, and an empty payload folds
   * nothing. The `expected` boundary keeps that inert today and a `hard` one
   * would turn it into a hit on the other manager's measurement.
   */
  it("keys measure on the declared manager so two managers cannot share one measurement", () => {
    const measureOf = (manager: PackageManager.Name) => {
      const graph = Graph.build(Install.Install, { manager })
      const node = graph.nodes.filter((node) => node.kind === "ActionCall")[0]!
      expect(node.draft.material.body).toMatchObject({ action: "smithers-build/install/measure" })
      return node.draft.material.inputs
    }
    expect(measureOf("pnpm")).toEqual([{ _tag: "Literal", value: { manager: "pnpm" } }])
    expect(measureOf("bun")).toEqual([{ _tag: "Literal", value: { manager: "bun" } }])
    expect(measureOf("pnpm")).not.toEqual(measureOf("bun"))
  })
})
