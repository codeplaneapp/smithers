/**
 * Package-mode execution of the resolver, bundler, and service lanes through
 * the real CLI against real processes:
 *
 * - services: a consumer acquires its Serve target (readiness gated), runs
 *   raced against the service's health, and releases it on success, on
 *   failure, and on a readiness timeout; a Serve root runs foreground until
 *   interrupted; Serve targets are never scheduled as ordinary nodes.
 * - closure keying: a Shell.Test keyed on an ImportClosure re-keys when a
 *   file inside the closure changes and stays a hit when a file outside it
 *   changes; S.Test over Files.difference reports the leftover set, caches
 *   its verdict, and fails closed on a dynamic import.
 * - bundler: resolve and build through the workspace's own rsbuild, the
 *   build keyed on the resolved graph digest (a universe edit that leaves
 *   the graph unchanged replays the build).
 */
import * as NodeChildProcess from "node:child_process"
import { existsSync } from "node:fs"
import * as Fs from "node:fs/promises"
import * as NodeNet from "node:net"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { makeCli, normalizeArgv } from "../src/Cli.ts"
import { graphKeySentinel, keyMaterialWithGraph } from "../src/PackageExec.ts"

/** Temp directories this file created; removed after the suite so a run leaves nothing in the OS temp dir. */
const temporaryDirectories: Array<string> = []
const tracked = async (directory: Promise<string>): Promise<string> => {
  const resolved = await directory
  temporaryDirectories.push(resolved)
  return resolved
}
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const fixtureServer = NodePath.resolve(import.meta.dirname, "fixtures/service-supervisor/server.mjs")
const rsbuildFixture = NodePath.resolve(import.meta.dirname, "fixtures/rsbuild-mini")

const write = async (root: string, relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

const workspaceModule = (): string =>
  `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
})
`

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" })

const commitAll = (root: string): void => {
  git(root, "init", "-q")
  git(root, "add", "-A")
  git(root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")
}

const temporaryWorkspace = async (): Promise<string> =>
  tracked(Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-lane-exec-"))))

/** Serves one command against a workspace, capturing exit code and output. */
const serve = async (
  root: string,
  args: ReadonlyArray<string>,
  live: { readonly signal?: AbortSignal; readonly onLog?: (line: string) => void } = {}
): Promise<{ readonly exitCode: number; readonly output: string; readonly logs: string }> => {
  let exitCode = 0
  let output = ""
  let logs = ""
  const errWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    logs += text
    live.onLog?.(text)
    return true
  }) as typeof process.stderr.write
  try {
    await makeCli({ signal: live.signal }).serve([...normalizeArgv(args), "--workspace", root], {
      exit: (code) => {
        exitCode = code
      },
      stdout: (text) => {
        output += text
      }
    })
  } finally {
    process.stderr.write = errWrite
  }
  return { exitCode, output, logs }
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = NodeNet.createServer()
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("no port assigned")))
        return
      }
      probe.close(() => resolve(address.port))
    })
    probe.on("error", reject)
  })

const portOpen = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = NodeNet.connect({ host: "127.0.0.1", port })
    socket.on("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.on("error", () => resolve(false))
  })

const waitFor = async (predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`condition not reached within ${timeoutMs}ms`)
}

