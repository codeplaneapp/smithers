/**
 * Test helpers: a real Node filesystem layer, and a fixture copied into a
 * temporary directory so a scanner runs against real files it may not disturb.
 *
 * @since 0.1.0
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { buildSync } from "esbuild"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as Layer from "effect/Layer"

/** The real Node filesystem and path services every scanner test runs on. */
export const platform: Layer.Layer<never> = Layer.merge(NodeFileSystem.layer, NodePath.layer) as never as Layer.Layer<
  never
>

/** The layer scanners take: a real filesystem and a real path service. */
export const nodeLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer)

/** The absolute path of one committed fixture. */
export const fixture = (name: string): string => fileURLToPath(new URL(`./${name}`, import.meta.url))

const temporaries: Array<string> = []

/**
 * Copies a fixture into a fresh temporary directory and returns its path. The
 * copy is removed when the process exits, so a failing test leaves nothing
 * behind and a passing one never mutates the committed fixture.
 */
export const copyFixture = (name: string): string => {
  const target = mkdtempSync(join(tmpdir(), `migrate-${name.replace(/[^a-z0-9]+/gi, "-")}-`))
  cpSync(fixture(name), target, { recursive: true })
  temporaries.push(target)
  return target
}

process.on("exit", () => {
  for (const target of temporaries) rmSync(target, { recursive: true, force: true })
})

/**
 * The sha256 of every file under `root`, keyed by its relative path.
 *
 * A listing is a snapshot and the entries are read afterwards, so a name can
 * be gone by the time it is reached. The fixtures carry a real `.git`, and
 * git's background maintenance creates and removes `.git/objects/maintenance.lock`
 * on its own schedule, which made two of these tests fail on CI and pass on a
 * developer's machine for no reason either could see. A vanished name is
 * treated as absent, which is what it is: the walk runs after the migration
 * has finished, so nothing it wrote can disappear underneath it, and every
 * path that stays put is compared exactly as before.
 */
export const hashTree = (root: string): ReadonlyMap<string, string> => {
  const hashes = new Map<string, string>()
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const absolute = join(directory, entry)
      const key = prefix === "" ? entry : `${prefix}/${entry}`
      try {
        if (statSync(absolute).isDirectory()) visit(absolute, key)
        else hashes.set(key, createHash("sha256").update(readFileSync(absolute)).digest("hex"))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    }
  }
  visit(root, "")
  return hashes
}

/**
 * Builds the `smithers-migrate` bin as one file a process can run, and returns
 * its path.
 *
 * A test that only calls `Command.run` proves the composition and not the
 * executable: the flag parsing, the exit codes, and the rendering an operator
 * actually sees all live in `bin.ts`, and none of them run in process. The
 * bundle is what makes spawning it possible at all — the package's sources are
 * TypeScript, and Node will not strip types out of `node_modules`, which is
 * where every `@smthrs/*` import resolves to.
 *
 * It is written under `node_modules` so that `effect` and `@effect/platform-node`,
 * which stay external because they ship their own builds, resolve from the
 * package the way they do for a published install.
 */
export const buildBin = (): string => {
  const source = fileURLToPath(new URL("../../src/", import.meta.url))
  const target = join(fileURLToPath(new URL("../../node_modules/.migrate-bin/", import.meta.url)), "bin.mjs")
  // Rebuilt whenever a source is newer than the bundle, so an edit is never
  // measured against the build before it.
  const newest = (directory: string): number =>
    readdirSync(directory, { withFileTypes: true }).reduce((latest, entry) => {
      const path = join(directory, entry.name)
      return Math.max(latest, entry.isDirectory() ? newest(path) : statSync(path).mtimeMs)
    }, 0)
  if (existsSync(target) && statSync(target).mtimeMs > newest(source)) return target
  buildSync({
    entryPoints: [join(source, "flow", "bin.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: target,
    external: ["effect", "@effect/*", "typescript"],
    // A bundled CommonJS dependency still calls `require`, and an ES module has
    // none until one is made.
    banner: { js: "import { createRequire as ___cr } from 'node:module'; const require = ___cr(import.meta.url);" }
  })
  return target
}

/**
 * Node's own warnings, which are not the program's output.
 *
 * The repository pins Node 22.19.0, where `node:sqlite` is experimental and
 * every run of a binary that opens a database prints
 * `ExperimentalWarning: SQLite is an experimental feature` followed by the
 * `--trace-warnings` hint. Node 24, which a developer machine may be running,
 * prints neither, so an assertion that the program said nothing passes locally
 * and fails on the version CI runs. Dropping the runtime's own lines keeps the
 * assertion about the program.
 */
const nodeWarning = /^(?:\(node:\d+\) \w*Warning:|\(Use `node --trace-warnings).*$\n?/gm

/** Runs the built bin and returns its exit code and both streams. */
export const runBin = (
  args: ReadonlyArray<string>,
  environment: Readonly<Record<string, string | undefined>> = process.env
): { readonly status: number; readonly stdout: string; readonly stderr: string } => {
  const result = spawnSync(process.execPath, [buildBin(), ...args], {
    encoding: "utf8",
    env: environment as Record<string, string>
  })
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: (result.stderr ?? "").replace(nodeWarning, "")
  }
}
