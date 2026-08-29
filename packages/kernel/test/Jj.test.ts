import { describe, expect, it } from "@effect/vitest"
import * as Capability from "@smthrs/capability/Capability"
import { permissionDenied } from "@smthrs/capability/Permission"
import * as HostJj from "@smthrs/jj"
import { Effect, FileSystem as EffectFileSystem, Path } from "effect"
import { GrantStore } from "../src/GrantStore.ts"
import * as Jj from "../src/Jj.ts"
import * as Workspace from "../src/Workspace.ts"

const itEffect = (name: string, effect: () => Effect.Effect<void, unknown, never>) => it.effect(name, () => effect())

const scriptedStore = (checks: Array<Capability.Capability>) =>
  GrantStore.of({
    check: (capability) => {
      checks.push(capability)
      return Effect.void
    },
    reply: () => Effect.die("not used by decorator tests"),
    list: Effect.succeed([]),
    grantEnvelope: () => Effect.void
  })

const fileSystem = EffectFileSystem.makeNoop({
  realPath: (path) => Effect.succeed(path)
})

describe("Jj", () => {
  itEffect("checks every host operation before delegating it", () => {
    const calls: Array<string> = []
    const checks: Array<Capability.Capability> = []
    const host = HostJj.makeNoop({
      status: () =>
        Effect.sync(() => {
          calls.push("status")
          return "status"
        }),
      diff: () =>
        Effect.sync(() => {
          calls.push("diff")
          return "diff"
        }),
      snapshot: () =>
        Effect.sync(() => {
          calls.push("snapshot")
          return { changeId: "change" }
        }),
      restore: () =>
        Effect.sync(() => {
          calls.push("restore")
        }),
      workspaceAdd: () =>
        Effect.sync(() => {
          calls.push("workspaceAdd")
        }),
      workspaceForget: () =>
        Effect.sync(() => {
          calls.push("workspaceForget")
        })
    })

    return Effect.gen(function*() {
      const jj = yield* Jj.Jj
      expect(yield* jj.status()).toBe("status")
      expect(yield* jj.diff("from", "to")).toBe("diff")
      expect(yield* jj.snapshot("message")).toEqual({ changeId: "change" })
      yield* jj.restore("change")
      yield* jj.workspaceAdd("lane", "/work/lane")
      yield* jj.workspaceForget("lane")
      expect(calls).toEqual(["status", "diff", "snapshot", "restore", "workspaceAdd", "workspaceForget"])
      expect(checks).toEqual([
        { action: "jj:status", resource: "." },
        { action: "jj:diff", resource: "from:to" },
        { action: "jj:snapshot", resource: "message" },
        { action: "jj:restore", resource: "change" },
        { action: "jj:workspace-add", resource: "/work/lane" },
        { action: "fs:write", resource: "/work/lane" },
        { action: "jj:workspace-forget", resource: "lane" }
      ])
    }).pipe(
      Effect.provide(Jj.layer),
      Effect.provideService(HostJj.Jj, host),
      Effect.provideService(EffectFileSystem.FileSystem, fileSystem),
      Effect.provide(Path.layer),
      Effect.provide(Workspace.layer("/workspace")),
      Effect.provideService(GrantStore, scriptedStore(checks))
    )
  })

  itEffect("does not delegate when a Jj capability is denied", () => {
    let invoked = false
    const checks: Array<Capability.Capability> = []
    const store = GrantStore.of({
      check: (capability) => {
        checks.push(capability)
        return Effect.fail(permissionDenied(capability, "denied by test"))
      },
      reply: () => Effect.die("not used by decorator tests"),
      list: Effect.succeed([]),
      grantEnvelope: () => Effect.void
    })
    const host = HostJj.makeNoop({
      status: () =>
        Effect.sync(() => {
          invoked = true
          return "status"
        })
    })

    return Effect.gen(function*() {
      const jj = yield* Jj.Jj
      expect(yield* Effect.flip(jj.status())).toMatchObject({
        code: "permission_denied",
        capability: { action: "jj:status", resource: "." },
        reason: "denied by test"
      })
      expect(invoked).toBe(false)
      expect(checks).toEqual([{ action: "jj:status", resource: "." }])
    }).pipe(
      Effect.provide(Jj.layer),
      Effect.provideService(HostJj.Jj, host),
      Effect.provideService(EffectFileSystem.FileSystem, fileSystem),
      Effect.provide(Path.layer),
      Effect.provide(Workspace.layer("/workspace")),
      Effect.provideService(GrantStore, store)
    )
  })
})
