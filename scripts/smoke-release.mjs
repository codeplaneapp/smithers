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
import { build as bundle } from "esbuild"
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..")

/**
 * Packages whose published entry throws on purpose.
 *
 * `smthrs` keeps its place on the registry only to tell an upgrading project
 * where the code went, so a successful load is the failure (rc-contract.md
 * section 3.3).
 */
const noticeOnly = new Set(["smthrs"])
const noticeFirstLine = "smthrs 1.0 is a migration notice, not a runtime."

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
    if (noticeOnly.has(entry.name)) {
      // The unscoped `smthrs` package is a migration notice: loading is
      // supposed to fail, with the notice as the message (rc-contract.md
      // section 3.3). A load that succeeds means the notice stopped working.
      const results = [["ESM import", esm], ["CJS require", cjs]]
      const wrong = results.filter(([, result]) => result.ok || !result.output.includes(noticeFirstLine))
      const status = wrong.length === 0 ? "ok  " : "FAIL"
      console.log(
        `smoke ${status} ${entry.name}@${entry.version} (${entry.filename}, ${(size / 1024).toFixed(1)} kB, migration notice)`
      )
      for (const [label, result] of wrong) {
        failures.push(
          `${entry.name}: ${label} did not report the migration notice\n${result.output.trimEnd()}`
        )
      }
      continue
    }
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

  // Invoke the CLI's lazy documentation API through both published spellings
  // and module systems. A root import alone did not expose a broken CJS
  // `import.meta` fallback because the Docs namespace was never evaluated.
  const docsChecks = [
    [
      "ESM",
      [
        "--input-type=module",
        "--eval",
        [
          'const direct = await import("@smthrs/cli/Docs")',
          'const { Docs: root } = await import("@smthrs/cli")',
          "for (const docs of [direct, root]) {",
          '  if (!docs.directory().endsWith("/node_modules/@smthrs/cli/docs")) throw new Error(docs.directory())',
          '  if (!docs.file(false).endsWith("/docs/llms.txt")) throw new Error(docs.file(false))',
          '  const read = docs.read(false)',
          '  if (!read.found || !read.text.includes("# Smithers")) throw new Error("CLI docs bundle was not readable")',
          "}"
        ].join("\n")
      ]
    ],
    [
      "CJS",
      [
        "--eval",
        [
          'const direct = require("@smthrs/cli/Docs")',
          'const { Docs: root } = require("@smthrs/cli")',
          "for (const docs of [direct, root]) {",
          '  if (!docs.directory().endsWith("/node_modules/@smthrs/cli/docs")) throw new Error(docs.directory())',
          '  if (!docs.file(false).endsWith("/docs/llms.txt")) throw new Error(docs.file(false))',
          '  const read = docs.read(false)',
          '  if (!read.found || !read.text.includes("# Smithers")) throw new Error("CLI docs bundle was not readable")',
          "}"
        ].join("\n")
      ]
    ]
  ]
  for (const [label, args] of docsChecks) {
    const checked = await runQuietly(process.execPath, args, smokeRoot)
    if (!checked.ok) failures.push(`@smthrs/cli: ${label} Docs invocation failed\n${checked.output.trimEnd()}`)
  }

  // Bundle a bare side-effect import from the installed tarball. The package
  // manifest, not this repository's source graph, decides whether esbuild may
  // erase the CLI entry. Other packages stay external so this assertion is
  // exactly about retaining `@smthrs/cli/bin` in ESM and CommonJS consumers.
  const sideEffectBuild = async (format) =>
    bundle({
      absWorkingDir: smokeRoot,
      stdin: {
        contents: format === "esm" ? 'import "@smthrs/cli/bin"\n' : 'require("@smthrs/cli/bin")\n',
        resolveDir: smokeRoot,
        sourcefile: `cli-side-effect.${format === "esm" ? "mjs" : "cjs"}`
      },
      bundle: true,
      format,
      platform: "node",
      treeShaking: true,
      write: false,
      metafile: true,
      logLevel: "silent",
      plugins: [{
        name: "external-packages-except-cli-entry",
        setup(build) {
          build.onResolve({ filter: /^[^./]/ }, (args) =>
            args.path === "@smthrs/cli/bin" ? undefined : { path: args.path, external: true }
          )
        }
      }]
    })
  for (const format of ["esm", "cjs"]) {
    const result = await sideEffectBuild(format)
    const suffix = `/@smthrs/cli/dist/${format}/bin.js`
    const retained = Object.values(result.metafile.outputs).some((output) =>
      Object.entries(output.inputs).some(([path, contribution]) =>
        path.endsWith(suffix) && contribution.bytesInOutput > 0
      )
    )
    if (!retained) failures.push(`@smthrs/cli: ${format.toUpperCase()} tree shaking removed the bin side effect`)
  }
  if (failures.length > 0) {
    throw new Error(`release tarball consumer checks failed:\n${failures.join("\n\n")}`)
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
