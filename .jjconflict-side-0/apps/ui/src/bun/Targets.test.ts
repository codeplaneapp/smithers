import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import type { TargetRunFrame } from "@smthrs/rpc/LocalApp"
import type { SandboxHost } from "./Sandbox"
import {
  buildCliNodePath,
  createTargetRunner,
  mapTargets,
  queryTargets,
  resolveBuildCli,
  runTopic,
  sandboxPathsFor
} from "./Targets"

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
    { label: "//src:lint", target: "Shell.Test", kinds: ["test", "lint"], summary: "Lint the sources.", featured: true },
    { label: "//:detectSecrets", target: "Shell.Test", kinds: ["test"] },
    { label: "//src/Apps/Auction:srcs", target: "Filegroup", kinds: ["build"] }
  ]
})

describe("mapTargets", () => {
  test("maps the loader listing 1:1, splits labels into package and name, tags the workspace, and keeps the declared presentation", () => {
    const mapped = mapTargets(LISTING, ".")
    expect("targets" in mapped && mapped.targets).toEqual([
      { label: "//src:lint", target: "Shell.Test", kinds: ["test", "lint"], package: "//src", name: "lint", workspace: ".", summary: "Lint the sources.", featured: true },
      { label: "//:detectSecrets", target: "Shell.Test", kinds: ["test"], package: "//", name: "detectSecrets", workspace: "." },
      { label: "//src/Apps/Auction:srcs", target: "Filegroup", kinds: ["build"], package: "//src/Apps/Auction", name: "srcs", workspace: "." }
    ])
    const nested = mapTargets(LISTING, "aomi-sdk")
    expect("targets" in nested && nested.targets.every((target) => target.workspace === "aomi-sdk")).toBe(true)
  })

  test("a loader error envelope and non-JSON both become messages", () => {
    expect(mapTargets(JSON.stringify({ code: "query_failed", message: "boom" }), ".")).toEqual({
      error: "query_failed: boom"
    })
    const bad = mapTargets("not json", ".")
    expect("error" in bad && bad.error).toContain("did not answer JSON")
    expect(mapTargets(JSON.stringify({ targets: [{ nope: 1 }, { label: "//a:b" }] }), ".")).toEqual({
      targets: [{ label: "//a:b", target: "", kinds: [], package: "//a", name: "b", workspace: "." }]
    })
  })
})

