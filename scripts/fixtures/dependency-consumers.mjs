/** Disposable npm/pnpm consumers of unchanged release manifests or candidate bytes. */
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createRequire } from "node:module"
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { releaseRegistry } from "../release-registry.mjs"
import { build as bundle } from "esbuild"

const effect = "4.0.0-rc.112"
const firstParty = "1.0.0-rc.0"
const runners = ["vitest", "@effect/vitest", "@smthrs/testing"]
const nodeAdapters = ["@smthrs/platform-node", "@effect/platform-node", "@effect/platform-node-shared", "@effect/sql-sqlite-node"]
const telemetryAdapters = [
  "@opentelemetry/exporter-logs-otlp-http", "@opentelemetry/exporter-metrics-otlp-http",
  "@opentelemetry/exporter-trace-otlp-http", "@opentelemetry/sdk-trace-base",
  "@opentelemetry/sdk-trace-node", "@opentelemetry/sdk-trace-web"
]
const browserAdapters = ["@smthrs/platform-browser", "@smthrs/platform-bun", "@effect/platform-bun"]
const absentByDefault = [...runners, ...nodeAdapters, ...telemetryAdapters, ...browserAdapters, "react", "tsx", "vite"]

// Explicit policy expectations; never derived from the manifest being tested.
export const minimalProfiles = ["database", "gateway", "observability", "flows", "create-app"].map((name) => ({
  name: name + "-default",
  dependencies: { ["@smthrs/" + name]: firstParty, effect },
  absent: absentByDefault,
  imports: ["@smthrs/" + name]
}))

export const adapterProfiles = [
  {
    name: "cli-default",
    dependencies: { "@smthrs/cli": firstParty, effect },
    required: ["@effect/platform-node", "@effect/sql-sqlite-node"],
    absent: [...runners, ...browserAdapters, ...telemetryAdapters],
    imports: ["@smthrs/cli"]
  },
  {
    name: "node",
    dependencies: {
      "@smthrs/flows": firstParty, "@smthrs/gateway": firstParty, "@smthrs/observability": firstParty,
      "@smthrs/platform-node": firstParty, "@effect/platform-node": effect, "@effect/sql-sqlite-node": effect, effect,
      "@opentelemetry/exporter-logs-otlp-http": "0.222.0", "@opentelemetry/exporter-metrics-otlp-http": "0.222.0",
      "@opentelemetry/exporter-trace-otlp-http": "0.222.0", "@opentelemetry/sdk-trace-base": "2.11.0",
      "@opentelemetry/sdk-trace-node": "2.11.0"
    },
    absent: [...runners, ...browserAdapters, "@opentelemetry/sdk-trace-web"],
    imports: ["@smthrs/flows/NodeRuntime", "@smthrs/gateway/node/NodeGateway", "@smthrs/observability/NodeOtel"]
  },
  {
    name: "browser",
    dependencies: { "@smthrs/observability": firstParty, "@smthrs/platform-browser": firstParty,
      "@opentelemetry/sdk-trace-base": "2.11.0", "@opentelemetry/sdk-trace-web": "2.11.0", effect },
    absent: [...runners, ...nodeAdapters, "@effect/platform-bun", "@smthrs/platform-bun",
      "@opentelemetry/sdk-trace-node", ...telemetryAdapters.slice(0, 3)],
    imports: ["@smthrs/observability/BrowserOtel", "@smthrs/platform-browser"]
  },
  {
    name: "bun",
    dependencies: { "@smthrs/platform-bun": firstParty, "@smthrs/platform-node": firstParty,
      "@effect/platform-bun": effect, "@effect/platform-node": effect, effect },
    absent: [...runners, ...telemetryAdapters, "@effect/sql-sqlite-node", "@smthrs/platform-browser"],
    imports: ["@smthrs/platform-bun", "@smthrs/platform-bun/BunFileSystem", "@smthrs/platform-bun/BunHost"]
  },
  {
    name: "create-app-testing",
    dependencies: { "@smthrs/create-app": firstParty, "@smthrs/testing": firstParty,
      "@effect/platform-node": effect, vitest: "4.1.9", effect },
    absent: ["@effect/platform-bun", "@smthrs/platform-bun", "@effect/sql-sqlite-node", ...telemetryAdapters],
    imports: [],
    vitest: true
  }
]

export const migrationProfiles = [
  {
    name: "migrate-scan",
    dependencies: { "@smthrs/migrate": firstParty, "@effect/platform-node": effect, effect,
      ["@typescript/typescript-" + process.platform + "-" + process.arch]: "7.0.2" },
    omitOptional: true,
    absent: [...runners, ...telemetryAdapters, ...browserAdapters, "@smthrs/agent", "@smthrs/engine",
      "@smthrs/harness", "@smthrs/registry", "@smthrs/flows", "@effect/sql-sqlite-node"],
    imports: ["@smthrs/migrate", "@smthrs/migrate/Inventory"]
  },
  {
    name: "migrate-apply",
    dependencies: { "@smthrs/migrate": firstParty, "@effect/platform-node": effect, effect },
    required: ["@smthrs/agent", "@smthrs/engine", "@smthrs/harness", "@smthrs/registry", "@smthrs/platform-node"],
    absent: [...runners, ...telemetryAdapters, ...browserAdapters, "@smthrs/flows", "@effect/sql-sqlite-node"],
    imports: ["@smthrs/migrate/flow/Command", "@smthrs/migrate/flow/MigrateFlow", "@smthrs/migrate/flow/Layers"]
  }
]

