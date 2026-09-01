/**
 * The checkpoint, against real repositories.
 *
 * Every case here builds a real temporary git repository (and a real jj one
 * where `jj` is on PATH) and runs the real binaries: a checkpoint that only
 * works against a mocked spawner proves nothing about the working copy it is
 * supposed to protect.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Checkpoint from "@smthrs/migrate/flow/Checkpoint"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const platform = NodeServices.layer

const has = (binary: string): boolean => {
  try {
    execFileSync(binary, ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const jjAvailable = has("jj")

const temporaries: Array<string> = []
const scratch = (name: string): string => {
  const target = mkdtempSync(join(tmpdir(), `migrate-checkpoint-${name}-`))
  temporaries.push(target)
  return target
}
process.on("exit", () => {
  for (const target of temporaries) rmSync(target, { recursive: true, force: true })
})

const write = (root: string, file: string, text: string): void => {
  mkdirSync(join(root, file, "..").replace(/\/\.\.$/, ""), { recursive: true })
  writeFileSync(join(root, file), text)
}

const gitProject = (name: string): string => {
  const root = scratch(name)
  const git = (...args: Array<string>) => execFileSync("git", args, { cwd: root, stdio: "ignore" })
  git("init", "-q")
  git("config", "user.email", "lane@local")
  git("config", "user.name", "lane")
  git("config", "commit.gpgsign", "false")
  write(root, "workflow.jsx", "old workflow\n")
  write(root, "README.md", "committed readme\n")
  git("add", "-A")
  git("commit", "-q", "-m", "baseline")
  return root
}

const payload = (root: string, files: ReadonlyArray<string>, allowNoVcs = false) => ({
  root,
  unit: "workflow:demo",
  files,
  backupDir: join(root, ".smithers-migrate", "backup"),
  allowNoVcs
})

describe("Checkpoint.detectVcs", () => {
  it.effect("reports none for a plain directory and git for a repository", () =>
    Effect.gen(function*() {
      expect(yield* Checkpoint.detectVcs(scratch("plain"))).toBe("none")
      expect(yield* Checkpoint.detectVcs(gitProject("detect"))).toBe("git")
    }).pipe(Effect.provide(platform)))
})

describe("Checkpoint.take on git", () => {
  it.effect("leaves a recovery instruction before any transform can start", () =>
    Effect.gen(function*() {
      const root = gitProject("pending")

      const ref = yield* Checkpoint.take(payload(root, ["workflow.jsx"]))
      write(root, "workflow.jsx", "half migrated\n")

      const marker = join(root, ".smithers-migrate", "pending-unit.json")
      const pending = JSON.parse(readFileSync(marker, "utf8")) as {
        unit: string
        root: string
        checkpoint: { ref: string; restore: string }
        instruction: string
      }
      expect(pending.unit).toBe("workflow:demo")
      expect(pending.root).toBe(root)
      expect(pending.checkpoint).toMatchObject({ ref: ref.ref, restore: ref.restore })
      expect(pending.instruction).toContain(ref.restore)
    }).pipe(Effect.provide(platform)))

  it.effect("writes a ref, leaves the working tree alone, and survives an unrelated dirty file", () =>
    Effect.gen(function*() {
      const root = gitProject("ref")
      // Work nobody asked the migration to touch, uncommitted on purpose.
      write(root, "unrelated.txt", "the operator's own edit\n")
      write(root, "README.md", "edited readme\n")

      const ref = yield* Checkpoint.take(payload(root, ["workflow.jsx"]))

      expect(ref.vcs).toBe("git")
      expect(ref.ref).toMatch(/^refs\/smithers-migrate\/workflow-demo\/\d+$/)
      expect(ref.restore).toBe(`git checkout ${ref.ref} -- .`)
      expect(ref.files).toEqual(["workflow.jsx"])
      // The ref exists and the working tree still holds both dirty files.
      expect(execFileSync("git", ["rev-parse", "--verify", ref.ref], { cwd: root }).toString().trim()).toHaveLength(40)
      expect(readFileSync(join(root, "unrelated.txt"), "utf8")).toBe("the operator's own edit\n")
      expect(readFileSync(join(root, "README.md"), "utf8")).toBe("edited readme\n")
      expect(readFileSync(join(root, "workflow.jsx"), "utf8")).toBe("old workflow\n")
      // `git stash list` is never disturbed: this is a ref, not a stash entry.
      expect(execFileSync("git", ["stash", "list"], { cwd: root }).toString()).toBe("")
    }).pipe(Effect.provide(platform)))

  it.effect("diffs only the paths the unit touched, and restores only those", () =>
    Effect.gen(function*() {
      const root = gitProject("diff")
      write(root, "unrelated.txt", "operator work\n")
      const ref = yield* Checkpoint.take(payload(root, ["workflow.jsx"]))

      write(root, "workflow.jsx", "migrated workflow\n")
      write(root, "flows/demo/flow.ts", "export default 1\n")
      write(root, "unrelated.txt", "operator work, edited again\n")

      const changes = yield* Checkpoint.diff(root, ref, ["workflow.jsx", "flows/demo/flow.ts"])
      expect(changes).toEqual([
        { path: "flows/demo/flow.ts", change: "added", bytes: 17 },
        { path: "workflow.jsx", change: "modified", bytes: 18 }
      ])

      const restored = yield* Checkpoint.restore(root, ref, ["workflow.jsx", "flows/demo/flow.ts"])
      expect(restored).toEqual(["flows/demo/flow.ts", "workflow.jsx"])
      expect(readFileSync(join(root, "workflow.jsx"), "utf8")).toBe("old workflow\n")
      expect(() => readFileSync(join(root, "flows/demo/flow.ts"), "utf8")).toThrow()
      // The dirty file the unit never claimed is untouched by the restore.
      expect(readFileSync(join(root, "unrelated.txt"), "utf8")).toBe("operator work, edited again\n")
    }).pipe(Effect.provide(platform)))

  it.effect("reports a deleted file and hands the checks the recorded sources", () =>
    Effect.gen(function*() {
      const root = gitProject("deleted")
      const ref = yield* Checkpoint.take(payload(root, ["workflow.jsx"]))
      rmSync(join(root, "workflow.jsx"))

      expect(yield* Checkpoint.diff(root, ref, ["workflow.jsx"])).toEqual([
        { path: "workflow.jsx", change: "deleted", bytes: 0 }
      ])
      const sources = yield* Checkpoint.sources(ref)
      expect(sources.get("workflow.jsx")).toBe("old workflow\n")
    }).pipe(Effect.provide(platform)))
})

describe("Checkpoint.take with no version control", () => {
  it.effect("refuses, naming --allow-no-vcs", () =>
    Effect.gen(function*() {
      const root = scratch("novcs")
      write(root, "workflow.jsx", "old workflow\n")

      const failure = yield* Effect.flip(Checkpoint.take(payload(root, ["workflow.jsx"])))

      expect(failure.code).toBe("no-vcs")
      expect(failure.message).toContain("--allow-no-vcs")
    }).pipe(Effect.provide(platform)))

  it.effect("accepts the file copy as the checkpoint once the operator allows it", () =>
    Effect.gen(function*() {
      const root = scratch("novcs-allowed")
      write(root, "workflow.jsx", "old workflow\n")

      const ref = yield* Checkpoint.take(payload(root, ["workflow.jsx"], true))
      expect(ref.vcs).toBe("none")
      expect(ref.files).toEqual(["workflow.jsx"])

      write(root, "workflow.jsx", "migrated\n")
      yield* Checkpoint.restore(root, ref, ["workflow.jsx"])
      expect(readFileSync(join(root, "workflow.jsx"), "utf8")).toBe("old workflow\n")
    }).pipe(Effect.provide(platform)))
})

describe("Checkpoint.take on jj", () => {
  it.effect.skipIf(!jjAvailable)(
    "records the working-copy change and opens a new one for the migration",
    () =>
      Effect.gen(function*() {
        const root = scratch("jj")
        execFileSync("jj", ["git", "init"], { cwd: root, stdio: "ignore" })
        write(root, "workflow.jsx", "old workflow\n")
        write(root, "unrelated.txt", "operator work\n")
        const before = execFileSync("jj", ["log", "-r", "@", "--no-graph", "-T", "change_id"], { cwd: root })
          .toString().trim()

        const ref = yield* Checkpoint.take(payload(root, ["workflow.jsx"]))

        expect(ref.vcs).toBe("jj")
        expect(ref.ref).toBe(before)
        expect(ref.restore).toBe(`jj restore --from ${before}`)
        // The migration works in a new change, so the operator's edits stay in
        // the change they were made in.
        const now = execFileSync("jj", ["log", "-r", "@", "--no-graph", "-T", "change_id"], { cwd: root })
          .toString().trim()
        expect(now).not.toBe(before)
        expect(readFileSync(join(root, "unrelated.txt"), "utf8")).toBe("operator work\n")

        write(root, "workflow.jsx", "migrated\n")
        yield* Checkpoint.restore(root, ref, ["workflow.jsx"])
        expect(readFileSync(join(root, "workflow.jsx"), "utf8")).toBe("old workflow\n")
        expect(readFileSync(join(root, "unrelated.txt"), "utf8")).toBe("operator work\n")
      }).pipe(Effect.provide(platform))
  )

  it.skipIf(jjAvailable)("is skipped because `jj` is not on PATH", () => {
    expect(jjAvailable).toBe(false)
  })
})

describe("Checkpoint.tree", () => {
  it.effect("digests the project, and finds every change afterwards including the ones nobody declared", () =>
    Effect.gen(function*() {
      const root = gitProject("tree")
      write(root, "src/app.ts", "export const a = 1\n")
      write(root, "node_modules/left/index.js", "module.exports = 1\n")
      const ref = yield* Checkpoint.take({
        ...payload(root, ["workflow.jsx"]),
        treeExclude: [".smithers-migrate"]
      })

      // One declared edit, one file nobody declared, one file removed, and one
      // write into a directory the manifest never walks.
      write(root, "workflow.jsx", "migrated\n")
      write(root, "src/app.ts", "export const a = 2\n")
      write(root, "scratch.txt", "undeclared\n")
      write(root, "node_modules/left/index.js", "module.exports = 2\n")
      rmSync(join(root, "README.md"))

      const changes = yield* Checkpoint.treeDiff(root, ref)

      expect(changes).toEqual([
        { path: "README.md", change: "deleted", bytes: 0 },
        { path: "scratch.txt", change: "added", bytes: 11 },
        { path: "src/app.ts", change: "modified", bytes: 19 },
        { path: "workflow.jsx", change: "modified", bytes: 9 }
      ])
      // `.git` and `node_modules` are the tools' own storage, not the project's
      // files, so neither is walked and neither can fail a unit.
      expect(changes.some((change) => change.path.startsWith("node_modules/"))).toBe(false)
      expect(changes.some((change) => change.path.startsWith(".git/"))).toBe(false)
    }).pipe(Effect.provide(platform)))

  it.effect("leaves out what the caller excluded, so run state and the report directory are not its business", () =>
    Effect.gen(function*() {
      const root = gitProject("tree-exclude")
      write(root, ".smithers/smithers.db", "run state\n")
      const ref = yield* Checkpoint.take({
        ...payload(root, ["workflow.jsx"]),
        runStateRoots: [".smithers"],
        treeExclude: [".smithers-migrate"]
      })

      write(root, ".smithers/smithers.db", "clobbered\n")

      expect(yield* Checkpoint.treeDiff(root, ref)).toEqual([])
      // It is excluded from the tree because it has a stricter check of its
      // own: the digests the same checkpoint took.
      expect(ref.digests.map((entry) => entry.path)).toEqual([".smithers/smithers.db"])
    }).pipe(Effect.provide(platform)))

  it.effect("records when it was taken, from the clock rather than the wall", () =>
    Effect.gen(function*() {
      const root = gitProject("taken-at")

      const ref = yield* Checkpoint.take(payload(root, ["workflow.jsx"]))

      // `it.effect` runs on a test clock, so this is the clock's answer and not
      // the machine's — which is exactly what makes a duration testable.
      expect(ref.takenAt).toBe(yield* Clock.currentTimeMillis)
      expect(ref.ref).toBe(`refs/smithers-migrate/workflow-demo/${ref.takenAt}`)
    }).pipe(Effect.provide(platform)))
})
