import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ReposResponseSchema, TargetRunMessageSchema, TargetsQueryResponseSchema } from "smithers-shared/LocalApp"
import { LOCAL_SESSION_HEADER } from "smithers-shared/LocalSession"
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
    headers: { "content-type": "application/json", [LOCAL_SESSION_HEADER]: server.sessionToken },
    body: JSON.stringify(body)
  })

const get = (path: string): Promise<Response> =>
  fetch(`${server.origin}${path}`, { headers: { [LOCAL_SESSION_HEADER]: server.sessionToken } })

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "smithers-l3-dist-"))
  await writeFile(join(dist, "index.html"), "<!doctype html><title>Smithers</title>")
  repoDir = await realpath(await mkdtemp(join(tmpdir(), "smithers-l3-repo-")))
  expect(await Bun.spawn(["git", "init", "-q", repoDir]).exited).toBe(0)
  await mkdir(join(repoDir, ".smithers"))
  await writeFile(join(repoDir, ".smithers", "WORKSPACE.ts"), "import { Smithers as S } from \"@smthrs/targets\"\n")
  // A child workspace so the query route fans out and the run route validates.
  await mkdir(join(repoDir, "aomi-sdk", ".smithers"), { recursive: true })
  await writeFile(join(repoDir, "aomi-sdk", ".smithers", "WORKSPACE.ts"), "import { Smithers as S } from \"@smthrs/targets\"\n")
  plainDir = await realpath(await mkdtemp(join(tmpdir(), "smithers-l3-plain-")))
  cli = join(dist, "fake-cli.js")
  await writeFile(
    cli,
    [
      "const [verb] = process.argv.slice(2)",
      "if (verb === \"query\") {",
      "  const child = process.cwd().endsWith(\"aomi-sdk\")",
      "  const targets = child",
      "    ? [{ label: \"//src:sdkLint\", target: \"Shell.Test\", kinds: [\"lint\"] }]",
      "    : [{ label: \"//src:lint\", target: \"Shell.Test\", kinds: [\"lint\"] }, { label: \"//:fails\", target: \"Shell.Test\", kinds: [\"test\"] }]",
      "  console.log(JSON.stringify({ query: \"//...\", targets }))",
      "  process.exit(0)",
      "}",
      "if (verb === \"graph\") {",
      "  const child = process.cwd().endsWith(\"aomi-sdk\")",
      "  const labels = child ? [\"//src:sdkLint\"] : [\"//src:lint\", \"//:fails\"]",
      "  console.log(JSON.stringify({ graph: labels.join(\"\\n\"), targets: labels.map((label) => ({ label, target: \"Shell.Test\" })) }))",
      "  process.exit(0)",
      "}",
      "console.log(`ran ${verb} in ${process.cwd()}`)",
      "console.error(\"done\")",
      "process.exit(verb === \"//:fails\" ? 2 : 0)"
    ].join("\n")
  )
  server = await startLocalServer({
    port: 0,
    distDir: dist,
    chatStub: true,
    allowManualRepositoryPaths: true,
    node: { path: process.execPath, version: "v22.19.0" },
    buildCli: cli,
    log: () => {}
  })
  // The fake loader runs under the loader sandbox on macOS; it reads nothing outside the repo.
})

afterAll(async () => {
  await server.stop()
  await rm(dist, { recursive: true, force: true })
  await rm(repoDir, { recursive: true, force: true })
  await rm(plainDir, { recursive: true, force: true })
})

