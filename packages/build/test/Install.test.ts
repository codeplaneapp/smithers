import { NodeServices } from "@effect/platform-node"
import { Flow } from "@smthrs/flow"
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
  return {
    name: "pnpm",
    projectRoot: options.root,
    storeDirectory: options.storeDirectory ?? ".flows/store/pnpm",
    lockfileName: options.lockfileName ?? "pnpm-lock.yaml",
    platformSensitive: true,
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
      const first = await Effect.runPromise(link())
      const second = await Effect.runPromise(link())
      expect(first.linked).toBe(true)
      expect(second.linked).toBe(true)
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
        Effect.gen(function*() {
          const manager = yield* PackageManager.PackageManager
          const lockfile = yield* PackageManager.lockfileDigest(manager.projectRoot, manager.lockfileName)
          const npmrc = yield* PackageManager.npmrcDigest(manager.projectRoot)
          return {
            lockfile: { path: manager.lockfileName, digest: lockfile },
            npmrc: npmrc === null ? null : { path: ".npmrc", digest: npmrc }
          }
        }).pipe(
          Effect.provide(NodeServices.layer),
          Effect.provideService(PackageManager.PackageManager, service)
        )
      )
      expect(Object.keys(measured).sort()).toEqual(["lockfile", "npmrc"])
      expect(measured.npmrc).toBe(null)
    })
  })
})
