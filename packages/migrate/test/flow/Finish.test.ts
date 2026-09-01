/**
 * The step that decides what a unit's rewrite was worth, on its own.
 *
 * The scripted apply proves the whole graph; these prove the three things that
 * are hard to reach from the outside: an exception between the checkpoint and
 * the unit report, a postcondition a content check cannot express, and a
 * duration measured from the right moment.
 *
 * @since 0.1.0
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Checkpoint from "@smthrs/migrate/flow/Checkpoint"
import * as MigrateFlow from "@smthrs/migrate/flow/MigrateFlow"
import type * as Options from "@smthrs/migrate/flow/Options"
import type * as Transform from "@smthrs/migrate/flow/Transform"
import * as Report from "@smthrs/migrate/Report"
import * as Scan from "@smthrs/migrate/Scan"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import { TestClock } from "effect/testing"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { copyFixture, fixture, hashTree } from "../fixtures/helpers.ts"

const golden = readFileSync(
  join(fixture("jsx-single.migrated"), "flows", "simple-workflow", "flow.ts"),
  "utf8"
)

const platform = NodeServices.layer

const options = (root: string, overrides: Partial<Options.MigrateOptions> = {}): Options.MigrateOptions => ({
  root,
  mode: "apply",
  commands: { typecheck: [], test: "node -e \"process.exit(0)\"" },
  ...overrides
})

/** The real plan-time outlines of a real fixture, one per unit. */
const outlines = (
  root: string,
  chosen: Options.MigrateOptions
): Effect.Effect<ReadonlyArray<Transform.UnitOutline>, never, never> =>
  Scan.scan(root, { flowsDir: "flows" }).pipe(
    Effect.map((scanned) => MigrateFlow.outlines(scanned, chosen)),
    Effect.orDie,
    Effect.provide(platform)
  )

const outlineOf = (
  root: string,
  chosen: Options.MigrateOptions,
  id: string
): Effect.Effect<Transform.UnitOutline, never, never> =>
  Effect.map(outlines(root, chosen), (all) => all.find((outline) => outline.id === id)!)

/** A verification every command of which passed, so `finish` reaches its checks. */
const passing: Report.VerificationResult = {
  install: { command: "", exitCode: 0, durationMs: 0, stdoutTail: "", stderrTail: "", skipped: "not needed here" },
  format: { command: "", exitCode: 0, durationMs: 0, stdoutTail: "", stderrTail: "", skipped: "not needed here" },
  typecheck: [],
  tests: { command: "", exitCode: 0, durationMs: 0, stdoutTail: "", stderrTail: "", skipped: "not needed here" },
  discovery: { command: "discovery flows", exitCode: 0, durationMs: 0, stdoutTail: "", stderrTail: "" }
}

const answered = (unit: string, changedFiles: ReadonlyArray<string>) => ({
  unit,
  changedFiles,
  decisions: [],
  unresolved: [],
  unsupported: [],
  notes: ""
})

describe("MigrateFlow.postconditions", () => {
  it.effect("refuses a workflow unit that produced no flow, and accepts the one that did", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const outline = yield* outlineOf(root, options(root), "workflow:simple-workflow")

      const missing = yield* MigrateFlow.postconditions(root, outline)
      expect(missing.find((check) => check.name === "the unit wrote the flow it was planned for")?.ok).toBe(false)

      mkdirSync(join(root, "flows", "simple-workflow"), { recursive: true })
      writeFileSync(join(root, "flows", "simple-workflow", "flow.ts"), "export default 1\n")

      const written = yield* MigrateFlow.postconditions(root, outline)
      expect(written.every((check) => check.ok)).toBe(true)
    }).pipe(Effect.provide(platform)))

  it.effect("keeps 0.x packages valid through dependencies, then requires their removal in project", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const dependencies = yield* outlineOf(root, options(root), "dependencies")
      const project = yield* outlineOf(root, options(root), "project")

      const dependenciesBefore = yield* MigrateFlow.postconditions(root, dependencies)
      expect(dependenciesBefore.find((check) => check.name === "no manifest declares a 0.x package"))
        .toBeUndefined()
      expect(
        dependenciesBefore.find((check) => check.name === "effect is pinned to the version this release ships")?.ok
      )
        .toBe(false)
      const projectBefore = yield* MigrateFlow.postconditions(root, project)
      expect(projectBefore.find((check) => check.name === "no manifest declares a 0.x package")?.findings[0]?.message)
        .toContain("smthrs")

      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        dependencies: Record<string, string>
      }
      manifest.dependencies["effect"] = "4.0.0-rc.108"
      writeFileSync(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)

      const dependenciesAfter = yield* MigrateFlow.postconditions(root, dependencies)
      expect(dependenciesAfter.every((check) => check.ok)).toBe(true)

      delete manifest.dependencies["smthrs"]
      writeFileSync(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
      const projectAfter = yield* MigrateFlow.postconditions(root, project)
      expect(projectAfter.find((check) => check.name === "no manifest declares a 0.x package")?.ok).toBe(true)
    }).pipe(Effect.provide(platform)))

  it.effect("refuses a tsconfig that still configures the JSX runtime, and an ignore file without `.flows/`", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const outline = yield* outlineOf(root, options(root), "project")
      writeFileSync(join(root, ".gitignore"), "node_modules\n")

      const before = yield* MigrateFlow.postconditions(root, outline)
      const jsx = before.find((check) => check.name === "no tsconfig configures the 0.x JSX runtime")
      expect(jsx?.findings.map((finding) => finding.message)).toEqual([
        "compilerOptions.jsx still points at the 0.x JSX runtime",
        "compilerOptions.jsxImportSource still points at the 0.x JSX runtime"
      ])
      expect(before.find((check) => check.name === "the ignore file covers the 1.0 runtime state")?.ok).toBe(false)

      writeFileSync(join(root, ".gitignore"), "node_modules\n.flows/\n")
      writeFileSync(
        join(root, "tsconfig.json"),
        `${JSON.stringify({ compilerOptions: { strict: true } }, null, 2)}\n`
      )

      const after = yield* MigrateFlow.postconditions(root, outline)
      expect(after.find((check) => check.name === "no tsconfig configures the 0.x JSX runtime")?.ok).toBe(true)
      expect(after.find((check) => check.name === "the ignore file covers the 1.0 runtime state")?.ok).toBe(true)
    }).pipe(Effect.provide(platform)))
})

