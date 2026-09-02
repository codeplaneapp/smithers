/**
 * The grant rules a migration runs under, asked of a real kernel grant store.
 *
 * The rules are the only place the tool's two promises about run state are
 * *enforced* rather than asserted, so they are tested by asking the store the
 * same questions the kernel asks it: may this write land, and may this command
 * run. The store is unattended, which is what a migration is, so anything the
 * rules do not name is refused rather than queued for a person.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import { Capability, GrantStore, Workspace } from "@smthrs/kernel"
import * as Command from "@smthrs/migrate/flow/Command"
import type * as Contract from "@smthrs/migrate/flow/Contract"
import * as Layers from "@smthrs/migrate/flow/Layers"
import * as Scan from "@smthrs/migrate/Scan"
import * as Units from "@smthrs/migrate/Units"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { copyFixture, nodeLayer } from "../fixtures/helpers.ts"

const root = "/tmp/project"

const commands: Contract.Commands = {
  install: "pnpm install --frozen-lockfile",
  format: "dprint fmt",
  typecheck: ["tsc --noEmit -p tsconfig.json", "tsc --noEmit -p test/tsconfig.json"],
  test: "vitest run",
  flowsDir: "flows"
}

const runStatePaths = [
  ".smithers/claude-mirror-subscriptions.json",
  ".smithers/executions",
  ".smithers/smithers.db"
]

const store = GrantStore.layer({
  attended: false,
  rules: Layers.rules({ root, runStatePaths, commands })
}).pipe(Layer.provide(Workspace.layer(root)), Layer.orDie)

/** Whether the store lets one capability through. */
const permitted = (action: Capability.Action, resource: string): Effect.Effect<boolean> =>
  Effect.gen(function*() {
    const grants = yield* GrantStore.GrantStore
    return yield* grants.check(Capability.make(action, resource)).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false))
    )
  }).pipe(Effect.provide(store))

describe("Layers.verificationCommands", () => {
  it("is every command a verification runs, once each", () => {
    expect(Layers.verificationCommands(commands)).toEqual([
      "pnpm install --frozen-lockfile",
      "dprint fmt",
      "tsc --noEmit -p tsconfig.json",
      "tsc --noEmit -p test/tsconfig.json",
      "vitest run"
    ])
  })

  it("omits what the project does not configure", () => {
    expect(Layers.verificationCommands({ typecheck: [], flowsDir: "flows" })).toEqual([])
  })

  it("keeps one grant for a command that is both the typecheck and the test", () => {
    expect(
      Layers.verificationCommands({ typecheck: ["bun run check"], test: "bun run check", flowsDir: "flows" })
    ).toEqual(["bun run check"])
  })
})

describe("Layers.commandsFor over a real project", () => {
  it.effect("reads the project's own commands when the operator names none", () =>
    Effect.gen(function*() {
      const project = copyFixture("jsx-single")
      const scanned = yield* Scan.scan(project)

      const derived = Layers.commandsFor(scanned.detection, {}, "flows")

      expect(derived.flowsDir).toBe("flows")
      expect(derived.typecheck.length).toBeGreaterThan(0)
      expect(derived.test).toEqual(Units.argv("npm", "run", "test"))
      // What the host grants is the rendered line of the same argv.
      expect(Layers.verificationCommands(derived)).toContain("npm run test")
    }).pipe(Effect.provide(nodeLayer)))

  it.effect("takes the operator's overrides, so the host permits what the brief lists", () =>
    Effect.gen(function*() {
      const project = copyFixture("jsx-single")
      const scanned = yield* Scan.scan(project)

      // The same overrides the live and scripted runs pass. Before these
      // reached the host, the grant rules and the agent's own `migrate/verify`
      // were built from the manifest's commands while every unit was verified
      // with the operator's, so the agent was shown one command and permitted
      // another.
      const derived = Layers.commandsFor(
        scanned.detection,
        { typecheck: [], test: "node -e \"process.exit(0)\"" },
        "flows"
      )

      expect(derived.typecheck).toEqual([])
      expect(derived.test).toBe("node -e \"process.exit(0)\"")
      expect(Layers.verificationCommands(derived)).toContain("node -e \"process.exit(0)\"")
    }).pipe(Effect.provide(nodeLayer)))
})

