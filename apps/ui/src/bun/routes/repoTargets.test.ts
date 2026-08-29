import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ReposResponseSchema, TargetRunMessageSchema, TargetsQueryResponseSchema } from "smithers-shared/LocalApp"
import { startLocalServer } from "../server"
import type { LocalServer } from "../server"

/*
 * The L3 HTTP routes and the target-run topic over a real local origin: a
 * temp workspace is opened, listed, queried and closed; a run streams its
 * frames over /ws after the client attaches. A fake build-cli (run by Bun in
 * place of Node) stands in for the loader so the suite needs no checkout.
 */

let dist = ""
let repoDir = ""
let plainDir = ""
let cli = ""
let server: LocalServer

const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${server.origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  })

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "smithers-l3-dist-"))
  await writeFile(join(dist, "index.html"), "<!doctype html><title>Smithers</title>")
  repoDir = await realpath(await mkdtemp(join(tmpdir(), "smithers-l3-repo-")))
  await mkdir(join(repoDir, ".smithers"))
  await writeFile(join(repoDir, ".smithers", "WORKSPACE.ts"), "import { Smithers as S } from \"@smthrs/targets\"\n")
  plainDir = await realpath(await mkdtemp(join(tmpdir(), "smithers-l3-plain-")))
  cli = join(dist, "fake-cli.js")
  await writeFile(
    cli,
    [
      "const [verb] = process.argv.slice(2)",
      "if (verb === \"query\") {",
      "  console.log(JSON.stringify({ query: \"//...\", targets: [{ label: \"//src:lint\", target: \"Shell.Test\", kinds: [\"lint\"] }] }))",
      "  process.exit(0)",
      "}",
      "console.log(`ran ${verb}`)",
      "console.error(\"done\")",
      "process.exit(verb === \"//:fails\" ? 2 : 0)"
    ].join("\n")
  )
  server = await startLocalServer({
    port: 0,
    distDir: dist,
    chatStub: true,
    node: { path: process.execPath, version: "v22.19.0" },
    buildCli: cli,
    log: () => {}
  })
  // The fake loader runs under the loader sandbox on macOS; it reads nothing outside the repo.
})

afterAll(async () => {
  server.stop()
  await rm(dist, { recursive: true, force: true })
  await rm(repoDir, { recursive: true, force: true })
  await rm(plainDir, { recursive: true, force: true })
})

describe("/api/repo/*", () => {
  test("open detects the workspace, list shows it, close removes it", async () => {
    const opened = await post("/api/repo/open", { path: repoDir })
    expect(opened.status).toBe(200)
    const { repo } = (await opened.json()) as { repo: { id: string; path: string; smithers: { detected: boolean } } }
    expect(repo.path).toBe(repoDir)
    expect(repo.smithers.detected).toBe(true)

    const plain = await post("/api/repo/open", { path: plainDir })
    expect(((await plain.json()) as { repo: { smithers: { detected: boolean; reason: string } } }).repo.smithers).toMatchObject({
      detected: false,
      reason: "no WORKSPACE.ts"
    })

    const listed = ReposResponseSchema.parse(await (await fetch(`${server.origin}/api/repos`)).json())
    expect(listed.repos.map((entry) => entry.path)).toEqual([repoDir, plainDir])

    const closed = await post("/api/repo/close", { repoId: listed.repos[1]?.id })
    expect(await closed.json()).toEqual({ ok: true })
    expect(ReposResponseSchema.parse(await (await fetch(`${server.origin}/api/repos`)).json()).repos).toHaveLength(1)
    expect((await post("/api/repo/close", { repoId: "nope" })).status).toBe(404)
  })

  test("a bad path is a 400 with the error envelope", async () => {
    const missing = await post("/api/repo/open", { path: join(plainDir, "missing") })
    expect(missing.status).toBe(400)
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("invalid_path")
    expect((await post("/api/repo/open", {})).status).toBe(400)
  })
})

describe("/api/targets/*", () => {
  test("query maps the loader's listing; an unknown repo is 404", async () => {
    const opened = (await (await post("/api/repo/open", { path: repoDir })).json()) as { repo: { id: string } }
    const response = await post("/api/targets/query", { repoId: opened.repo.id })
    expect(response.status).toBe(200)
    const body = TargetsQueryResponseSchema.parse(await response.json())
    expect(body.warnings).toEqual([])
    expect(body.targets).toEqual([{ label: "//src:lint", target: "Shell.Test", kinds: ["lint"], package: "//src", name: "lint" }])
    expect((await post("/api/targets/query", { repoId: "nope" })).status).toBe(404)
  })

  test("run streams stdout, stderr and exit on the topic once the client attaches; cancel answers", async () => {
    const opened = (await (await post("/api/repo/open", { path: repoDir })).json()) as { repo: { id: string } }
    const started = await post("/api/targets/run", { repoId: opened.repo.id, label: "//:fails" })
    expect(started.status).toBe(200)
    const { runId } = (await started.json()) as { runId: string }

    const socket = new WebSocket(`${server.origin.replace("http", "ws")}/ws`)
    const frames: Array<{ type: string; data?: string; code?: number | null; seq?: number }> = []
    const finished = new Promise<void>((resolve) => {
      socket.onmessage = (event) => {
        const parsed = TargetRunMessageSchema.safeParse(JSON.parse(String(event.data)))
        if (!parsed.success || parsed.data.runId !== runId) return
        frames.push(parsed.data.frame)
        if (parsed.data.frame.type === "exit") resolve()
      }
    })
    await new Promise<void>((resolve) => {
      socket.onopen = () => resolve()
    })
    socket.send(JSON.stringify({ type: "subscribe", topic: `target-run:${runId}` }))
    socket.send(JSON.stringify({ type: "target-run.attach", runId }))
    await finished
    socket.close()
    expect(frames.filter((frame) => frame.type === "stdout").map((frame) => frame.data).join("")).toBe("ran //:fails\n")
    expect(frames.filter((frame) => frame.type === "stderr").map((frame) => frame.data).join("")).toBe("done\n")
    /* The run-local seq the contract orders replay by reaches the client. */
    expect(frames.map((frame) => (frame as { seq?: number }).seq)).toEqual(frames.map((_frame, index) => index))
    expect(frames[frames.length - 1]).toMatchObject({ type: "exit", code: 2, seq: frames.length - 1 })
    expect(frames.map((frame) => frame.seq)).toEqual(frames.map((_, index) => index))

    expect(await (await post("/api/targets/cancel", { runId })).json()).toEqual({ ok: false })
    expect((await post("/api/targets/cancel", { runId: "nope" })).status).toBe(404)
    expect((await post("/api/targets/run", { repoId: "nope", label: "//:x" })).status).toBe(404)
    expect((await post("/api/targets/run", { repoId: opened.repo.id })).status).toBe(400)
  })
})