/** The shipped template must select every prerequisite its test helper needs. */
export const templateProfile = (directory, entries) => {
  const entry = entries.find((candidate) => candidate.name === "@smthrs/create-app")
  assert.ok(entry, "candidate has no create-app template")
  const manifest = JSON.parse(execFileSync("tar", ["-xOf", join(directory, entry.filename),
    "package/template/default/package.json"], { encoding: "utf8" }))
  return { name: "template-default", dependencies: { ...manifest.dependencies, ...manifest.devDependencies },
    imports: [], vitest: true }
}

/** Only walk package directories and their nested modules; symlinks are not copies. */
export const physicalPackages = (consumer) => {
  const packages = []
  const modules = (directory) => {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(directory, entry.name)
      if (entry.name === ".pnpm") {
        for (const store of readdirSync(path, { withFileTypes: true })) {
          if (store.isDirectory() && store.name !== "node_modules") modules(join(path, store.name, "node_modules"))
        }
      } else if (entry.name.startsWith("@")) {
        modules(path)
      } else if (!entry.name.startsWith(".")) {
        const manifestPath = join(path, "package.json")
        if (existsSync(manifestPath)) {
          packages.push({ manifest: JSON.parse(readFileSync(manifestPath, "utf8")), path: realpathSync(manifestPath) })
        }
        modules(join(path, "node_modules"))
      }
    }
  }
  modules(join(consumer, "node_modules"))
  return packages
}

export const assertConsumerTree = (consumer, profile) => {
  const installed = physicalPackages(consumer)
  const copies = installed.filter(({ manifest }) => manifest.name === "effect")
  assert.equal(copies.length, 1, profile.name + ": expected exactly one physical Effect copy")
  assert.equal(copies[0].manifest.version, effect)
  const names = new Set(installed.map(({ manifest }) => manifest.name))
  for (const name of profile.absent ?? []) assert.equal(names.has(name), false, profile.name + ": unrelated " + name + " installed")
  for (const name of [...Object.keys(profile.dependencies), ...(profile.required ?? [])]) {
    assert.equal(names.has(name), true, profile.name + ": missing selected dependency " + name)
  }
  const resolutions = []
  for (const { manifest, path } of installed) {
    if (manifest.name !== "effect" && !manifest.name.startsWith("@smthrs/") && !manifest.name.startsWith("@effect/")) continue
    if (manifest.name !== "effect" && !manifest.dependencies?.effect && !manifest.peerDependencies?.effect) continue
    const selected = realpathSync(createRequire(path).resolve("effect/package.json"))
    assert.equal(selected, copies[0].path, manifest.name + ": Effect resolution differs")
    assert.equal(relative(realpathSync(consumer), selected).startsWith(".."), false, "resolution escaped consumer")
    resolutions.push({ name: manifest.name, path, effect: selected })
  }
  assert.ok(resolutions.length > 0)
  return { count: installed.length, effectCopies: copies.map(({ path }) => path), resolutions }
}

/** Record actual exit status and exact command, including expected install refusals. */
export const consumerCommand = (command, args, cwd) => new Promise((resolveRun, reject) => {
  const started = Date.now()
  const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  child.stdout.on("data", (chunk) => { output += chunk })
  child.stderr.on("data", (chunk) => { output += chunk })
  child.once("error", reject)
  child.once("close", (exit, signal) => {
    console.log(JSON.stringify({ command, args, cwd, node: process.version, exit, signal, durationMs: Date.now() - started }))
    if (exit !== 0 || command.endsWith("/vitest")) console.log(output)
    resolveRun({ exit, signal, output })
  })
})

const successful = async (command, args, cwd) => {
  const result = await consumerCommand(command, args, cwd)
  assert.equal(result.exit, 0, command + " " + args.join(" ") + "\n" + result.output)
  return result
}