/** Pids of live processes whose command line carries the marker. */
const pgrep = (marker: string): Array<number> => {
  try {
    return NodeChildProcess.execFileSync("pgrep", ["-f", marker], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map(Number)
  } catch {
    return []
  }
}

const marker = (): string => `lane-exec-${process.pid}-${Math.random().toString(36).slice(2)}`

/** A node one-liner that GETs one URL and exits 0 on a 2xx answer. */
const probeCommand = (url: string): string =>
  `${process.execPath} -e "fetch('${url}').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"`

/** A fixture-server Serve declaration; `extra` joins the server's argv. */
const serveDeclaration = (port: number, mark: string, extra: string, probes: string): string =>
  `S.Shell.Serve({
  command: ${JSON.stringify(`${process.execPath} ${fixtureServer} --port ${port} --marker ${mark} ${extra}`)},
  ${probes}
})`

describe("services edge", () => {
  it("acquires the service before the consumer, gates on readiness, and releases it after success", async () => {
    const root = await temporaryWorkspace()
    const port = await freePort()
    const mark = marker()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const svc = ${serveDeclaration(port, mark, "--delay-listen 500", `readiness: { port: ${port} }`)}
const probe = S.Shell.Test({ command: ${
        JSON.stringify(probeCommand(`http://127.0.0.1:${port}/health`))
      }, services: [svc] })
export const Package = S.Package({ targets: { svc, probe } })
`
    )
    commitAll(root)
    const started = Date.now()
    const { exitCode, logs } = await serve(root, ["//:probe"])
    expect(logs).toContain("//:probe  service //:svc: ready")
    expect(logs).toContain("//:probe  ran")
    expect(exitCode).toBe(0)
    // The server delayed listen by 500ms; the probe only passed because
    // acquisition waited for readiness.
    expect(Date.now() - started).toBeGreaterThanOrEqual(400)
    await waitFor(async () => pgrep(mark).length === 0, 10_000)
  }, 60_000)

  it("releases the service when the consumer fails", async () => {
    const root = await temporaryWorkspace()
    const port = await freePort()
    const mark = marker()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const svc = ${serveDeclaration(port, mark, "", `readiness: { port: ${port} }`)}
const probe = S.Shell.Test({ command: "exit 3", services: [svc] })
export const Package = S.Package({ targets: { svc, probe } })
`
    )
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//:probe"])
    expect(exitCode).toBe(1)
    expect(logs).toContain("//:probe  service //:svc: ready")
    expect(logs).toContain("//:probe  failed")
    expect(logs).toContain("exit 3")
    await waitFor(async () => pgrep(mark).length === 0, 10_000)
  }, 60_000)

  it("fails the consumer with a typed readiness timeout carrying the tail, and tears the service down", async () => {
    const root = await temporaryWorkspace()
    const port = await freePort()
    const mark = marker()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const svc = ${
        serveDeclaration(
          port,
          mark,
          "--delay-listen 30000",
          `readiness: { http: "http://127.0.0.1:${port}/health", timeout: "1s" }`
        )
      }
const probe = S.Shell.Test({ command: "true", services: [svc] })
export const Package = S.Package({ targets: { svc, probe } })
`
    )
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//:probe"])
    expect(exitCode).toBe(1)
    expect(logs).toContain("//:probe  failed")
    expect(logs).toContain("service //:svc readiness-timeout")
    expect(logs).toContain("was not ready within 1000ms")
    expect(logs).not.toContain("//:probe  service //:svc: ready")
    await waitFor(async () => pgrep(mark).length === 0, 10_000)
  }, 60_000)

  it("fails a running consumer when the service turns unhealthy, killing the consumer", async () => {
    const root = await temporaryWorkspace()
    const port = await freePort()
    const mark = marker()
    const consumerMark = marker()
    await write(root, "WORKSPACE.ts", workspaceModule())
    // The consumer wedges the server (every later /health answers 500) and
    // then sleeps far longer than the health contract takes to trip.
    const consumer =
      `${process.execPath} -e "fetch('http://127.0.0.1:${port}/wedge').then(() => setTimeout(() => {}, 60000))" ${consumerMark}`
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const svc = ${
        serveDeclaration(
          port,
          mark,
          "",
          `readiness: { http: "http://127.0.0.1:${port}/health", timeout: "10s" },
  health: { interval: "150ms", failures: 2 }`
        )
      }
const probe = S.Shell.Test({ command: ${JSON.stringify(consumer)}, services: [svc] })
export const Package = S.Package({ targets: { svc, probe } })
`
    )
    commitAll(root)
    const started = Date.now()
    const { exitCode, logs } = await serve(root, ["//:probe"])
    expect(exitCode).toBe(1)
    expect(Date.now() - started).toBeLessThan(30_000)
    expect(logs).toContain("//:probe  failed")
    expect(logs).toContain("service //:svc unhealthy")
    expect(logs).toContain("2 consecutive health probes")
    expect(logs).toContain("answered 500")
    expect(logs).toContain("wedged: answering 500 from now on")
    await waitFor(async () => pgrep(mark).length === 0 && pgrep(consumerMark).length === 0, 15_000)
  }, 90_000)

  it("runs a Serve root in the foreground until interrupted, then applies the stop contract", async () => {
    const root = await temporaryWorkspace()
    const port = await freePort()
    const mark = marker()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const svc = ${
        serveDeclaration(port, mark, "", `readiness: { port: ${port} }, stop: { signal: "SIGTERM", grace: "5s" }`)
      }
export const Package = S.Package({ targets: { svc } })
`
    )
    commitAll(root)
    const controller = new AbortController()
    let ready = false
    const running = serve(root, ["//:svc"], {
      signal: controller.signal,
      onLog: (line) => {
        if (line.includes("//:svc  ready (pid")) ready = true
      }
    })
    await waitFor(async () => ready, 15_000)
    expect(await portOpen(port)).toBe(true)
    expect(pgrep(mark).length).toBeGreaterThan(0)
    controller.abort(new Error("smithers build interrupted by SIGINT"))
    const { exitCode, logs } = await running
    expect(logs).toContain("//:svc  ready (pid")
    expect(logs).toContain("//:svc  stopped")
    expect(exitCode).toBe(1)
    await waitFor(async () => pgrep(mark).length === 0, 10_000)
    expect(await portOpen(port)).toBe(false)
  }, 60_000)

  it("never schedules a Serve target as an ordinary node; its data edges hoist onto the consumer", async () => {
    const root = await temporaryWorkspace()
    const port = await freePort()
    const mark = marker()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(root, "assets/a.txt", "a")
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const assets = S.Filegroup({ srcs: S.glob(["assets/**"]) })
const svc = ${serveDeclaration(port, mark, "", `readiness: { port: ${port} }, data: [assets]`)}
const probe = S.Shell.Test({ command: "true", services: [svc] })
export const Package = S.Package({ targets: { assets, svc, probe } })
`
    )
    commitAll(root)
    const { exitCode, output } = await serve(root, ["//:probe", "--plan"])
    expect(exitCode).toBe(0)
    // The consumer's execution edges name the service's data producer, not
    // the service; the plan never lists the service as work.
    expect(output).toMatch(/label: "\/\/:probe"[\s\S]*?dependencies\[1\]: "\/\/:assets"/)
    expect(output).toContain("label: \"//:assets\"")
    expect(output).not.toContain("\"//:svc\"")
    expect(pgrep(mark)).toHaveLength(0)
  }, 60_000)
})