describe("resolveBuildCli and sandbox paths", () => {
  test("SMITHERS_BUILD_CLI wins, else packages/smithers/build/build-cli/src/main.js from the checkout", () => {
    expect(resolveBuildCli({ SMITHERS_BUILD_CLI: "/x/main.js" }, "/ignored")).toBe("/x/main.js")
    const packaged = "/Applications/Smithers.app/Contents/Resources/app/build-cli/launcher.mjs"
    expect(resolveBuildCli({}, "/Applications/Smithers.app/Contents/Resources/app/bun", (path) => path === packaged))
      .toBe(packaged)
    expect(resolveBuildCli({}, "/repo/apps/ui/src/bun", () => false)).toBe("/repo/packages/smithers/build/build-cli/src/main.js")
  })

  test("from inside an Electrobun bundle the loader is the nearest one above the bundle", () => {
    const checkout = "/repo/packages/smithers/build/build-cli/src/main.js"
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

  test("a packaged CLI exposes its shipped authoring packages as a final Node fallback", () => {
    const cli = "/Applications/Smithers.app/Contents/Resources/app/build-cli/launcher.mjs"
    const nodeModules = "/Applications/Smithers.app/Contents/Resources/app/build-cli/node_modules"
    const manifest = `${nodeModules}/@smthrs/targets/package.json`
    expect(buildCliNodePath(cli, undefined, (path) => path === manifest)).toBe(nodeModules)
    expect(buildCliNodePath(cli, "/workspace/node_modules", (path) => path === manifest))
      .toBe(`${nodeModules}${delimiter}/workspace/node_modules`)
    expect(buildCliNodePath(cli, "/workspace/node_modules", () => false)).toBe("/workspace/node_modules")
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
    expect(result.targets.every((target) => target.workspace === ".")).toBe(true)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  test("fans out once per workspace: each loader runs at its own cwd, one failure cannot block the others", async () => {
    const dir = await scratch()
    await mkdir(join(dir, "ok"))
    await mkdir(join(dir, "broken"))
    const cli = join(dir, "fanout-cli.js")
    await writeFile(
      cli,
      [
        "const cwd = process.cwd()",
        "if (cwd.endsWith(\"broken\")) {",
        "  console.log(JSON.stringify({ code: \"query_failed\", message: \"WORKSPACE.ts: boom\" }))",
        "  process.exit(1)",
        "}",
        "const name = cwd.endsWith(\"ok\") ? \"ok\" : \"root\"",
        "console.log(JSON.stringify({ query: \"//...\", targets: [{ label: `//:${name}`, target: \"Shell.Test\", kinds: [\"test\"] }] }))"
      ].join("\n")
    )
    const result = await queryTargets({
      repo: dir,
      workspaces: [
        { path: ".", title: "root" },
        { path: "ok", title: "ok" },
        { path: "broken", title: "broken" }
      ],
      node: bunSidecar,
      cli,
      sandboxHost: noSandbox
    })
    expect(result.targets.map((target) => [target.workspace, target.label])).toEqual([
      [".", "//:root"],
      ["ok", "//:ok"]
    ])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain("broken")
    expect(result.warnings[0]).toContain("query_failed: WORKSPACE.ts: boom")
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
    // A build-system workspace: the runner uses the bare-label form here (see runArgv).
    await writeFile(join(dir, "WORKSPACE.ts"), "export const Workspace = {}\n")
    const cli = join(dir, "run-cli.js")
    await writeFile(
      cli,
      "console.log(`ran ${process.argv[2]} in ${process.cwd()}`)\nconsole.error(\"progress line\")\nprocess.exit(3)"
    )
    const sink = collect()
    const runner = createTargetRunner({ publish: sink.publish, cli, autoStartMs: 60_000 })
    const run = runner.start({ repoId: "r1", repo: dir, workspace: ".", label: "//src:lint", node: bunSidecar })
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

  test("a run in a child workspace runs at the joined cwd", async () => {
    const dir = await scratch()
    await mkdir(join(dir, "aomi-sdk"))
    const cli = join(dir, "ws-cli.js")
    await writeFile(cli, "console.log(process.cwd())")
    const sink = collect()
    const runner = createTargetRunner({ publish: sink.publish, cli, autoStartMs: 60_000 })
    const run = runner.start({ repoId: "r1", repo: dir, workspace: "aomi-sdk", label: "//:clippyFix", node: bunSidecar })
    expect(run.workspace).toBe("aomi-sdk")
    runner.attach(run.runId)
    await sink.exited(run.runId)
    const stdout = sink.frames
      .filter((entry) => entry.runId === run.runId && entry.frame.type === "stdout")
      .map((entry) => (entry.frame as { data: string }).data)
      .join("")
    expect(stdout).toBe(`${join(dir, "aomi-sdk")}\n`)
    runner.stop()
  })

  test("a run nobody attaches to starts on its own", async () => {
    const dir = await scratch()
    const cli = join(dir, "auto-cli.js")
    await writeFile(cli, "console.log(\"auto\")")
    const sink = collect()
    const runner = createTargetRunner({ publish: sink.publish, cli, autoStartMs: 10 })
    const run = runner.start({ repoId: "r1", repo: dir, workspace: ".", label: "//:x", node: bunSidecar })
    await sink.exited(run.runId)
    expect(runner.get(run.runId)).toMatchObject({ status: "done", exitCode: 0 })
    runner.stop()
  })

  test("cancelling a pending run reports it without spawning", async () => {
    const dir = await scratch()
    const sink = collect()
    const runner = createTargetRunner({ publish: sink.publish, cli: join(dir, "never.js"), autoStartMs: 60_000 })
    const run = runner.start({ repoId: "r1", repo: dir, workspace: ".", label: "//:x", node: bunSidecar })
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

describe("runArgv picks the CLI form the workspace's authoring surface accepts", () => {
  const { runArgv } = require("./Targets") as typeof import("./Targets")
  test("a WORKSPACE.ts workspace runs the bare-label form, still with --ui plain so FORCE_COLOR cannot hide the status lines", () => {
    const exists = (path: string) => path.endsWith("/WORKSPACE.ts")
    expect(runArgv("/w", "//src:lint", ["lint"], exists)).toEqual(["//src:lint", "--ui", "plain"])
  })
  test("a legacy declaration-rooted workspace runs `<verb> <label> --ui plain` with the verb from the first kind", () => {
    const exists = () => false
    expect(runArgv("/w", "//packages/smithers/flows/canonical:check", ["build"], exists)).toEqual(["build", "//packages/smithers/flows/canonical:check", "--ui", "plain"])
    expect(runArgv("/w", "//:tsconfig", ["run", "lint"], exists)).toEqual(["run", "//:tsconfig", "--ui", "plain"])
    expect(runArgv("/w", "//x:y", [], exists)).toEqual(["build", "//x:y", "--ui", "plain"])
  })
})

/*
 * Pattern runs (LOCAL-APP.md "Targets: load and run"): `<verb> <pattern>`
 * is how CI runs everything (`smithers-build ci '//packages/...'`), and the
 * executor's trailing results block is the one place each target's RULE is
 * printed. The fixture is the real output of
 * `smithers-build ci '//packages/smithers/flows/canonical/...' --ui plain` on this checkout.
 */
describe("pattern runs and the results block", () => {
  const { createRunStdoutParser, patternRunArgv } = require("./Targets") as typeof import("./Targets")
  const REAL_CI_OUTPUT = [
    "//packages/smithers/flows/canonical:docs  ran  13ms",
    "//packages/smithers/flows/canonical:fmt  ran  394ms",
    "//packages/smithers/flows/canonical:check  ran  836ms",
    "3 targets: 0 hit, 3 ran, 0 failed, 0 skipped (2.6s)",
    "verb: ci",
    "pattern: //packages/smithers/flows/canonical/...",
    "jobs: 16",
    "durationMs: 2551.275042",
    "counts:",
    "  hit: 0",
    "  ran: 3",
    "  failed: 0",
    "  skipped: 0",
    "ok: true",
    "results[3]{label,target,status,durationMs,key}:",
    "  \"//packages/smithers/flows/canonical:fmt\",Dprint,ran,393.87254099999996,ce06981499a592588e6fcb4c617f00351198489566c0d07eec3b1db441f5d1b6",
    "  \"//packages/smithers/flows/canonical:check\",Typecheck,ran,835.5130409999997,d88ca8e8c34b996daad7b47c8bd24046963f957e141c3649facc216d875b56d9",
    "  \"//packages/smithers/flows/canonical:docs\",DocsParity,ran,12.953042000000096,9c99919d39ddfd9e1cc850480c9913756eb82ce6cd51f3d7e70666ce5800951c",
    ""
  ].join("\n")

  test("patternRunArgv is the verb over the pattern with the plain renderer, on either authoring surface", () => {
    expect(patternRunArgv("ci", "//packages/...")).toEqual(["ci", "//packages/...", "--ui", "plain"])
  })

  test("the status lines fill the rows, the summary lands, and the results block names each target's rule", () => {
    const parser = createRunStdoutParser({ startedAt: 1_000 })
    const events = parser.push("stdout", REAL_CI_OUTPUT, 4_000)
    const nodes = events.filter((event) => event.type === "node")
    expect(nodes.map((event) => event.type === "node" ? `${event.node.label} ${event.node.status}` : "")).toEqual([
      "//packages/smithers/flows/canonical:docs ran",
      "//packages/smithers/flows/canonical:fmt ran",
      "//packages/smithers/flows/canonical:check ran",
      "//packages/smithers/flows/canonical:fmt ran",
      "//packages/smithers/flows/canonical:check ran",
      "//packages/smithers/flows/canonical:docs ran"
    ])
    const summary = events.find((event) => event.type === "summary")
    expect(summary?.type === "summary" ? summary.summary : undefined).toMatchObject({ total: 3, hit: 0, ran: 3, failed: 0, skipped: 0, durationMs: 2600, ok: true })
    const timings = parser.timings()
    expect(timings.map((node) => [node.label, node.rule, node.key?.slice(0, 8)])).toEqual([
      ["//packages/smithers/flows/canonical:docs", "DocsParity", "9c99919d"],
      ["//packages/smithers/flows/canonical:fmt", "Dprint", "ce069814"],
      ["//packages/smithers/flows/canonical:check", "Typecheck", "d88ca8e8"]
    ])
    // The `verb:` / `counts:` envelope lines are not targets and never become rows.
    expect(timings).toHaveLength(3)
  })

  test("a results row for a target the status lines never named still becomes a row with its rule", () => {
    const parser = createRunStdoutParser({ startedAt: 0 })
    parser.push("stdout", "results[1]{label,target,status,durationMs,key}:\n  \"//x:y\",Vitest,failed,12.5,abc\nok: false\n", 50)
    expect(parser.timings()).toEqual([{ label: "//x:y", status: "failed", rule: "Vitest", key: "abc", startedAt: 37, endedAt: 50, durationMs: 13 }])
  })
})
