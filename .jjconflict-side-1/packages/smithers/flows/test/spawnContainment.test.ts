import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import * as ts from "typescript"
import { describe, expect, it } from "vitest"
import { collectSources, fileBindsSpawningModule } from "./SpawnSpecifiers.ts"

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
 * `packages/smithers/agent/std/test/ExecContainment.test.ts` carries the same assertion
 * scoped to `std` alone, where it fails fast during work on that package, and
 * this suite is the universe.
 *
 * Both read `packages/smithers/flows/test/SpawnSpecifiers.ts`, which parses each file
 * and asks the syntax tree. One reader means this gate can never be narrower
 * than the package-local one, and a parser means neither can be defeated by
 * an import's LAYOUT. The three regex readers that came before were each one
 * layout wide, and the last one missed the multi-line import `dprint` itself
 * produces for any import over 120 characters. The reader's fixtures, one
 * file per layout, live beside it in
 * `packages/smithers/flows/test/SpawnSpecifiers.test.ts`.
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
  // `packages/`, three levels up: this suite lives in
  // `packages/smithers/flows/test`.
  const packagesDir = resolve(import.meta.dirname, "..", "..", "..")

  /**
   * Files allowed to start a child outside the host's spawner, each with the
   * bound that makes it safe.
   *
   * Keys are `<package>/<path under the package>` with POSIX separators.
   */
  const allowed = new Map<string, string>([
    [
      "smithers/flows/jj/src/node/NodeJj.ts",
      "The self-spawning `layer`, for a program that has no spawner to offer. "
      + "Bounded: every command is short-lived, writes to a pipe so jj starts no pager, "
      + "opens no editor (`snapshot` passes `-m` or runs no `describe`, because "
      + "`jj describe` without `-m` starts `$JJ_EDITOR` and waits for it), "
      + "and is held by the handle the invocation started, so a cancel signals it "
      + "(`packages/smithers/flows/jj/test/NodeJjLifetime.test.ts`, `packages/smithers/flows/jj/test/NodeJj.test.ts`). "
      + "A host that wants the process GROUP contained composes `layerSpawner` instead, "
      + "which is what `NodeHost.layerContained` does."
    ],
    [
      "smithers/flows/platform-node/src/AtomicFileSystem.ts",
      "The atomic-operation helper. It CANNOT route through the spawner: `NodeHost` builds "
      + "`NodeChildProcessSpawner.layer` over `AtomicFileSystem.layer`, so routing it would "
      + "close a layer cycle. Bounded instead: `complete()` calls `cleanup()`, which SIGKILLs, "
      + "on every settle path and on interruption, and the helper is one `python3 -I` syscall batch."
    ],
    [
      "smithers/flows/platform-node/src/ProcessReaper.ts",
      "`spawnSync` of `ps` and `taskkill`, inside the reaper itself. Synchronous and sub-second: "
      + "routing the reaper through the spawner it exists to clean up after would close a cycle "
      + "of its own."
    ],
    [
      "testing/src/Faults.ts",
      "The fault tier's process primitives. `execFileSync` of `ps -o ppid=` reads the process "
      + "TABLE; it starts nothing a `ProcessLedger` could record and nothing a kill deadline could "
      + "bound, and the module's other exports signal pids the caller already owns rather than "
      + "spawning any. Bounded twice over: the read is synchronous and sub-second, the same shape "
      + "`smithers/flows/platform-node/src/ProcessReaper.ts` is exempted for, and no flow reaches this module — it "
      + "is imported only by a package's `test/faults` tree, which is exactly the tier that exists "
      + "to prove containment rather than to be contained by it."
    ],
    [
      "smithers/build/targets/src/Exec.ts",
      "The private build-graph target executor, not reachable through the kernel's `proc:spawn`. "
      + "It kills its child's process group on fiber death or `timeoutMs` itself."
    ],
    [
      "smithers/build/targets/src/LlmLint.ts",
      "Same private build-graph executor path as `smithers/build/targets/src/Exec.ts`."
    ],
    [
      "smithers/src/Detached.ts",
      "`smithers up -d`, the one launcher whose child must OUTLIVE the process that "
      + "started it. Routing it through the host spawner would kill the engine on the "
      + "launcher's scope release, which is the opposite of what the verb means. Bounded "
      + "instead: the child is spawned `detached: true` into its own process group and "
      + "`unref`ed, the launcher signals that whole group with `terminate()` when the child "
      + "misses its admission deadline, and the child is itself a `smithers` engine that "
      + "composes the contained host, so everything IT spawns is inside the ledger and the "
      + "kill deadline (`packages/smithers/test/Detached.test.ts`)."
    ],
    ...[
      "AgentSession.ts",
      "GitCommit.ts",
      "GoExec.ts",
      "MemoryBackend.ts",
      "NixExec.ts",
      "PackageTree.ts",
      "RepoResolution.ts",
      "ServiceSupervisor.ts"
    ].map((file): [string, string] => [
      `smithers/build/build-cli/src/${file}`,
      "Repository tooling. `@smthrs/build-cli` is private and runs no flow, so it hosts nothing "
      + "a `ProcessLedger` would ever be asked about."
    ])
  ])

  const isDirectory = (path: string) => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  }

  /**
   * Every source module under `packages/<name>/src`.
   *
   * The universe is derived from the packages directory rather than from a
   * list, so a package added tomorrow is covered without anyone remembering
   * to add it here, and it spans every extension a module in this repository
   * can be written in rather than `.ts` alone.
   */
  const sources: Array<{ readonly id: string; readonly path: string }> = []
  // The walk descends. Packages nest — a granular package lives inside the
  // product package it belongs to — so a reading one directory deep would
  // scan a handful of packages and pass over every module in the engine. An
  // id is the module's path under `packages/`, which names one package's file
  // whatever depth that package sits at.
  const packageDirectories = (parent: string): ReadonlyArray<string> =>
    readdirSync(join(packagesDir, parent === "" ? "." : parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
      .flatMap((entry) => {
        const directory = parent === "" ? entry.name : `${parent}/${entry.name}`
        return existsSync(join(packagesDir, directory, "package.json"))
          ? [directory, ...packageDirectories(directory)]
          : []
      })
  for (const name of packageDirectories("")) {
    const root = join(packagesDir, name, "src")
    if (!isDirectory(root)) continue
    for (const path of collectSources(root)) {
      sources.push({ id: `${name}/${relative(join(packagesDir, name), path).split(sep).join("/")}`, path })
    }
  }

  const importers = sources
    .filter(({ path }) => fileBindsSpawningModule(path))
    .map(({ id }) => id)
    .sort()

  it("scans a universe that could actually contain a bypass", () => {
    // Guards the guard: a broken walk or a renamed directory would make every
    // assertion below pass over nothing. The extension assertions are the
    // widened universe stated as a requirement, so narrowing the walk back to
    // `.ts` fails here rather than silently un-scanning the 86 `.tsx`
    // components and two `.js` entry points it used to skip.
    expect(sources.length).toBeGreaterThan(900)
    expect(sources.map(({ id }) => id)).toContain("smithers/agent/std/src/internal/Exec.ts")
    expect(sources.some(({ id }) => id.endsWith(".tsx"))).toBe(true)
    expect(sources.some(({ id }) => id.endsWith(".js"))).toBe(true)
  })

  it("starts child processes only through the host's spawner", () => {
    // An unlisted importer is a module whose children are outside the kill
    // deadline and outside the ledger. If it belongs there, add it above with
    // the bound that makes it safe; the reason is the review, not the entry.
    expect(importers.filter((id) => !allowed.has(id))).toEqual([])
  })

  // Parses every workspace source into a TypeScript AST, so the cost is
  // allocation bound and scales with the machine. Measured at 995 ms on an idle
  // developer machine and 38.3 s on a two-core hosted runner sharing itself
  // with eleven other test files, which overran the 30 s package default. The
  // budget clears the observed cost three times over and still bounds a hang.
  it("never reads a secret declaration directly from an environment", { timeout: 120_000 }, () => {
    const reads: Array<string> = []
    for (const source of sources) {
      const file = ts.createSourceFile(
        source.path,
        readFileSync(source.path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        source.path.endsWith(".tsx")
          ? ts.ScriptKind.TSX
          : source.path.endsWith(".jsx")
          ? ts.ScriptKind.JSX
          : source.path.endsWith(".js")
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS
      )
      const visit = (node: ts.Node): void => {
        if (
          ts.isElementAccessExpression(node) && node.argumentExpression !== undefined &&
          ts.isPropertyAccessExpression(node.argumentExpression) && node.argumentExpression.name.text === "env"
        ) {
          const parent = node.parent
          const isWrite = ts.isBinaryExpression(parent) && parent.left === node &&
            parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
          if (!isWrite) {
            const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
            reads.push(`${source.id}:${line}`)
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(file)
    }
    // A value lookup belongs in SecretProxy's private vault reader at the
    // instant it constructs the outbound request. Indexing any environment
    // with `secret.env` recreates eager resolution in a job or planner.
    expect(reads).toEqual([])
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
