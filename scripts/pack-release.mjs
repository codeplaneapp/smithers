/**
 * Packs publishable workspace tarballs without changing the Effect-style
 * source exports used by this repository.
 *
 * pnpm preserves `package.json#exports` when packing; it does not replace it
 * with `publishConfig.exports`. Each package intentionally follows Effect's
 * source-first manifest shape, so release packing happens from a temporary
 * copy whose exports are rewritten to the already-built ESM/CJS artifacts.
 */
import { spawn } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const packagesRoot = join(repoRoot, "packages")
const packageGroups = new Set(["engine", "agent", "tooling"])
export const releaseGroup = "engine"

/**
 * Reads every publishable engine workspace under `packages/`, keyed by
 * directory name.
 *
 * Membership is derived from `smthrs.group`, never restated. Every manifest
 * must declare a known group so a new package cannot silently fall outside a
 * release train. Directories a deleted package left behind carry no manifest
 * and are skipped.
 */
export const readWorkspaceManifests = (root = packagesRoot) => {
  const manifests = new Map()
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(root, entry.name, "package.json")
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    const group = manifest.smthrs?.group
    if (!packageGroups.has(group)) {
      throw new Error(`${manifestPath}: smthrs.group must be one of ${[...packageGroups].join(", ")}`)
    }
    if (manifest.private || group !== releaseGroup) continue
    manifests.set(entry.name, manifest)
  }
  return manifests
}

/**
 * Maps each workspace directory to the workspace directories it depends on.
 *
 * Only `@smthrs/*` edges resolving to a member of `manifests` are kept, so a
 * dependency on something outside the release set cannot order the release.
 */
export const workspaceDependencies = (manifests) => {
  const directoryOf = new Map(
    [...manifests].map(([directory, manifest]) => [manifest.name, directory])
  )
  return new Map([...manifests].map(([directory, manifest]) => [
    directory,
    new Set(
      Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })
        .map((dependency) => directoryOf.get(dependency))
        .filter((dependency) => dependency !== undefined)
    )
  ]))
}

const dependsOnItself = (node, dependencies, remaining) => {
  const pending = [...dependencies.get(node)].filter((edge) => remaining.has(edge))
  const seen = new Set()
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === node) return true
    if (seen.has(current)) continue
    seen.add(current)
    for (const edge of dependencies.get(current)) {
      if (remaining.has(edge)) pending.push(edge)
    }
  }
  return false
}

/**
 * Orders workspaces so a package follows every workspace dependency it declares.
 *
 * The graph is not acyclic. `@smthrs/kernel` publishes `kernel/test/TestHost`,
 * which imports `@smthrs/platform-browser`, and `platform-browser` imports
 * `@smthrs/kernel` back. So the order emits an unblocked workspace whenever one
 * exists, and otherwise enters the remaining cycle at its alphabetically first
 * member. Only a genuine cycle is ever broken; every other edge is respected.
 */
export const dependencyOrder = (dependencies) => {
  const remaining = new Set([...dependencies.keys()].sort())
  const ordered = []
  while (remaining.size > 0) {
    const unblocked = [...remaining].find((candidate) =>
      [...dependencies.get(candidate)].every((edge) => !remaining.has(edge))
    )
    // Every remaining workspace is blocked, so the remaining subgraph has an
    // out-edge everywhere and therefore contains a cycle to enter.
    const next = unblocked ??
      [...remaining].find((candidate) => dependsOnItself(candidate, dependencies, remaining))
    if (next === undefined) {
      throw new Error(`no orderable workspace among ${[...remaining].join(", ")}`)
    }
    ordered.push(next)
    remaining.delete(next)
  }
  return ordered
}

/**
 * Dependency order used for release packing and publication.
 */
export const workspaces = dependencyOrder(workspaceDependencies(readWorkspaceManifests()))

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Extracts the portable tarball name from pnpm's pack result.
 *
 * pnpm returns an absolute `filename` when `--pack-destination` is absolute,
 * while the release manifest deliberately stores names relative to its pack
 * directory so CI can move and publish that directory as one artifact.
 */
export const packResultFilename = (result, packageName) => {
  if (!isRecord(result) || typeof result.filename !== "string") {
    throw new Error(`pnpm pack returned no filename for ${String(packageName)}`)
  }
  return basename(result.filename)
}