describe("MigrateFlow.finish", () => {
  it.effect("reports out-of-set damage even when verification failed before checks ran", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const chosen = options(root)
      const outline = yield* outlineOf(root, chosen, "workflow:simple-workflow")
      const checkpoint = yield* Checkpoint.take({
        root,
        unit: outline.id,
        files: outline.sources,
        backupDir: join(root, ".smithers-migrate", "backup"),
        allowNoVcs: true,
        treeExclude: [".smithers-migrate"]
      }).pipe(Effect.provide(platform))
      mkdirSync(join(root, "flows", "simple-workflow"), { recursive: true })
      writeFileSync(join(root, "flows", "simple-workflow", "flow.ts"), golden)
      writeFileSync(join(root, "tests", "simple-workflow.test.ts"), "changed outside the unit\n")
      mkdirSync(join(root, "scratch"), { recursive: true })
      writeFileSync(join(root, "scratch", "operator-note.md"), "created while migration ran\n")

      const outcome = yield* MigrateFlow.finish({
        options: chosen,
        outline,
        checkpoint,
        result: answered(outline.id, ["flows/simple-workflow/flow.ts"]),
        verification: {
          ...passing,
          tests: { command: "test", exitCode: 1, durationMs: 1, stdoutTail: "", stderrTail: "failed" }
        },
        repairRounds: 0
      }).pipe(Effect.provide(platform))

      expect(outcome.status).toBe("failed")
      const outside = outcome.unresolved.filter((entry) => entry.construct === "no write outside the unit's file set")
      expect(outside.map((entry) => entry.file).sort()).toEqual([
        "scratch/operator-note.md",
        "tests/simple-workflow.test.ts"
      ])
      expect(outcome.unresolved.find((entry) => entry.construct === "rollback could not restore a file")?.suggestion)
        .toContain(checkpoint.restore)
      expect(outcome.unresolved.find((entry) => entry.construct === "rollback deleted a post-checkpoint file")?.reason)
        .toContain("recovery copy")
    }).pipe(Effect.provide(platform)))

  it.effect("restores the unit when the archive cannot finish, rather than leaving a half-moved tree", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const chosen = options(root)
      const outline = yield* outlineOf(root, chosen, "workflow:simple-workflow")
      const checkpoint = yield* Checkpoint.take({
        root,
        unit: outline.id,
        files: outline.sources,
        backupDir: join(root, ".smithers-migrate", "backup"),
        allowNoVcs: true,
        treeExclude: [".smithers-migrate"]
      }).pipe(Effect.provide(platform))
      const before = hashTree(root)

      // The rewrite the unit was asked for: the committed 1.0 output, which
      // passes every deterministic check, so the archive is what fails.
      mkdirSync(join(root, "flows", "simple-workflow"), { recursive: true })
      writeFileSync(join(root, "flows", "simple-workflow", "flow.ts"), golden)
      // And the archive directory, occupied by a file, so the first copy the
      // archive tries to write cannot create its parent.
      mkdirSync(join(root, ".smithers-migrate"), { recursive: true })
      writeFileSync(join(root, ".smithers-migrate", "archive"), "in the way\n")

      const failure = yield* Effect.flip(
        MigrateFlow.finish({
          options: chosen,
          outline,
          checkpoint,
          result: answered(outline.id, ["flows/simple-workflow/flow.ts"]),
          verification: passing,
          repairRounds: 0
        }).pipe(Effect.provide(platform))
      )

      expect(failure.code).toBe("io")
      // Every source is back and the rewrite is gone: the failure left the
      // project as the checkpoint found it.
      const after = hashTree(root)
      for (const file of outline.sources) expect([file, after.get(file)]).toEqual([file, before.get(file)])
      expect(existsSync(join(root, "flows", "simple-workflow", "flow.ts"))).toBe(false)
    }))

  it.effect("measures the unit's own time, from its checkpoint", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const chosen = options(root)
      const outline = yield* outlineOf(root, chosen, "workflow:simple-workflow")
      const checkpoint = yield* Checkpoint.take({
        root,
        unit: outline.id,
        files: outline.sources,
        backupDir: join(root, ".smithers-migrate", "backup"),
        allowNoVcs: true,
        treeExclude: [".smithers-migrate"]
      }).pipe(Effect.provide(platform))

      // A run's earlier units are minutes this unit did not spend.
      yield* TestClock.adjust("7 minutes")

      const outcome = yield* MigrateFlow.finish({
        options: chosen,
        outline,
        checkpoint,
        result: null,
        verification: null,
        failure: "the agent gave up",
        repairRounds: 3
      }).pipe(Effect.provide(platform))

      expect(outcome.status).toBe("failed")
      expect(outcome.durationMs).toBe(7 * 60_000)
      expect(yield* Clock.currentTimeMillis).toBe(checkpoint.takenAt + 7 * 60_000)
    }))
})