describe("/api/repo/*", () => {
  test("native mode accepts only a fresh picker grant, exactly once", async () => {
    const secure = await startLocalServer({
      port: 0,
      distDir: dist,
      chatStub: true,
      node: { path: process.execPath, version: "v22.19.0" },
      buildCli: cli,
      log: () => {}
    })
    const securePost = (body: unknown): Promise<Response> => fetch(`${secure.origin}/api/repo/open`, {
      method: "POST",
      headers: { "content-type": "application/json", [LOCAL_SESSION_HEADER]: secure.sessionToken },
      body: JSON.stringify(body)
    })
    try {
      expect((await securePost({ path: repoDir })).status).toBe(403)
      const selected = await secure.authorizeRepository(repoDir, "read-write")
      expect(selected.status).toBe("connected")
      if (selected.status !== "connected") return
      const authorizationId = selected.repository.authorizationId
      expect((await securePost({ authorizationId })).status).toBe(200)
      expect((await securePost({ authorizationId })).status).toBe(403)
    } finally {
      await secure.stop()
    }
  })

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

    const listed = ReposResponseSchema.parse(await (await get("/api/repos")).json())
    expect(listed.repos.map((entry) => entry.path)).toEqual([repoDir, plainDir])

    const closed = await post("/api/repo/close", { repoId: listed.repos[1]?.id })
    expect(await closed.json()).toEqual({ ok: true })
    expect(ReposResponseSchema.parse(await (await get("/api/repos")).json()).repos).toHaveLength(1)
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
  test("query fans out over the detected workspaces; an unknown repo is 404", async () => {
    const opened = (await (await post("/api/repo/open", { path: repoDir })).json()) as { repo: { id: string } }
    const response = await post("/api/targets/query", { repoId: opened.repo.id })
    expect(response.status).toBe(200)
    const body = TargetsQueryResponseSchema.parse(await response.json())
    expect(body.warnings).toEqual([])
    expect(body.targets.map(({ id: _id, ...target }) => target)).toEqual([
      { label: "//src:lint", target: "Shell.Test", kinds: ["lint"], package: "//src", name: "lint", workspace: "." },
      { label: "//:fails", target: "Shell.Test", kinds: ["test"], package: "//", name: "fails", workspace: "." },
      { label: "//src:sdkLint", target: "Shell.Test", kinds: ["lint"], package: "//src", name: "sdkLint", workspace: "aomi-sdk" }
    ])
    expect(body.targets.every((target) => typeof target.id === "string" && target.id !== "")).toBe(true)
    expect((await post("/api/targets/query", { repoId: "nope" })).status).toBe(404)
  })

  test("an opaque grant preserves its server-owned child workspace", async () => {
    const opened = (await (await post("/api/repo/open", { path: repoDir })).json()) as { repo: { id: string } }
    const queried = TargetsQueryResponseSchema.parse(
      await (await post("/api/targets/query", { repoId: opened.repo.id })).json()
    )
    const targetId = queried.targets.find(
      (target) => target.workspace === "aomi-sdk" && target.label === "//src:sdkLint"
    )?.id
    expect(targetId).toBeDefined()
    expect((await post("/api/targets/run", { repoId: opened.repo.id, targetId: "unknown" })).status).toBe(404)

    /*
     * Extra renderer-authored workspace/label fields cannot redirect the
     * process: the server resolves both from targetId.
     */
    const started = await post("/api/targets/run", {
      repoId: opened.repo.id,
      targetId,
      workspace: ".",
      label: "//:fails"
    })
    expect(started.status).toBe(200)
    const { runId } = (await started.json()) as { runId: string }
    const socket = new WebSocket(
      `${server.origin.replace("http", "ws")}/ws`,
      server.websocketProtocol
    )
    const frames: Array<{ type: string; data?: string; code?: number | null }> = []
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
    expect(frames.filter((frame) => frame.type === "stdout").map((frame) => frame.data).join("")).toBe(
      `ran //src:sdkLint in ${join(repoDir, "aomi-sdk")}\n`
    )
    expect(frames[frames.length - 1]).toMatchObject({ type: "exit", code: 0 })
  })

  test("run streams stdout, stderr and exit on the topic once the client attaches; cancel answers", async () => {
    const opened = (await (await post("/api/repo/open", { path: repoDir })).json()) as { repo: { id: string } }
    const queried = TargetsQueryResponseSchema.parse(await (await post("/api/targets/query", { repoId: opened.repo.id })).json())
    const targetId = queried.targets.find((target) => target.label === "//:fails")?.id
    expect(targetId).toBeDefined()
    const started = await post("/api/targets/run", { repoId: opened.repo.id, targetId })
    expect(started.status).toBe(200)
    const { runId } = (await started.json()) as { runId: string }

    const socket = new WebSocket(`${server.origin.replace("http", "ws")}/ws`, server.websocketProtocol)
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
    expect(frames.filter((frame) => frame.type === "stdout").map((frame) => frame.data).join("")).toBe(
      `ran //:fails in ${repoDir}\n`
    )
    expect(frames.filter((frame) => frame.type === "stderr").map((frame) => frame.data).join("")).toBe("done\n")
    /* The run-local seq the contract orders replay by reaches the client. */
    expect(frames.map((frame) => (frame as { seq?: number }).seq)).toEqual(frames.map((_frame, index) => index))
    expect(frames[frames.length - 1]).toMatchObject({ type: "exit", code: 2, seq: frames.length - 1 })
    expect(frames.map((frame) => frame.seq)).toEqual(frames.map((_, index) => index))

    expect(await (await post("/api/targets/cancel", { runId })).json()).toEqual({ ok: false })
    expect((await post("/api/targets/cancel", { runId: "nope" })).status).toBe(404)
    expect((await post("/api/targets/run", { repoId: "nope", targetId: "unknown" })).status).toBe(404)
    expect((await post("/api/targets/run", { repoId: opened.repo.id, targetId: "unknown" })).status).toBe(404)
    expect((await post("/api/targets/run", { repoId: opened.repo.id })).status).toBe(400)
  })
})