describe("closure keying", () => {
  it("keys a Shell.Test on the resolved closure: an edit inside re-keys, an edit outside stays a hit", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(root, "src/a.ts", `import { b } from "./b"\nexport const a = b + 1\n`)
    await write(root, "src/b.ts", `export const b = 1\n`)
    await write(root, "src/unrelated.ts", `export const u = 1\n`)
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const closure = S.ImportClosure({ entries: S.glob(["src/a.ts"]) })
const t = S.Shell.Test({ command: "true", data: [closure] })
export const Package = S.Package({ targets: { closure, t } })
`
    )
    commitAll(root)
    const first = await serve(root, ["//:t"])
    expect(first.exitCode).toBe(0)
    expect(first.logs).toContain("//:closure  closure: 2 files, 0 packages, 0 unresolved, 0 dynamic")
    expect(first.logs).toContain("//:t  ran")
    const second = await serve(root, ["//:t"])
    expect(second.logs).toContain("//:t  hit")
    await write(root, "src/b.ts", `export const b = 2\n`)
    const inside = await serve(root, ["//:t"])
    expect(inside.logs).toContain("//:t  ran")
    await write(root, "src/unrelated.ts", `export const u = 2\n`)
    const outside = await serve(root, ["//:t"])
    expect(outside.logs).toContain("//:t  hit")
  }, 60_000)

  it(
    "checks Files.difference against a closure: leftover named, verdict cached, dynamic import fails closed",
    async () => {
      const root = await temporaryWorkspace()
      await write(root, "WORKSPACE.ts", workspaceModule())
      await write(root, "src/a.ts", `import { b } from "./b"\nexport const a = b + 1\n`)
      await write(root, "src/b.ts", `export const b = 1\n`)
      await write(root, "src/unrelated.ts", `export const u = 1\n`)
      await write(
        root,
        "PACKAGE.ts",
        `import { Smithers as S } from "@smthrs/targets"
const srcs = S.Filegroup({ srcs: S.glob(["src/**"]) })
const closure = S.ImportClosure({ entries: S.glob(["src/a.ts"]) })
const dead = S.Test({ expect: S.Files.difference(srcs, closure.files), toBe: "empty" })
export const Package = S.Package({ targets: { srcs, closure, dead } })
`
      )
      commitAll(root)
      const red = await serve(root, ["//:dead"])
      expect(red.exitCode).toBe(1)
      expect(red.logs).toContain("//:dead  failed")
      expect(red.logs).toContain("1 of 3 file(s) in the left set are missing from the right set")
      expect(red.logs).toContain("leftover: src/unrelated.ts")
      await Fs.rm(NodePath.join(root, "src/unrelated.ts"))
      const green = await serve(root, ["//:dead"])
      expect(green.exitCode).toBe(0)
      expect(green.logs).toContain("//:dead  difference empty: 2 left, 2 right")
      expect(green.logs).toContain("//:dead  ran")
      const again = await serve(root, ["//:dead"])
      expect(again.logs).toContain("//:dead  hit")
      await write(root, "src/a.ts", `import { b } from "./b"\nexport const a = () => import(b ? "./x" : "./y")\n`)
      const closed = await serve(root, ["//:dead"])
      expect(closed.exitCode).toBe(1)
      expect(closed.logs).toContain("fails closed")
      expect(closed.logs).toContain("dynamic: src/a.ts ->")
    },
    60_000
  )
})

describe("bundler build key template", () => {
  it("substitutes the graph key into the attrs reference and the dependency row", () => {
    const template = {
      body: { target: "Bundler.Rspack.build" },
      inputs: {
        attrs: { graph: { _tag: "Target", key: graphKeySentinel }, environment: "web" },
        dependencies: [{ label: "//:graph", key: graphKeySentinel }, { label: "//:cfg", key: "abc" }],
        toolchain: []
      },
      layers: [],
      capabilities: ["fs:read"]
    }
    const substituted = keyMaterialWithGraph(template, "bundler-graph:deadbeef")
    expect(substituted.inputs).toEqual({
      attrs: { graph: { _tag: "Target", key: "bundler-graph:deadbeef" }, environment: "web" },
      dependencies: [{ label: "//:graph", key: "bundler-graph:deadbeef" }, { label: "//:cfg", key: "abc" }],
      toolchain: []
    })
    // The template itself is untouched.
    expect((template.inputs.dependencies[0] as { readonly key: string }).key).toBe(graphKeySentinel)
  })
})

/**
 * A node_modules tree that provides @rsbuild/core; the e2e snapshot of the
 * force workspace by default. Without one the bundler dispatch cases skip
 * loudly rather than faking green.
 */
const modulesSource = process.env["SMTHRS_RSBUILD_MODULES"] ?? "/Users/williamcory/artsy-e2e/force/node_modules"
const rsbuildAvailable = existsSync(NodePath.join(modulesSource, "@rsbuild", "core"))
if (!rsbuildAvailable) {
  console.warn(
    `bundler dispatch tests SKIPPED: no @rsbuild/core under ${modulesSource}; ` +
      "set SMTHRS_RSBUILD_MODULES to a node_modules directory that has it"
  )
}

describe.runIf(rsbuildAvailable)("bundler dispatch", () => {
  it("resolves and builds through the workspace bundler, keyed on the graph digest", async () => {
    const root = await temporaryWorkspace()
    await Fs.cp(rsbuildFixture, root, { recursive: true })
    await Fs.symlink(modulesSource, NodePath.join(root, "node_modules"), "dir")
    await write(root, ".gitignore", "node_modules\ndist\n.flows\n")
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const srcs = S.Filegroup({ srcs: S.glob(["src/**"]) })
const rspack = S.Bundler.Rspack({ config: S.file("//rsbuild.config.mjs") })
const graph = rspack.resolve({ entries: ["main.ts"], universe: [srcs] })
const build = rspack.build({ environment: "web", mode: "development", graph, outDirs: ["dist"] })
const dead = S.Test({ expect: S.Files.difference(srcs, graph.files), toBe: "empty" })
export const Package = S.Package({ targets: { srcs, graph, build, dead } })
`
    )
    commitAll(root)
    const first = await serve(root, ["//:build"])
    expect(first.logs).toContain("//:graph  ran")
    expect(first.logs).toMatch(/\/\/:graph {2}graph: \d+ modules, 2 workspace files, 0 packages/)
    expect(first.logs).toContain("//:build  ran")
    expect(first.exitCode).toBe(0)
    const bundle = await Fs.readFile(NodePath.join(root, "dist", "static", "js", "index.js"), "utf8")
    expect(bundle).toContain("rsbuild-mini")

    // Warm: both replay. The build's execution key carried the graph digest
    // on the cold run too, so the digest-keyed plan of the warm run hits.
    const second = await serve(root, ["//:build"])
    expect(second.logs).toContain("//:graph  hit")
    expect(second.logs).toContain("//:build  hit")

    // A universe edit that leaves the resolved graph unchanged re-resolves
    // (the resolve keys on the universe) but replays the build (keyed on the
    // graph digest): the caching win the spec names.
    await write(root, "src/extra.ts", `export const extra = 1\n`)
    const third = await serve(root, ["//:build"])
    expect(third.logs).toContain("//:graph  ran")
    expect(third.logs).toContain("//:build  hit")

    // The unreached file is exactly the difference the dead-code test reports.
    const dead = await serve(root, ["//:dead"])
    expect(dead.exitCode).toBe(1)
    expect(dead.logs).toContain("leftover: src/extra.ts")

    // An edit inside the graph changes the digest and re-keys the build.
    await write(root, "src/dep.ts", `export const greet = (name: string): string => \`hi \${name}\`\n`)
    const fourth = await serve(root, ["//:build"])
    expect(fourth.logs).toContain("//:graph  ran")
    expect(fourth.logs).toContain("//:build  ran")
    expect(await Fs.readFile(NodePath.join(root, "dist", "static", "js", "index.js"), "utf8")).toContain("hi ")
  }, 600_000)
})