describe("MigrateFlow.finish, after the archive has moved the tree", () => {
  /** Everything outside the tool's own directory, which is where the backup lives. */
  const project = (hashes: ReadonlyMap<string, string>): ReadonlyMap<string, string> =>
    new Map([...hashes].filter(([path]) => !path.startsWith(".smithers-migrate/")))

  it.effect("puts every archived source back when a postcondition fails after the archive", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const chosen = options(root)
      const outline = yield* outlineOf(root, chosen, "workflow:simple-workflow")
      const checkpoint = yield* Checkpoint.take({
        root,
        unit: outline.id,
        files: outline.sources,
        backupDir: join(root, ".smithers-migrate", "backup"),
        allowNoVcs: true,
        treeExclude: [".smithers-migrate"]
      }).pipe(Effect.provide(platform))
      const before = hashTree(root)

      // The agent answered without writing the flow it was planned for. Every
      // content check reads the files a unit changed, so with nothing changed
      // they all pass vacuously and the unit reaches the archive; the archive
      // moves every source aside; and the postcondition is what refuses it.
      // That is a failure *after* the tree has been moved, which is the arm no
      // restore that was computed before the archive can cover.
      const outcome = yield* MigrateFlow.finish({
        options: chosen,
        outline,
        checkpoint,
        result: answered(outline.id, []),
        verification: passing,
        repairRounds: 0
      }).pipe(Effect.provide(platform))

      expect(outcome.status).toBe("failed")
      expect(outcome.unresolved.map((entry) => entry.construct))
        .toContain("the unit wrote the flow it was planned for")
      // Byte for byte, in both directions: nothing moved, nothing rewritten,
      // and nothing left behind.
      expect(project(hashTree(root))).toEqual(project(before))
      for (const source of outline.sources) expect([source, existsSync(join(root, source))]).toEqual([source, true])
      // And the archive copies of a unit that was put back are gone with it:
      // an archive is the record of a migration that happened.
      expect([...hashTree(root).keys()].filter((path) => path.startsWith(".smithers-migrate/archive/"))).toEqual([])
    }))

  it.effect("removes the tsconfig paths key its own postcondition would refuse", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      // The verifier's repro: a project inside the old monorepo, which depends
      // on the facade by its bare directory name and maps that name in its
      // tsconfig. `Detect.isOldSpecifier` calls the key old because the
      // manifest declares the facade, so the postcondition refuses it; the
      // rewrite has to remove the same key, or the unit deterministically
      // fails a check the tool itself was supposed to satisfy.
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        dependencies: Record<string, string>
      }
      manifest.dependencies["smithers"] = "file:../../smithers"
      writeFileSync(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
      const tsconfig = {
        compilerOptions: {
          strict: true,
          jsx: "react-jsx",
          jsxImportSource: "smthrs",
          paths: {
            "smithers": ["../../smithers/index.js"],
            "smithers/*": ["../../smithers/*"],
            "@app/*": ["./src/*"]
          }
        }
      }
      writeFileSync(join(root, "tsconfig.json"), `${JSON.stringify(tsconfig, null, 2)}\n`)

      const chosen = options(root)
      const outline = yield* outlineOf(root, chosen, "project")
      expect(outline.specifiers.localFacade).toBe(true)
      const checkpoint = yield* Checkpoint.take({
        root,
        unit: outline.id,
        files: outline.sources,
        backupDir: join(root, ".smithers-migrate", "backup"),
        allowNoVcs: true,
        treeExclude: [".smithers-migrate"]
      }).pipe(Effect.provide(platform))

      const outcome = yield* MigrateFlow.finish({
        options: chosen,
        outline,
        checkpoint,
        result: answered(outline.id, []),
        verification: passing,
        repairRounds: 0
      }).pipe(Effect.provide(platform))

      expect(outcome.unresolved.map((entry) => entry.reason)).toEqual([])
      expect(outcome.status).toBe("migrated")
      const rewritten = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as {
        compilerOptions: { paths: Record<string, unknown> }
      }
      expect(rewritten.compilerOptions.paths).toEqual({ "@app/*": ["./src/*"] })
    }))
})
