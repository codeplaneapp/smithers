import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AffectedResponseSchema, CiMatrixResponseSchema, RunHistoryResponseSchema, RunReplayResponseSchema, TargetGraphResponseSchema } from "smithers-shared/TargetGraph"
import { startLocalServer } from "../server"
import type { LocalServer } from "../server"

let root = ""
let repo = ""
let server: LocalServer
let repoId = ""

const post = (path: string, body: unknown): Promise<Response> => fetch(`${server.origin}${path}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
})

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "smithers-target-graph-"))
  repo = await realpath(await mkdtemp(join(tmpdir(), "smithers-target-graph-repo-")))
  await mkdir(join(repo, ".smithers"))
  await writeFile(join(repo, ".smithers", "WORKSPACE.ts"), 'import "@smthrs/targets"\n')
  await writeFile(join(repo, "PACKAGE.ts"), 'import { Smithers as S } from "@smthrs/targets"\nconst srcs = S.Filegroup({ srcs: S.glob(["src/**"]) })\nconst lint = S.Shell.Test({ data: [srcs] })\n')
  await mkdir(join(repo, "src"))
  await writeFile(join(repo, "src", "app.ts"), "export const app = 1\n")
  await writeFile(join(root, "index.html"), "<!doctype html>")
  const cli = join(root, "cli.js")
  await writeFile(cli, [
    "import { mkdir } from 'node:fs/promises'",
    "const args = process.argv.slice(2)",
    "if (args[0] === 'graph') console.log(JSON.stringify({ graph: '//:lint\\n  -data-> //:srcs\\n//.github:github', targets: [{ label: '//:lint', target: 'Shell.Test' }, { label: '//:srcs', target: 'Filegroup' }, { label: '//.github:github', target: 'Github.CiGen' }] }))",
    "else if (args[0] === 'query') console.log(JSON.stringify({ targets: [{ label: '//:lint', target: 'Shell.Test', kinds: ['lint'] }, { label: '//:srcs', target: 'Filegroup', kinds: [] }, { label: '//.github:github', target: 'Github.CiGen', kinds: [] }] }))",
    "else if (args.includes('--plan')) console.log(JSON.stringify({ targets: [{ label: args[0], mode: 'execute', cacheable: true, key: 'abc', argv: ['eslint'] }] }))",
    "else if (args[0] === '//.github:github' && args.includes('--write')) { await mkdir('.github/workflows', { recursive: true }); for (const name of ['ci', 'review', 'danger']) await Bun.write(`.github/workflows/${name}.yml`, `name: ${name}\\njobs:\\n  verify:\\n    steps:\\n      - run: smthrs //:lint\\n`) }",
    "else console.log('//:srcs  hit  1ms\\n//:lint  ran  2ms\\n2 targets: 1 hit, 1 ran, 0 failed, 0 skipped (3ms)')"
  ].join("\n"))
  const git = async (...args: Array<string>) => { const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "ignore", stderr: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" } }); expect(await child.exited).toBe(0) }
  await git("init")
  await git("add", ".")
  await git("commit", "-m", "fixture")
  await writeFile(join(repo, "src", "app.ts"), "export const app = 2\n")
  server = await startLocalServer({ port: 0, distDir: root, chatStub: true, node: { path: process.execPath, version: "v22.19.0" }, buildCli: cli, log: () => {} })
  const opened = await post("/api/repo/open", { path: repo })
  repoId = ((await opened.json()) as { repo: { id: string } }).repo.id
})

afterAll(async () => {
  server.stop()
  await rm(root, { recursive: true, force: true })
  await rm(repo, { recursive: true, force: true })
})

describe("POST /api/targets/graph", () => {
  test("returns the typed graph and optional plan", async () => {
    const response = await post("/api/targets/graph", { repoId, plan: true, labels: ["//:lint"] })
    expect(response.status).toBe(200)
    const graph = TargetGraphResponseSchema.parse(await response.json())
    expect(graph.nodes).toHaveLength(3)
    expect(graph.edges).toEqual([{ from: "//:lint", to: "//:srcs", kind: "data" }])
    expect(graph.nodes[0]?.plan).toMatchObject({ mode: "execute", key: "abc" })
    expect(graph.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(graph.nodes.find((node) => node.label === "//:lint")?.source).toEqual({ file: "PACKAGE.ts", line: 3 })
    expect((await post("/api/targets/graph", { repoId: "missing" })).status).toBe(404)
  })

  test("the declaration digest changes when contents change at identical size and mtime", async () => {
    const declaration = join(repo, "PACKAGE.ts")
    const before = await stat(declaration)
    const first = TargetGraphResponseSchema.parse(await (await post("/api/targets/graph", { repoId })).json())
    const contents = await Bun.file(declaration).text()
    await writeFile(declaration, contents.replace("const lint", "const lInt"))
    await utimes(declaration, before.atime, before.mtime)
    const second = TargetGraphResponseSchema.parse(await (await post("/api/targets/graph", { repoId })).json())
    expect(second.digest).not.toBe(first.digest)
    await writeFile(declaration, contents)
  })

  test("open-source resolves only declaration files inside the open repository", async () => {
    const opened = await post("/api/targets/open-source", { repoId, file: "PACKAGE.ts", line: 3 })
    expect(opened.status).toBe(200)
    expect(await opened.json()).toEqual({ path: join(repo, "PACKAGE.ts"), line: 3 })
    expect((await post("/api/targets/open-source", { repoId, file: "../etc/passwd" })).status).toBe(400)
  })

  test("affected and CI routes return computed repository facts", async () => {
    const affected = AffectedResponseSchema.parse(await (await post("/api/targets/affected", { repoId })).json())
    expect(affected.changedFiles).toContain("src/app.ts")
    expect(affected.affected.map((entry) => entry.label)).toEqual(["//:lint", "//:srcs"])
    const ci = CiMatrixResponseSchema.parse(await (await post("/api/targets/ci", { repoId })).json())
    expect(ci.workflows.map((workflow) => workflow.name)).toEqual(["ci", "danger", "review"])
    expect(ci.workflows.every((workflow) => workflow.source === "scratch-render")).toBe(true)
  })

  test("history lists a completed run and replay returns ordered events", async () => {
    const started = await post("/api/targets/run", { repoId, label: "//:lint" })
    const runId = ((await started.json()) as { runId: string }).runId
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    const history = RunHistoryResponseSchema.parse(await (await post("/api/targets/runs", { repoId })).json())
    expect(history.runs[0]).toMatchObject({ runId, status: "done" })
    const replay = RunReplayResponseSchema.parse(await (await post("/api/targets/runs/replay", { runId })).json())
    expect(replay.events.map((event) => event.type)).toEqual(["started", "stdout", "node", "node", "summary", "exit"])
    expect(replay.events.map((event) => event.seq)).toEqual(replay.events.map((_, index) => index))
  })
})
