import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TargetRunFrame } from "smithers-shared/LocalApp"
import type { SandboxHost } from "./Sandbox"
import { createTargetRunner, mapTargets, queryTargets, resolveBuildCli, runTopic, sandboxPathsFor } from "./Targets"

/*
 * Target JSON mapping and the loader/run seams (LOCAL-APP.md "Targets: load
 * and run") over a fake build-cli script, so no workspace and no sandbox
 * are needed: the mapping is pure, the query turns loader failures into
 * warnings, and the runner streams stdout/stderr/exit to the run's topic.
 */

const directories: Array<string> = []
afterAll(async () => {
  await Promise.all(directories.map((dir) => rm(dir, { recursive: true, force: true })))
})

const scratch = async (): Promise<string> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "smithers-targets-")))
  directories.push(dir)
  return dir
}

/** Bun runs the fake CLI in place of node; the sandbox is off so the host does not matter. */
const bunSidecar = { path: process.execPath, version: "v22.19.0" }
const noSandbox: SandboxHost = { platform: "linux", disabled: true, log: () => {} }

const LISTING = JSON.stringify({
  query: "//...",
  targets: [
    { label: "//src:lint", target: "Shell.Test", kinds: ["test", "lint"] },
    { label: "//:detectSecrets", target: "Shell.Test", kinds: ["test"] },
    { label: "//src/Apps/Auction:srcs", target: "Filegroup", kinds: ["build"] }
  ]
})

describe("mapTargets", () => {
  test("maps the loader listing 1:1 and splits labels into package and name", () => {
    const mapped = mapTargets(LISTING)
    expect("targets" in mapped && mapped.targets).toEqual([
      { label: "//src:lint", target: "Shell.Test", kinds: ["test", "lint"], package: "//src", name: "lint" },
      { label: "//:detectSecrets", target: "Shell.Test", kinds: ["test"], package: "//", name: "detectSecrets" },
      { label: "//src/Apps/Auction:srcs", target: "Filegroup", kinds: ["build"], package: "//src/Apps/Auction", name: "srcs" }
    ])
  })

  test("a loader error envelope and non-JSON both become messages", () => {
    expect(mapTargets(JSON.stringify({ code: "query_failed", message: "boom" }))).toEqual({
      error: "query_failed: boom"
    })
    const bad = mapTargets("not json")
    expect("error" in bad && bad.error).toContain("did not answer JSON")
    expect(mapTargets(JSON.stringify({ targets: [{ nope: 1 }, { label: "//a:b" }] }))).toEqual({
      targets: [{ label: "//a:b", target: "", kinds: [], package: "//a", name: "b" }]
    })
  })
})

describe("resolveBuildCli and sandbox paths", () => {
  test("SMITHERS_BUILD_CLI wins, else packages/build-cli/src/main.js from the checkout", () => {
    expect(resolveBuildCli({ SMITHERS_BUILD_CLI: "/x/main.js" }, "/ignored")).toBe("/x/main.js")
    expect(resolveBuildCli({}, "/repo/apps/ui/src/bun", () => false)).toBe("/repo/packages/build-cli/src/main.js")
  })

  test("from inside an Electrobun bundle the loader is the nearest one above the bundle", () => {
    const checkout = "/repo/packages/build-cli/src/main.js"
    const bundled = "/repo/apps/ui/build/dev-macos-arm64/Smithers-dev.app/Contents/Resources/app/bun"
    expect(resolveBuildCli({}, bundled, (path) => path === checkout)).toBe(checkout)
    expect(resolveBuildCli({}, "/repo/apps/ui/src/bun", (path) => path === checkout)).toBe(checkout)
  })

  test("the loader policy gets the repository, home, and a real temp dir", () => {
    const paths = sandboxPathsFor("/work/force")
    expect(paths.repo).toBe("/work/force")
    expect(paths.home).not.toBe("")
    expect(paths.tmpdir.startsWith("/")).toBe(true)
  })
})