/**
 * Produces the manifest that belongs in a registry tarball.
 */
export const publicationManifest = (manifest) => {
  if (!isRecord(manifest)) {
    throw new TypeError("package manifest must be an object")
  }
  const publishConfig = manifest.publishConfig
  if (!isRecord(publishConfig) || !isRecord(publishConfig.exports)) {
    throw new TypeError(`${String(manifest.name ?? "package")} must declare publishConfig.exports`)
  }
  const { exports, ...publishedConfig } = publishConfig
  return {
    ...manifest,
    exports,
    publishConfig: publishedConfig
  }
}

const sourceFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory()
      ? sourceFiles(path)
      : entry.name.endsWith(".ts") ? [path] : []
  }))
  return nested.flat()
}

const assertBuilt = async (packageRoot) => {
  const sourceRoot = join(packageRoot, "src")
  for (const source of await sourceFiles(sourceRoot)) {
    const modulePath = relative(sourceRoot, source).slice(0, -3)
    await Promise.all([
      access(join(packageRoot, "dist", "esm", `${modulePath}.js`)),
      access(join(packageRoot, "dist", "esm", `${modulePath}.d.ts`)),
      access(join(packageRoot, "dist", "cjs", `${modulePath}.js`))
    ])
  }
}

const copyFilter = (packageRoot) => (source) => {
  const path = relative(packageRoot, source)
  if (path === "") return true
  const segments = path.split(sep)
  return !segments.some((segment) =>
    segment === "node_modules" ||
    segment === "coverage" ||
    segment === ".smithers"
  ) && !basename(path).endsWith(".tsbuildinfo")
}

const run = (command, args, options = {}) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "inherit"],
      ...options
    })
    let stdout = ""
    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk) => {
      stdout += chunk
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun(stdout)
      } else {
        reject(new Error(`${command} exited with ${code ?? signal ?? "unknown status"}`))
      }
    })
  })

const packWorkspace = async (name, outputDirectory, stagingRoot) => {
  const packageRoot = join(repoRoot, "packages", name)
  await assertBuilt(packageRoot)

  const manifestPath = join(packageRoot, "package.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  const stagedPackage = join(stagingRoot, name)
  await cp(packageRoot, stagedPackage, {
    recursive: true,
    filter: copyFilter(packageRoot)
  })
  await writeFile(
    join(stagedPackage, "package.json"),
    `${JSON.stringify(publicationManifest(manifest), null, 2)}\n`
  )

  const output = await run(
    "pnpm",
    [
      "--dir",
      stagedPackage,
      "pack",
      "--json",
      "--config.ignore-scripts=true",
      "--pack-destination",
      outputDirectory
    ]
  )
  const result = JSON.parse(output)
  return {
    name: manifest.name,
    version: manifest.version,
    filename: packResultFilename(result, manifest.name)
  }
}

export const main = async (args) => {
  const destination = args[0]
  if (destination === "--help") {
    console.log(
      [
        "usage: node scripts/pack-release.mjs <output-directory>",
        "       node scripts/pack-release.mjs --list    workspace directories, in publication order",
        "       node scripts/pack-release.mjs --names   package names, in publication order"
      ].join("\n")
    )
    return
  }
  if (destination === "--list") {
    console.log(workspaces.join("\n"))
    return
  }
  if (destination === "--names") {
    const manifests = readWorkspaceManifests()
    console.log(workspaces.map((directory) => manifests.get(directory).name).join("\n"))
    return
  }
  if (destination === undefined) {
    throw new Error("usage: node scripts/pack-release.mjs <output-directory> (or --list or --names)")
  }
  const outputDirectory = resolve(repoRoot, destination)
  await mkdir(outputDirectory, { recursive: true })
  const stagingRoot = await mkdtemp(join(tmpdir(), "smthrs-release-pack-"))
  try {
    const packed = []
    for (const name of workspaces) {
      packed.push(await packWorkspace(name, outputDirectory, stagingRoot))
    }
    await writeFile(
      join(outputDirectory, "manifest.json"),
      `${JSON.stringify(packed, null, 2)}\n`
    )
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}

const isMain = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isMain) {
  await main(process.argv.slice(2))
}
