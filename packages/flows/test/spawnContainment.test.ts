import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Containment is a property of the `ChildProcessSpawner` SERVICE, not of any
 * call site.
 *
 * A host decides its kill policy once, by decorating that service
 * (`ContainedSpawner` adds `forceKillAfter ?? graceMs` and a `ProcessLedger`
 * record), and every module that resolves the tag inherits the deadline and
 * the journal entry for free. A module that reaches for `child_process` (or
 * `cluster`) instead inherits neither: its children outlive a cancel by
 * however long they choose, and a hard-killed host leaves them with nothing
 * recording that they exist, so the next incarnation cannot reap them.
 *
 * No behavioral test can see that. The bypassing module works, its own suite
 * is green, and the only symptom is a process still running on someone's
 * machine after the flow that started it was cancelled. So the bypass is
 * checked for directly, over the whole repository rather than one package:
 * `packages/std/test/ExecContainment.test.ts` carries the same assertion
 * scoped to `std` alone, where it fails fast during work on that package, and
 * this suite is the universe.
 *
 * The exceptions are named here with the reason each one is bounded, not
 * derived from what happens to be in the tree. The list is checked in both
 * directions, the way the coverage-gate deferral next door is: an unlisted
 * importer fails, and a listed file that no longer imports a process-starting
 * module fails too, so the list expires on its own instead of quietly widening
 * the exemption. The matcher itself is pinned against fixtures, because every
 * spelling it fails to recognize is a bypass that reads as compliance.
 */
