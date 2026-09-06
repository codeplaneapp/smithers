import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AGENT_ROLE_IDS, AgentsResponseSchema, HarnessModelsResponseSchema } from "@smthrs/rpc/AgentRoles"
import type { Harness } from "@smthrs/rpc/LocalApp"
import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import { createPtyManager } from "../Pty"
import { startLocalServer } from "../server"
import type { LocalServer } from "../server"
import { createAgentStore, parseModelLines } from "./agents"

/*
 * Agents as data over a real local origin with a temp state dir
 * (custom-agents.md): the store seeds from the built-ins on first read, a
 * PUT creates or edits and persists to `<stateDir>/agents.json`, a built-in
 * cannot be removed, an unknown harness or a flag-shaped model id is
 * refused, and the models route runs the harness's own list command (a fake
 * opencode script here) under the cap.
 */

let dist = ""
let stateDir = ""
let fakeOpencode = ""
let server: LocalServer
const ptyBodies: Array<Record<string, unknown>> = []

const apiFetch = (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set(LOCAL_SESSION_HEADER, server.sessionToken)
  return fetch(`${server.origin}${path}`, { ...init, headers })
}

const put = (id: string, body: unknown): Promise<Response> =>
  apiFetch(`/api/agents/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

const reviewer = {
  label: "Reviewer",
  purpose: "Reviews diffs for correctness and tests.",
  harness: "codex",
  model: { provider: "openai", id: "gpt-5.6-terra", label: "GPT-5.6 Terra" }
} as const

const harnesses = (): ReadonlyArray<Harness> => [
  {
    id: "codex",
    displayName: "Codex",
    binary: "/bin/echo",
    version: "1.0.0",
    status: "signed-in",
    account: { email: "will@example.com" },
    launch: { argv: ["codex"] },
    models: { suggestions: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"], listable: false }
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    binary: fakeOpencode,
    version: "1.18.22",
    status: "signed-in",
    account: { label: "kimi-for-coding" },
    launch: { argv: ["opencode"] },
    models: { suggestions: ["kimi-for-coding/k3"], listable: true }
  },
  {
    id: "opencode-cerebras",
    displayName: "OpenCode · Cerebras",
    binary: null,
    version: null,
    status: "unavailable",
    account: null,
    launch: { argv: ["opencode", "--model", "cerebras/gpt-oss-120b"] },
    models: { suggestions: ["cerebras/gpt-oss-120b"], listable: true }
  },
  {
    id: "crush",
    displayName: "Crush",
    binary: "/bin/echo",
    version: "0.1.0",
    status: "api-key",
    account: { label: "OPENAI_API_KEY" },
    launch: { argv: ["crush"] }
  }
]

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "smithers-agents-dist-"))
  await writeFile(join(dist, "index.html"), "<!doctype html><title>Smithers</title>")
  stateDir = await mkdtemp(join(tmpdir(), "smithers-agents-state-"))
  /*
   * A fake `opencode` binary: `models` prints provider/model lines the way
   * the real one does (plus noise the parser drops); `models cerebras`
   * fails, the way a provider without a credential answers.
   */
  fakeOpencode = join(dist, "opencode")
  await writeFile(
    fakeOpencode,
    [
      "#!/bin/sh",
      "if [ \"$1\" = \"models\" ] && [ -z \"$2\" ]; then",
      "  printf 'kimi-for-coding/k3\\n\\ncerebras/gpt-oss-120b\\n  cerebras/gemma-4-31b  \\nnot a model id\\n'",
      "  exit 0",
      "fi",
      "echo 'no credential for cerebras' >&2",
      "exit 2"
    ].join("\n")
  )
  await chmod(fakeOpencode, 0o755)
  server = await startLocalServer({
    port: 0,
    distDir: dist,
    chatStub: true,
    node: { path: "/fake/node", version: "v22.19.0" },
    home: tmpdir(),
    stateDir,
    harnesses: async () => harnesses(),
    pty: (deps) =>
      createPtyManager({
        ...deps,
        shell: "/bin/sh",
        home: tmpdir(),
        sandboxHost: { platform: "linux", disabled: true, log: () => {} },
        killGraceMs: 300,
        log: () => {}
      }),
    log: () => {}
  })
  void ptyBodies
})

afterAll(async () => {
  await server.stop()
  await rm(dist, { recursive: true, force: true })
  await rm(stateDir, { recursive: true, force: true })
})

describe("the agents routes", () => {
  test("GET seeds the built-ins on first read, in table order, with no argv stored", async () => {
    const response = await apiFetch("/api/agents")
    expect(response.status).toBe(200)
    const body = AgentsResponseSchema.parse(await response.json())
    expect(body.agents.map((agent) => agent.id)).toEqual([...AGENT_ROLE_IDS])
    expect(body.agents.find((agent) => agent.id === "orchestrator")?.model).toEqual({
      provider: "anthropic", id: "claude-fable-5-1", label: "Fable 5.1"
    })
    for (const agent of body.agents) {
      expect(agent.builtin).toBe(true)
      expect("launch" in agent).toBe(false)
    }
  })

  test("a saved Fable 5 orchestrator is not silently upgraded when the store reopens", async () => {
    const dir = await mkdtemp(join(tmpdir(), "smithers-fable-"))
    try {
      const store = createAgentStore({ stateDir: dir })
      const model = { provider: "anthropic", id: "claude-fable-5", label: "Fable 5" }
      await store.put("orchestrator", { label: "Orchestrator", purpose: "Keep the selected model.", harness: "claude", model })
      expect((await createAgentStore({ stateDir: dir }).get("orchestrator"))?.model).toEqual(model)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("PUT creates a custom agent (201), persists it under the state dir, and lists it after the built-ins", async () => {
    const created = await put("reviewer", reviewer)
    expect(created.status).toBe(201)
    const body = (await created.json()) as { agent: { id: string; builtin: boolean; createdAt: number } }
    expect(body.agent).toMatchObject({ id: "reviewer", builtin: false, harness: "codex", model: { id: "gpt-5.6-terra" } })
    const listed = AgentsResponseSchema.parse(await (await apiFetch("/api/agents")).json())
    expect(listed.agents.map((agent) => agent.id)).toEqual([...AGENT_ROLE_IDS, "reviewer"])
    const onDisk = JSON.parse(await readFile(join(stateDir, "agents.json"), "utf8")) as { agents: Array<{ id: string }> }
    expect(onDisk.agents.some((agent) => agent.id === "reviewer")).toBe(true)
    // A fresh store over the same dir reads it back: the file is the truth across launches.
    const reopened = createAgentStore({ stateDir })
    expect((await reopened.get("reviewer"))?.label).toBe("Reviewer")
  })

  test("PUT edits an existing agent (200) and a built-in's model and purpose; a built-in's harness stays fixed", async () => {
    const edited = await put("reviewer", { ...reviewer, purpose: "Reviews diffs, strictly." })
    expect(edited.status).toBe(200)
    expect(((await edited.json()) as { agent: { purpose: string } }).agent.purpose).toBe("Reviews diffs, strictly.")
    const explainer = await put("explainer", {
      label: "Explainer",
      purpose: "Explains, briefly.",
      harness: "opencode-kimi",
      model: { provider: "kimi-for-coding", id: "kimi-for-coding/k3", label: "Kimi K3" }
    })
    expect(explainer.status).toBe(200)
    expect(((await explainer.json()) as { agent: { builtin: boolean; purpose: string } }).agent).toMatchObject({ builtin: true, purpose: "Explains, briefly." })
    const moved = await put("explainer", { ...reviewer, label: "Explainer" })
    expect(moved.status).toBe(409)
    expect(((await moved.json()) as { error: { code: string } }).error.code).toBe("builtin_harness_fixed")
  })

  test("PUT refuses a bad id, an unknown harness, a harness with no verified model flag, and a flag-shaped model id", async () => {
    const badId = await put("Bad%20Id", reviewer)
    expect(badId.status).toBe(400)
    expect(((await badId.json()) as { error: { code: string } }).error.code).toBe("invalid_id")
    const unknown = await put("ghost", { ...reviewer, harness: "ghostwriter" })
    expect(unknown.status).toBe(400)
    const noFlag = await put("crusher", { ...reviewer, harness: "crush" })
    expect(noFlag.status).toBe(400)
    expect(((await noFlag.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "harness_no_model_flag" })
    for (const model of ["--dangerously-skip-permissions", "gpt 5", "-m"]) {
      const injected = await put("evil", { ...reviewer, model: { ...reviewer.model, id: model } })
      expect(injected.status).toBe(400)
    }
    const listed = AgentsResponseSchema.parse(await (await apiFetch("/api/agents")).json())
    expect(listed.agents.map((agent) => agent.id)).not.toContain("evil")
    expect(listed.agents.map((agent) => agent.id)).not.toContain("crusher")
  })

  test("a custom agent launches through POST /api/pty by role id with its composed argv", async () => {
    const response = await apiFetch("/api/pty", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "harness", cols: 80, rows: 24, roleId: "reviewer", task: "review it" })
    })
    expect(response.status).toBe(201)
    const { sessionId } = (await response.json()) as { sessionId: string }
    const deadline = Date.now() + 5000
    let output = ""
    while (Date.now() < deadline) {
      const read = (await (await apiFetch(`/api/pty/${sessionId}/output`)).json()) as { output: string; alive: boolean }
      output = read.output
      if (!read.alive) break
      await Bun.sleep(25)
    }
    expect(output).toContain("-m gpt-5.6-terra review it")
    await apiFetch(`/api/pty/${sessionId}`, { method: "DELETE" })
    const unknown = await apiFetch("/api/pty", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "harness", cols: 80, rows: 24, roleId: "poet" })
    })
    expect(unknown.status).toBe(404)
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("unknown_role")
  })

  test("DELETE removes a custom agent, refuses a built-in with the reason, and 404s an unknown id", async () => {
    const builtin = await apiFetch("/api/agents/orchestrator", { method: "DELETE" })
    expect(builtin.status).toBe(409)
    expect(((await builtin.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "builtin_agent" })
    const removed = await apiFetch("/api/agents/reviewer", { method: "DELETE" })
    expect(removed.status).toBe(200)
    expect((await apiFetch("/api/agents/reviewer", { method: "DELETE" })).status).toBe(404)
    const listed = AgentsResponseSchema.parse(await (await apiFetch("/api/agents")).json())
    expect(listed.agents.map((agent) => agent.id)).toEqual([...AGENT_ROLE_IDS])
    const onDisk = JSON.parse(await readFile(join(stateDir, "agents.json"), "utf8")) as { agents: Array<{ id: string }> }
    expect(onDisk.agents.map((agent) => agent.id)).toEqual([...AGENT_ROLE_IDS])
  })

  test("GET /api/harnesses/{id}/models runs the harness's list command, falls back to the table's suggestions, and states failures", async () => {
    const listed = HarnessModelsResponseSchema.parse(await (await apiFetch("/api/harnesses/opencode/models")).json())
    expect(listed).toEqual({
      harnessId: "opencode",
      models: ["kimi-for-coding/k3", "cerebras/gpt-oss-120b", "cerebras/gemma-4-31b"],
      source: "list"
    })
    // No list command: the table's verified suggestions.
    const codex = HarnessModelsResponseSchema.parse(await (await apiFetch("/api/harnesses/codex/models")).json())
    expect(codex).toEqual({ harnessId: "codex", models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"], source: "suggestions" })
    // A list command whose binary is not installed: the suggestions, with the reason.
    const absent = HarnessModelsResponseSchema.parse(await (await apiFetch("/api/harnesses/opencode-cerebras/models")).json())
    // The suggestions are the SERVER table's (Harnesses.ts), never the fixture row's.
    expect(absent).toMatchObject({
      models: ["cerebras/gpt-oss-120b", "cerebras/gemma-4-31b"],
      source: "suggestions",
      reason: "OpenCode · Cerebras is not installed here."
    })
    // No verified model flag at all: empty, with the reason.
    const crush = HarnessModelsResponseSchema.parse(await (await apiFetch("/api/harnesses/crush/models")).json())
    expect(crush.models).toEqual([])
    expect(crush.reason).toContain("no model flag")
    expect((await apiFetch("/api/harnesses/ghost/models")).status).toBe(404)
  })

  test("a failing list command answers empty with its exit and first stderr line", async () => {
    const { listHarnessModels } = await import("./agents")
    const failing: Harness = { ...harnesses()[1]!, id: "opencode-cerebras", displayName: "OpenCode · Cerebras" }
    const result = await listHarnessModels(failing, async (argv) => {
      const child = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      return { code, stdout, stderr }
    })
    expect(result).toEqual({
      harnessId: "opencode-cerebras",
      models: [],
      source: "list",
      reason: "opencode models cerebras exited 2: no credential for cerebras"
    })
    const timedOut = await listHarnessModels(failing, async () => {
      throw new Error("timed out after 5000 ms")
    })
    expect(timedOut.models).toEqual([])
    expect(timedOut.reason).toContain("timed out")
  })

  test("parseModelLines keeps one id per line and drops noise", () => {
    expect(parseModelLines("a/b\n\n  c.d-e:f  \nnot a model\n-flag\n")).toEqual(["a/b", "c.d-e:f"])
  })

  test("a corrupt store file starts from the built-ins and says so", async () => {
    const dir = await mkdtemp(join(tmpdir(), "smithers-agents-corrupt-"))
    await writeFile(join(dir, "agents.json"), "{ not json")
    const lines: Array<string> = []
    const store = createAgentStore({ stateDir: dir, log: (line) => lines.push(line) })
    expect((await store.list()).map((agent) => agent.id)).toEqual([...AGENT_ROLE_IDS])
    expect(lines.some((line) => line.includes("not JSON"))).toBe(true)
    // A store with no state dir is memory only: the built-ins, and a create that never touches disk.
    const memory = createAgentStore()
    expect((await memory.put("scratch", reviewer)).status).toBe("created")
    expect((await memory.list()).map((agent) => agent.id)).toContain("scratch")
    await rm(dir, { recursive: true, force: true })
  })
})