describe("Layers.rules over a real grant store", () => {
  it("refuses a relative root before constructing grant rules", () => {
    expect(() => Layers.rules({ root: "../project", runStatePaths, commands }))
      .toThrow(/migration root.*absolute.*\.\.\/project/i)
  })

  it.effect("refuses a relative root in the package's own error channel when a host is composed", () =>
    Effect.gen(function*() {
      // A library caller with a relative path gets a `MigrateError` an entry
      // point can map to an exit status, not a defect from inside a layer.
      for (
        const layer of [
          Layers.layerNode({ root: "relative/project", commands, runStatePaths }),
          Layers.layerNodeScanned({ root: "relative/project" })
        ]
      ) {
        const failure = yield* Effect.flip(Effect.scoped(Layer.build(layer)))
        expect(Command.isMigrateError(failure)).toBe(true)
        if (Command.isMigrateError(failure)) {
          expect(failure.code).toBe("unsupported-project")
          expect(failure.message).toContain("relative/project")
        }
      }
    }))

  it.effect("lets a unit write inside the project", () =>
    Effect.gen(function*() {
      expect(yield* permitted("fs:write", `${root}/flows/simple/flow.ts`)).toBe(true)
      expect(yield* permitted("fs:read", `${root}/simple-workflow.jsx`)).toBe(true)
    }))

  it.effect("lets a unit write the project root itself, which is a file's parent", () =>
    Effect.gen(function*() {
      // `write` creates the parent directory of its target before writing it,
      // and the parent of `package.json` is the root. A rule set that granted
      // only `<root>/**` let the agent write `flows/x/flow.ts` and refused
      // `package.json`, which is the one file the dependencies unit exists to
      // rewrite. The refusal reached the model as "Could not write
      // package.json", with nothing to say it was a permission.
      expect(yield* permitted("fs:write", root)).toBe(true)
      expect(yield* permitted("fs:write", `${root}/package.json`)).toBe(true)
    }))

  it.effect("refuses a write to the project's 0.x run state", () =>
    Effect.gen(function*() {
      expect(yield* permitted("fs:write", `${root}/.smithers/smithers.db`)).toBe(false)
      expect(yield* permitted("fs:write", `${root}/.smithers/executions/run-1/stdout.log`)).toBe(false)
      expect(yield* permitted("fs:write", `${root}/.smithers/claude-mirror-subscriptions.json`)).toBe(false)
    }))

  it.effect("refuses to read, list, or stat run state too, because a read is a copy into the model", () =>
    Effect.gen(function*() {
      // The contract says "do not read", and a sentence is not an enforcement.
      // Every filesystem action on the exact path and on everything under it
      // is vetoed, and the veto is configured, so no envelope lifts it.
      expect(yield* permitted("fs:read", `${root}/.smithers/smithers.db`)).toBe(false)
      expect(yield* permitted("fs:read", `${root}/.smithers/executions`)).toBe(false)
      expect(yield* permitted("fs:read", `${root}/.smithers/executions/run-1/stdout.log`)).toBe(false)
      expect(yield* permitted("fs:read", `${root}/.smithers/claude-mirror-subscriptions.json`)).toBe(false)
      // The sibling that is source, not state, stays readable and writable.
      expect(yield* permitted("fs:read", `${root}/.smithers/workflows/review.tsx`)).toBe(true)
      expect(yield* permitted("fs:write", `${root}/.smithers/workflows/review.tsx`)).toBe(true)
      expect(yield* permitted("fs:read", `${root}/.smithers`)).toBe(true)
    }))

  it.effect("refuses a write outside the project entirely", () =>
    Effect.gen(function*() {
      expect(yield* permitted("fs:write", "/etc/hosts")).toBe(false)
    }))

  it.effect("permits exactly the project's own verification commands", () =>
    Effect.gen(function*() {
      for (const command of Layers.verificationCommands(commands)) {
        expect([command, yield* permitted("proc:spawn", command)]).toEqual([command, true])
      }
    }))

  it.effect("refuses every other command, including the ones that would reach run state anyway", () =>
    Effect.gen(function*() {
      // A spawned process writes at the OS level, where no `fs:write` rule can
      // see it. Confining the spawn is the only place that can be stopped.
      expect(yield* permitted("proc:spawn", `sqlite3 ${root}/.smithers/smithers.db "delete from _smithers_runs"`))
        .toBe(false)
      expect(yield* permitted("proc:spawn", `rm -rf ${root}/.smithers`)).toBe(false)
      expect(yield* permitted("proc:spawn", "bash -lc 'pnpm install --frozen-lockfile'")).toBe(false)
      expect(yield* permitted("proc:spawn", "pnpm install")).toBe(false)
      expect(yield* permitted("proc:spawn", "git push")).toBe(false)
    }))

  it.effect("refuses every command when the project configures none", () =>
    Effect.gen(function*() {
      const grants = yield* GrantStore.GrantStore
      const allowed = yield* grants.check(Capability.make("proc:spawn", "pnpm install --frozen-lockfile")).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false))
      )
      expect(allowed).toBe(false)
    }).pipe(Effect.provide(
      GrantStore.layer({
        attended: false,
        rules: Layers.rules({ root, runStatePaths, commands: { typecheck: [], flowsDir: "flows" } })
      }).pipe(Layer.provide(Workspace.layer(root)), Layer.orDie)
    )))
})