describe("child-process containment conformance", () => {
  const packagesDir = resolve(import.meta.dirname, "..", "..")

  /**
   * Files allowed to start a child outside the host's spawner, each with the
   * bound that makes it safe.
   *
   * Keys are `<package>/<path under the package>` with POSIX separators.
   */
  const allowed = new Map<string, string>([
    [
      "jj/src/node/NodeJj.ts",
      "The self-spawning `layer`, for a program that has no spawner to offer. "
      + "Bounded: every command is short-lived, writes to a pipe so jj starts no pager, "
      + "opens no editor (`snapshot` passes `-m` or runs no `describe`, because "
      + "`jj describe` without `-m` starts `$JJ_EDITOR` and waits for it), "
      + "and is held by the handle the invocation started, so a cancel signals it "
      + "(`packages/jj/test/NodeJjLifetime.test.ts`, `packages/jj/test/NodeJj.test.ts`). "
      + "A host that wants the process GROUP contained composes `layerSpawner` instead, "
      + "which is what `NodeHost.layerContained` does."
    ],
    [
      "platform-node/src/AtomicFileSystem.ts",
      "The atomic-operation helper. It CANNOT route through the spawner: `NodeHost` builds "
      + "`NodeChildProcessSpawner.layer` over `AtomicFileSystem.layer`, so routing it would "
      + "close a layer cycle. Bounded instead: `complete()` calls `cleanup()`, which SIGKILLs, "
      + "on every settle path and on interruption, and the helper is one `python3 -I` syscall batch."
    ],
    [
      "platform-node/src/ProcessReaper.ts",
      "`spawnSync` of `ps` and `taskkill`, inside the reaper itself. Synchronous and sub-second: "
      + "routing the reaper through the spawner it exists to clean up after would close a cycle "
      + "of its own."
    ],
    [
      "targets/src/Exec.ts",
      "The private build-graph target executor, not reachable through the kernel's `proc:spawn`. "
      + "It kills its child's process group on fiber death or `timeoutMs` itself."
    ],
    [
      "targets/src/LlmLint.ts",
      "Same private build-graph executor path as `targets/src/Exec.ts`."
    ],
    ...[
      "AgentSession.ts",
      "GitCommit.ts",
      "GoExec.ts",
      "MemoryBackend.ts",
      "PackageTree.ts",
      "RepoResolution.ts",
      "ServiceSupervisor.ts",
      "Workspace.ts"
    ].map((file): [string, string] => [
      `build-cli/src/${file}`,
      "Repository tooling. `@smthrs/build-cli` is private and runs no flow, so it hosts nothing "
      + "a `ProcessLedger` would ever be asked about."
    ])
  ])

  /**
   * The specifier of a module that starts a process, in either spelling.
   *
   * The `node:` prefix is optional because omitting it binds exactly the same
   * module, and nothing in this repository requires the prefix: no
   * `packages/*\/eslint.config.js` configures `unicorn/prefer-node-protocol`
   * or `no-restricted-imports`. A gate that matched only the prefixed
   * spelling would therefore be one token wide.
   *
   * `cluster` is here beside `child_process` because `cluster.fork()` starts
   * a process the same way and inherits the same nothing: no kill deadline,
   * no ledger record. Nothing under `packages/*\/src` imports it today, so
   * the exemption list below is unaffected. Threads are out of scope: a
   * `node:worker_threads` worker dies with the process that made it.
   */
  const spawningModule = String.raw`["'](?:node:)?(?:child_process|cluster)["']`

  /**
   * An import of a process-starting module, in any of the three forms that
   * actually bind it.
   *
   * Prose is deliberately not matched. Six modules name `node:child_process`
   * in a doc comment to say what they do or do not do, and a scan that
   * flagged those would push authors toward describing the boundary less
   * clearly, which is the opposite of the point.
   */
  const importsSpawningModule = (source: string): boolean =>
    new RegExp(String.raw`^\s*import\s[^\n]*?from\s*${spawningModule}`, "m").test(source)
    || new RegExp(String.raw`\bimport\s*\(\s*${spawningModule}\s*\)`).test(source)
    || new RegExp(String.raw`\brequire\s*\(\s*${spawningModule}\s*\)`).test(source)

  const isDirectory = (path: string) => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  }

  /**
   * Every TypeScript module under `packages/<name>/src`.
   *
   * The universe is derived from the packages directory rather than from a
   * list, so a package added tomorrow is covered without anyone remembering
   * to add it here.
   */
  const sources: Array<{ readonly id: string; readonly path: string }> = []
  for (const name of readdirSync(packagesDir)) {
    const root = join(packagesDir, name, "src")
    if (!isDirectory(root)) continue
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry)
        if (isDirectory(path)) walk(path)
        else if (path.endsWith(".ts")) {
          sources.push({ id: `${name}/${relative(join(packagesDir, name), path).split(sep).join("/")}`, path })
        }
      }
    }
    walk(root)
  }

  const importers = sources
    .filter(({ path }) => importsSpawningModule(readFileSync(path, "utf8")))
    .map(({ id }) => id)
    .sort()

  it("recognizes every specifier that binds a process-starting module", () => {
    // The gate is only as wide as its matcher, and the matcher is the one part
    // of this suite that scanning the tree cannot exercise: nothing under
    // `packages/*/src` spells the bare specifier today, so a matcher that
    // missed it would look exactly like a matcher that works, right up to the
    // day someone writes it. `import { spawn } from "child_process"` binds the
    // same module as the `node:`-prefixed form, and no eslint config in this
    // repository requires the prefix, so both spellings are pinned here.
    for (const specifier of ["node:child_process", "child_process", "node:cluster", "cluster"]) {
      expect(importsSpawningModule(`import { spawn } from "${specifier}"\n`), specifier).toBe(true)
      expect(importsSpawningModule(`import spawner from '${specifier}'\n`), specifier).toBe(true)
      expect(importsSpawningModule(`const spawner = require("${specifier}")\n`), specifier).toBe(true)
      expect(importsSpawningModule(`const spawner = await import("${specifier}")\n`), specifier).toBe(true)
    }

    // Prose that names the module to describe a boundary is not an import, and
    // an importer of a different module that merely reads alike is not one
    // either.
    expect(importsSpawningModule(" * Resolves the tag instead of node:child_process.\n")).toBe(false)
    expect(importsSpawningModule("// never child_process, always the tag\n")).toBe(false)
    expect(importsSpawningModule("import { Worker } from \"node:worker_threads\"\n")).toBe(false)
  })

  it("scans a universe that could actually contain a bypass", () => {
    // Guards the guard: a broken walk or a renamed directory would make every
    // assertion below pass over nothing.
    expect(sources.length).toBeGreaterThan(500)
    expect(sources.map(({ id }) => id)).toContain("std/src/internal/Exec.ts")
  })

  it("starts child processes only through the host's spawner", () => {
    // An unlisted importer is a module whose children are outside the kill
    // deadline and outside the ledger. If it belongs there, add it above with
    // the bound that makes it safe; the reason is the review, not the entry.
    expect(importers.filter((id) => !allowed.has(id))).toEqual([])
  })

  it.each([...allowed.keys()].map((id) => ({ id })))(
    "$id still needs its containment exemption",
    ({ id }) => {
      // Self-expiring, like the coverage-gate deferral next door: a file that
      // stopped spawning directly, or moved, must leave the list rather than
      // sit there pre-approving whatever takes its place at that path.
      expect(importers).toContain(id)
    }
  )
})