export const runConsumerProfile = async (profile, manager, registryUrl, { runtime = false } = {}) => {
  const consumer = await mkdtemp(join(tmpdir(), "smithers-k-consumer-" + manager + "-" + profile.name + "-"))
  try {
    await writeFile(join(consumer, ".npmrc"), "@smthrs:registry=" + registryUrl + "\n")
    await writeFile(join(consumer, "package.json"), JSON.stringify({
      name: "dependency-profile", version: "1.0.0", private: true, type: "module", dependencies: profile.dependencies
    }))
    const args = ["install", "--ignore-scripts", ...(manager === "npm" ? ["--no-audit", "--no-fund", "--strict-peer-deps"] : ["--strict-peer-dependencies"])]
    if (profile.omitOptional) args.push(manager === "npm" ? "--omit=optional" : "--no-optional")
    await successful(manager, args, consumer)
    const tree = assertConsumerTree(consumer, profile)
    if (runtime) {
      await writeFile(join(consumer, "dependency-resolutions.json"), JSON.stringify(tree.resolutions))
      for (const mode of ["esm", "cjs"]) {
        const source = mode === "esm"
          ? "for (const name of " + JSON.stringify(profile.imports) + ") await import(name)"
          : "for (const name of " + JSON.stringify(profile.imports) + ") require(name)"
        await successful(process.execPath, [...(mode === "esm" ? ["--input-type=module"] : []), "--eval", source], consumer)
      }
      const fixture = resolve(import.meta.dirname, "dependency-adapters.mjs")
      await writeFile(join(consumer, "dependency-adapters.mjs"), await readFile(fixture))
      await successful(process.execPath, ["dependency-adapters.mjs", profile.name], consumer)
      if (profile.name === "browser") {
        await bundle({ absWorkingDir: consumer, bundle: true, platform: "browser", write: false, logLevel: "silent",
          stdin: { contents: 'import * as BrowserOtel from "@smthrs/observability/BrowserOtel"; globalThis.adapter = BrowserOtel',
            resolveDir: consumer } })
      }
      if (profile.name === "bun") await successful("bun", ["dependency-adapters.mjs", profile.name], consumer)
      if (profile.vitest) {
        await writeFile(join(consumer, "adapter.test.mjs"), await readFile(resolve(import.meta.dirname, "dependency-testing.mjs")))
        await successful(join(consumer, "node_modules/.bin/vitest"), ["run", "adapter.test.mjs", "--maxWorkers=1"], consumer)
      }
    }
    console.log("consumer ok " + manager + " " + profile.name + ": " + tree.count + " packages; one Effect; " + (profile.absent?.length ?? 0) + " absent adapters")
    return { manager, profile: profile.name, ...tree }
  } finally {
    await rm(consumer, { recursive: true, force: true })
  }
}

export const refuseIncompatibleRc = async (manager, registryUrl) => {
  const consumer = await mkdtemp(join(tmpdir(), "smithers-k-incompatible-" + manager + "-"))
  try {
    await writeFile(join(consumer, ".npmrc"), "@smthrs:registry=" + registryUrl + "\n")
    // Adjacent published RC, deliberately incompatible with the exact library peer.
    await writeFile(join(consumer, "package.json"), JSON.stringify({
      private: true, dependencies: { "@smthrs/database": firstParty, effect: "4.0.0-rc.111" }
    }))
    const result = await consumerCommand(manager, ["install", "--ignore-scripts",
      ...(manager === "npm" ? ["--strict-peer-deps", "--no-audit", "--no-fund"] : ["--strict-peer-dependencies"])], consumer)
    assert.notEqual(result.exit, 0, "incompatible RC must be refused")
    assert.equal(result.signal, null)
    assert.match(result.output, manager === "npm" ? /ERESOLVE/ : /ERR_PNPM_PEER_DEP_ISSUES/)
    assert.match(result.output, /4\.0\.0-rc\.112/)
    assert.match(result.output, /4\.0\.0-rc\.111/)
    return { manager, exit: result.exit }
  } finally {
    await rm(consumer, { recursive: true, force: true })
  }
}

export const runConsumerMatrix = async (directory, entries, {
  profiles = minimalProfiles, managers = ["npm", "pnpm"], runtime = false
} = {}) => {
  const registry = await releaseRegistry(directory, entries)
  const results = []
  const failures = []
  try {
    for (const manager of managers) {
      for (const profile of profiles) {
        try {
          results.push(await runConsumerProfile(profile, manager, registry.url, { runtime }))
        } catch (cause) {
          const error = new Error(manager + " " + profile.name + ": " + cause.message, { cause })
          failures.push(error)
          console.error(error.message)
        }
      }
      try {
        results.push({ incompatible: await refuseIncompatibleRc(manager, registry.url) })
      } catch (cause) {
        failures.push(new Error(manager + " incompatible RC: " + cause.message, { cause }))
      }
    }
    console.log(JSON.stringify({ consumerMatrix: {
      profilesPassed: results.filter((result) => result.profile !== undefined).length,
      incompatibleRefusals: results.filter((result) => result.incompatible !== undefined).length,
      failures: failures.length
    }, node: process.version }))
    if (failures.length) throw new AggregateError(failures, failures.length + " consumer profiles failed")
    return results
  } finally {
    await registry.close()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = resolve(process.argv[2])
  const entries = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"))
  await runConsumerMatrix(directory, entries, {
    profiles: [...minimalProfiles, ...adapterProfiles, ...migrationProfiles, templateProfile(directory, entries)], runtime: true
  })
}
