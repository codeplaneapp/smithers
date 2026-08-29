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
 * the journal entry for free. A module that reaches for `node:child_process`
 * instead inherits neither: its children outlive a cancel by however long
 * they choose, and a hard-killed host leaves them with nothing recording that
 * they exist, so the next incarnation cannot reap them.
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
 * importer fails, and a listed file that no longer imports
 * `node:child_process` fails too, so the list expires on its own instead of
 * quietly widening the exemption.
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
      + "and is held by the handle the invocation started, so a cancel signals it "
      + "(`packages/jj/test/NodeJjLifetime.test.ts`). A host that wants the process GROUP "
      + "contained composes `layerSpawner` instead, which is what `NodeHost.layerContained` does."
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
   * An import of `node:child_process`, in any of the three forms that
   * actually bind the module.
   *
   * Prose is deliberately not matched. Six modules name `node:child_process`
   * in a doc comment to say what they do or do not do, and a scan that
   * flagged those would push authors toward describing the boundary less
   * clearly, which is the opposite of the point.
   */
  const importsChildProcess = (source: string): boolean =>
    /^\s*import\s[^\n]*?from\s*["']node:child_process["']/m.test(source)
    || /\bimport\s*\(\s*["']node:child_process["']\s*\)/.test(source)
    || /\brequire\s*\(\s*["']node:child_process["']\s*\)/.test(source)

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
    .filter(({ path }) => importsChildProcess(readFileSync(path, "utf8")))
    .map(({ id }) => id)
    .sort()

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
