/**
 * Installs release tarballs into an external temporary project and verifies
 * every packed package, not just the barrel.
 *
 * A consumer of this release never has the workspace: they get the tarballs and
 * whatever the manifests tell a package manager to fetch. So the smoke project
 * is created outside the repository, the tarballs are installed into it, and
 * each packed package is then imported through its published entry as ESM and
 * required as CJS. A package that resolves only because the workspace is on
 * disk fails here.
 *
 * Optional peer dependencies are installed too, because a peer is exactly what
 * the consumer is told to bring: `@smthrs/platform-bun` resolves
 * `@effect/platform-bun` at import time, and without it the ESM entry throws
 * ERR_MODULE_NOT_FOUND in the consumer's project.
 *
 * usage: node scripts/smoke-release.mjs <pack-directory>
 */
import { spawn } from "node:child_process"
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..")

const run = (command, args, cwd) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun()
      } else {
        reject(new Error(`${command} exited with ${code ?? signal ?? "unknown status"}`))
      }
    })
  })

const runQuietly = (command, args, cwd) =>
  new Promise((resolveRun) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8")
      stream.on("data", (chunk) => {
        output += chunk
      })
    }
    child.once("error", (error) => resolveRun({ ok: false, output: error.message }))
    child.once("exit", (code) => resolveRun({ ok: code === 0, output }))
  })

/**
 * Compares dotted numeric versions. Prerelease suffixes are ignored; the
 * engines floors in this repository are plain releases.
 */
const isAtLeast = (version, floor) => {
  const parse = (value) => value.replaceAll(/^\D+/g, "").split(".").map((part) => Number.parseInt(part, 10) || 0)
  const [actual, required] = [parse(version), parse(floor)]
  for (let index = 0; index < 3; index += 1) {
    if ((actual[index] ?? 0) !== (required[index] ?? 0)) return (actual[index] ?? 0) > (required[index] ?? 0)
  }
  return true
}

/**
 * The optional peers a consumer must install for the packed set to import.
 * Derived from the installed manifests so a new peer cannot slip past this gate.
 */
const optionalPeers = (manifests) => {
  const peers = new Map()
  for (const manifest of manifests) {
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (name.startsWith("@smthrs/")) continue
      peers.set(name, range)
    }
  }
  return peers
}

const packDirectory = process.argv[2]
if (packDirectory === undefined) {
  throw new Error("usage: node scripts/smoke-release.mjs <pack-directory>")
}

const absolutePackDirectory = resolve(packDirectory)
const packManifest = JSON.parse(
  await readFile(join(absolutePackDirectory, "manifest.json"), "utf8")
)
const expected = new Set(packManifest.map((entry) => entry.filename))
const tarballs = (await readdir(absolutePackDirectory))
  .filter((filename) => filename.endsWith(".tgz"))
  .sort()

if (tarballs.length !== expected.size || tarballs.some((filename) => !expected.has(filename))) {
  throw new Error("release pack directory does not match manifest.json")
}

const smokeRoot = await mkdtemp(join(tmpdir(), "smthrs-release-smoke-"))
try {
  await writeFile(
    join(smokeRoot, "package.json"),
    '{\n  "private": true,\n  "type": "module"\n}\n'
  )
  // The packages are not published yet, and pnpm resolves each transitive
  // exact-version edge independently even when every tarball is also passed
  // to `pnpm add`. Override those internal edges to the tarballs under test so
  // the smoke project cannot fall back to an older registry copy.
  await writeFile(
    join(smokeRoot, "pnpm-workspace.yaml"),
    [
      "overrides:",
      ...packManifest.map((entry) =>
        `  ${JSON.stringify(entry.name)}: ${JSON.stringify(`file:${join(absolutePackDirectory, entry.filename)}`)}`
      ),
      ""
    ].join("\n")
  )
  await run(
    "pnpm",
    [
      "--dir",
      smokeRoot,
      "add",
      "--ignore-scripts",
      ...tarballs.map((filename) => join(absolutePackDirectory, filename)),
      "typescript@6.0.3",
      "vitest@4.1.9"
    ],
    repoRoot
  )

  const installed = await Promise.all(
    packManifest.map(async (entry) =>
      JSON.parse(await readFile(join(smokeRoot, "node_modules", entry.name, "package.json"), "utf8"))
    )
  )
  for (const manifest of installed) {
    const floor = manifest.engines?.node
    if (floor !== undefined && !isAtLeast(process.versions.node, floor)) {
      throw new Error(
        `${manifest.name} requires node ${floor}; this smoke runs on ${process.versions.node}`
      )
    }
  }
  const peers = [...optionalPeers(installed)]
    .filter(([name]) => installed.every((manifest) => manifest.name !== name))
    .map(([name, range]) => `${name}@${range.replace(/^[\^~]/, "")}`)
  if (peers.length > 0) {
    await run("pnpm", ["--dir", smokeRoot, "add", "--ignore-scripts", ...peers], repoRoot)
  }

  // Every packed package, through its published entry, in a project that has
  // no access to the workspace.
  const failures = []
  for (const entry of packManifest) {
    const size = (await stat(join(absolutePackDirectory, entry.filename))).size
    const esm = await runQuietly(
      process.execPath,
      ["--input-type=module", "--eval", `await import(${JSON.stringify(entry.name)})`],
      smokeRoot
    )
    const cjs = await runQuietly(
      process.execPath,
      ["--eval", `require(${JSON.stringify(entry.name)})`],
      smokeRoot
    )
    const status = esm.ok && cjs.ok ? "ok  " : "FAIL"
    console.log(
      `smoke ${status} ${entry.name}@${entry.version} (${entry.filename}, ${(size / 1024).toFixed(1)} kB)`
    )
    if (!esm.ok) failures.push(`${entry.name}: ESM import failed\n${esm.output.trimEnd()}`)
    if (!cjs.ok) failures.push(`${entry.name}: CJS require failed\n${cjs.output.trimEnd()}`)
  }
  if (failures.length > 0) {
    throw new Error(`release tarballs failed to load:\n${failures.join("\n\n")}`)
  }

  await writeFile(
    join(smokeRoot, "smoke.mts"),
    [
      'import * as Flows from "@smthrs/flows"',
      'import { runHostContract } from "@smthrs/kernel/test/contract"',
      "",
      "const publicApi: typeof Flows = Flows",
      "void publicApi",
      "void runHostContract",
      ""
    ].join("\n")
  )
  await run(
    "node",
    [
      "node_modules/typescript/bin/tsc",
      "--noEmit",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      "--skipLibCheck",
      "smoke.mts"
    ],
    smokeRoot
  )
  console.log(
    `\nrelease smoke holds: ${packManifest.length} tarballs install, import, and typecheck` +
      ` on node ${process.versions.node}.`
  )
} finally {
  await rm(smokeRoot, { recursive: true, force: true })
}