describe("queryTargets", () => {
  test("no Node sidecar is a warning and an empty list", async () => {
    const result = await queryTargets({ repo: "/tmp", node: null, cli: "/nope/main.js" })
    expect(result.targets).toEqual([])
    expect(result.warnings[0]).toContain("No Node.js")
  })

  test("a missing loader is a warning, never a throw", async () => {
    const result = await queryTargets({ repo: "/tmp", node: bunSidecar, cli: "/nope/main.js", sandboxHost: noSandbox })
    expect(result.targets).toEqual([])
    expect(result.warnings[0]).toContain("missing at /nope/main.js")
  })

  test("the loader's listing maps to targets with the repo as cwd", async () => {
    const dir = await scratch()
    const cli = join(dir, "fake-cli.js")
    await writeFile(
      cli,
      `if (process.argv[2] !== "query") { console.log("not a query"); process.exit(2) }\nconsole.log(${
        JSON.stringify(LISTING)
      }.replace("//...", process.cwd()))`
    )
    const result = await queryTargets({ repo: dir, node: bunSidecar, cli, sandboxHost: noSandbox })
    expect(result.warnings).toEqual([])
    expect(result.targets.map((target) => target.label)).toEqual(["//src:lint", "//:detectSecrets", "//src/Apps/Auction:srcs"])
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  test("a loader failure is warnings and an empty list", async () => {
    const dir = await scratch()
    const cli = join(dir, "failing-cli.js")
    await writeFile(
      cli,
      "console.log(JSON.stringify({ code: \"query_failed\", message: \"WORKSPACE.ts: boom\" }))\nconsole.error(\"loader stderr\")\nprocess.exit(1)"
    )
    const result = await queryTargets({ repo: dir, node: bunSidecar, cli, sandboxHost: noSandbox })
    expect(result.targets).toEqual([])
    expect(result.warnings[0]).toBe("The loader exited 1: query_failed: WORKSPACE.ts: boom")
    expect(result.warnings[1]).toBe("loader stderr")
  })
})

describe("createTargetRunner", () => {
  const collect = (): {
    readonly frames: Array<{ topic: string; runId: string; frame: TargetRunFrame }>
    readonly publish: (topic: string, message: unknown) => void
    readonly exited: (runId: string) => Promise<void>
  } => {
    const frames: Array<{ topic: string; runId: string; frame: TargetRunFrame }> = []
    const waiters = new Map<string, () => void>()
    return {
      frames,
      publish: (topic, message) => {
        const envelope = message as { runId: string; frame: TargetRunFrame }
        frames.push({ topic, runId: envelope.runId, frame: envelope.frame })
        if (envelope.frame.type === "exit") waiters.get(envelope.runId)?.()
      },
      exited: (runId) =>
        new Promise((resolve) => {
          if (frames.some((entry) => entry.runId === runId && entry.frame.type === "exit")) resolve()
          else waiters.set(runId, resolve)
        })
    }
  }

  test("attach starts the child; stdout, stderr and the exit code stream to the topic", async () => {
    const dir = await scratch()
    const cli = join(dir, "run-cli.js")
    await writeFile(
      cli,
      "console.log(`ran ${process.argv[2]} in ${process.cwd()}`)\nconsole.error(\"progress line\")\nprocess.exit(3)"
    )
    const sink = collect()
    const runner = createTargetRunner({ publish: sink.publish, cli, autoStartMs: 60_000 })
    const run = runner.start({ repoId: "r1", repo: dir, label: "//src:lint", node: bunSidecar })
    expect(run.status).toBe("pending")
    expect(runner.attach(run.runId)).toBe(true)
    await sink.exited(run.runId)
    const own = sink.frames.filter((entry) => entry.runId === run.runId)
    expect(own.every((entry) => entry.topic === runTopic(run.runId))).toBe(true)
    const stdout = own.filter((entry) => entry.frame.type === "stdout").map((entry) => (entry.frame as { data: string }).data).join("")
    const stderr = own.filter((entry) => entry.frame.type === "stderr").map((entry) => (entry.frame as { data: string }).data).join("")
    expect(stdout).toBe(`ran //src:lint in ${dir}\n`)
    expect(stderr).toBe("progress line\n")
    /* Every published frame carries the run-local seq replay orders by. */
    expect(own.map((entry) => (entry.frame as { seq?: number }).seq)).toEqual(own.map((_entry, index) => index))
    expect(own[own.length - 1]?.frame).toMatchObject({ type: "exit", code: 3, seq: own.length - 1 })
    expect(own.map((entry) => entry.frame.seq)).toEqual(own.map((_, index) => index))
    expect(runner.get(run.runId)).toMatchObject({ status: "failed", exitCode: 3 })
    expect(runner.attach("nope")).toBe(false)
    runner.stop()
  })

  test("a run nobody attaches to starts on its own", async () => {
    const dir = await scratch()
    const cli = join(dir, "auto-cli.js")
    await writeFile(cli, "console.log(\"auto\")")
    const sink = collect()
    const runner = createTargetRunner({ publish: sink.publish, cli, autoStartMs: 10 })
    const run = runner.start({ repoId: "r1", repo: dir, label: "//:x", node: bunSidecar })
    await sink.exited(run.runId)
    expect(runner.get(run.runId)).toMatchObject({ status: "done", exitCode: 0 })
    runner.stop()
  })

  test("cancelling a pending run reports it without spawning", async () => {
    const dir = await scratch()
    const sink = collect()
    const runner = createTargetRunner({ publish: sink.publish, cli: join(dir, "never.js"), autoStartMs: 60_000 })
    const run = runner.start({ repoId: "r1", repo: dir, label: "//:x", node: bunSidecar })
    expect(runner.cancel(run.runId)).toBe(true)
    expect(sink.frames.map((entry) => entry.frame)).toEqual([
      { type: "error", message: "Cancelled before it started.", seq: 0 },
      { type: "exit", code: null, seq: 1 }
    ])
    expect(runner.cancel(run.runId)).toBe(false)
    expect(runner.cancel("nope")).toBe(false)
    runner.stop()
  })
})
