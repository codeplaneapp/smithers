import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LspDiagnosticsMessageSchema, LspDiagnosticsResponseSchema, LspHoverSchema } from "@smthrs/rpc/LocalApp"
import { findNode } from "../Node"
import { currentSandboxHost, sandboxEnforced } from "../Sandbox"
import { languageFor, resolveServer, TYPESCRIPT_SERVER } from "./LanguageServers"
import { emptyLookup, writeFixtureProject } from "./LspFixture"
import { createLspHost, defaultServerLookup } from "./LspHost"
import type { LspHost } from "./LspHost"
import { hoverContents, LspRequestError, toDiagnostic } from "./LspSession"

/*
 * The host seam against the REAL typescript-language-server over stdio
 * (code-intel PLAN.md §6 "Bun host seam"): a fixture project under a temp dir
 * with a tsconfig, two files and one deliberate type error. The server is
 * resolved the way production resolves it (the repository's node_modules/.bin,
 * the harness candidate dirs, PATH) and runs under the lsp seatbelt policy
 * on macOS. Absent a server or a Node sidecar, the spawning tests skip and
 * say why; nothing stands in for the server.
 */

const node = await findNode()
const lookup = defaultServerLookup()
const probeRoot = await mkdtemp(join(tmpdir(), "smithers-lsp-probe-"))
const resolved = resolveServer(TYPESCRIPT_SERVER, lookup, probeRoot, node)
await rm(probeRoot, { recursive: true, force: true })
const skipReason = node === null
  ? "no Node.js >= 22.19 on this machine to run the language server"
  : "missing" in resolved
  ? `no typescript-language-server on this machine (install: ${resolved.missing})`
  : undefined
if (skipReason !== undefined) console.warn(`LspHost seam tests skipped: ${skipReason}`)

let root = ""
let host: LspHost
const frames: Array<unknown> = []
const logs: Array<string> = []
const repoId = "repo-fixture"

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "smithers-lsp-fixture-")))
  await writeFixtureProject(root)
  host = createLspHost({
    publish: (_topic, message) => frames.push(message),
    node: Promise.resolve(node),
    home: tmpdir(),
    sandbox: currentSandboxHost(),
    log: (line) => logs.push(line)
  })
})

afterAll(async () => {
  await host?.killAll()
  await rm(root, { recursive: true, force: true })
})

const session = async (path = "src/index.ts") => {
  const result = await host.session(repoId, root, path)
  if (result.status !== "ok") throw new Error(`expected a session, got ${result.status}`)
  return result.session
}

describe("the registry", () => {
  test("languageFor names TypeScript for its extensions and null otherwise", () => {
    expect(languageFor("src/App.tsx")).toBe("typescript")
    expect(languageFor("lib/index.mjs")).toBe("typescript")
    expect(languageFor("README.md")).toBeNull()
    expect(languageFor("Makefile")).toBeNull()
    expect(TYPESCRIPT_SERVER.documentLanguageId("a.tsx")).toBe("typescriptreact")
    expect(TYPESCRIPT_SERVER.documentLanguageId("a.js")).toBe("javascript")
  })

  test("a missing binary answers the install line verbatim and spawns nothing", async () => {
    const missing = createLspHost({
      publish: () => {},
      node: Promise.resolve(node),
      home: tmpdir(),
      sandbox: currentSandboxHost(),
      lookup: emptyLookup(tmpdir()),
      log: () => {}
    })
    const result = await missing.session(repoId, root, "src/index.ts")
    expect(result).toEqual({ status: "missing", language: "typescript", install: "npm i -g typescript-language-server typescript" })
    expect(missing.list()).toEqual([])
    await missing.killAll()
  })

  test("a file no server handles is unsupported before any process starts", async () => {
    expect(await host.session(repoId, root, "README.md")).toEqual({ status: "unsupported" })
  })
})

describe("mapping the server's shapes once, at the session", () => {
  test("hover contents: MarkupContent, MarkedString, code MarkedString and arrays become one markdown string", () => {
    expect(hoverContents({ kind: "markdown", value: "```ts\nconst a: 1\n```" })).toBe("```ts\nconst a: 1\n```")
    expect(hoverContents("plain")).toBe("plain")
    expect(hoverContents({ language: "typescript", value: "const a: 1" })).toBe("```typescript\nconst a: 1\n```")
    expect(hoverContents(["one", { language: "ts", value: "two" }])).toBe("one\n\n```ts\ntwo\n```")
    expect(hoverContents([]).length).toBe(0)
    expect(hoverContents("x".repeat(10_000)).length).toBe(4096)
  })

  test("diagnostics: 0-based ranges become 1-based, numeric severities and codes become words and text", () => {
    expect(toDiagnostic({
      range: { start: { line: 3, character: 23 }, end: { line: 3, character: 29 } },
      message: "Property 'lenght' does not exist on type 'string'.",
      severity: 2,
      code: 2551,
      source: "typescript",
      relatedInformation: [{ location: { uri: "file:///x", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }, message: "here" }]
    })).toEqual({
      line: 4,
      character: 24,
      endLine: 4,
      endCharacter: 30,
      severity: "warning",
      message: "Property 'lenght' does not exist on type 'string'.",
      source: "typescript",
      code: "2551"
    })
    expect(toDiagnostic({ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, message: "m" })).toEqual({
      line: 1,
      character: 1,
      endLine: 1,
      endCharacter: 1,
      severity: "error",
      message: "m"
    })
  })
})

describe.skipIf(skipReason !== undefined)("the real typescript-language-server over stdio", () => {
  test("hover answers the declared type at a 1-based position, with the token's range", async () => {
    const live = await session()
    const hover = await live.hover("src/index.ts", { line: 3, character: 7 })
    if (hover === null) throw new Error("hover answered null")
    expect(LspHoverSchema.parse(hover)).toEqual(hover)
    expect(hover.contents).toContain("const message: string")
    expect(hover.range).toEqual({ line: 3, character: 7, endLine: 3, endCharacter: 14 })
    expect(live.state).toBe("ready")
    expect(host.list()).toEqual([{ repoId, language: "typescript", state: "ready" }])
    // The seatbelt policy is the one the spawn ran under (Sandbox.test.ts asserts its text).
    const spawnLine = logs.find((line) => line.startsWith(`lsp ${repoId}/typescript: pid`))
    expect(spawnLine).toContain(sandboxEnforced(currentSandboxHost()) ? "(sandbox on)" : "(sandbox off)")
  }, 20_000)

  test("a hover over whitespace answers null, not an empty hover", async () => {
    const live = await session()
    expect(await live.hover("src/index.ts", { line: 2, character: 1 })).toBeNull()
  }, 20_000)

  test("definition answers the declaring file and line, relative to the repository", async () => {
    const live = await session()
    const locations = await live.definition("src/index.ts", { line: 3, character: 17 })
    expect(locations).toEqual([{ path: "src/greet.ts", line: 6, character: 14, endLine: 6, endCharacter: 19 }])
  }, 20_000)

  test("a definition inside a linked package is outside the repository and omitted", async () => {
    const live = await session()
    // `length` on a string is declared in lib.es5.d.ts under node_modules/typescript, a link out of the checkout.
    const locations = await live.definition("src/index.ts", { line: 4, character: 25 })
    expect(locations).toEqual([])
  }, 20_000)

  test("diagnostics answer the deliberate error and the bus carries the same frame on the repository's topic", async () => {
    const live = await session()
    const answer = await live.diagnostics("src/index.ts", 5000)
    expect(LspDiagnosticsResponseSchema.parse(answer)).toEqual(answer)
    expect(answer.path).toBe("src/index.ts")
    expect(answer.items).toHaveLength(1)
    expect(answer.items?.[0]).toMatchObject({ line: 4, character: 24, endLine: 4, endCharacter: 30, severity: "error", code: "2551", source: "typescript" })
    expect(answer.items?.[0]?.message).toContain("lenght")
    const published = frames.map((frame) => LspDiagnosticsMessageSchema.safeParse(frame)).filter((parsed) => parsed.success).map((parsed) => parsed.data)
    const mine = published.find((frame) => frame.path === "src/index.ts")
    expect(mine).toMatchObject({ type: "lsp.diagnostics", repoId, path: "src/index.ts", items: answer.items })
    // A second ask for an unchanged file answers the same publication without waiting for another.
    const started = performance.now()
    expect(await live.diagnostics("src/index.ts", 5000)).toEqual(answer)
    expect(performance.now() - started).toBeLessThan(1000)
  }, 20_000)

  test("a clean file answers an empty list, never null", async () => {
    const live = await session()
    const answer = await live.diagnostics("src/greet.ts", 5000)
    expect(answer.items).toEqual([])
  }, 20_000)

  test("a changed file is re-synced from disk before the next answer", async () => {
    const live = await session()
    await writeFile(join(root, "src", "greet.ts"), "export const greet = (name: string): number => name\n")
    const answer = await live.diagnostics("src/greet.ts", 5000)
    expect(answer.items?.map((item) => item.code)).toEqual(["2322"])
  }, 20_000)

  test("paths are held to the files seam's rules: traversal, out-of-root and missing files are refused with its codes", async () => {
    const live = await session()
    await expect(live.hover("../etc/passwd", { line: 1, character: 1 })).rejects.toMatchObject({ code: "invalid_path", http: 400 })
    await expect(live.hover("src/nope.ts", { line: 1, character: 1 })).rejects.toMatchObject({ code: "path_not_found", http: 404 })
    await expect(live.hover("src", { line: 1, character: 1 })).rejects.toBeInstanceOf(LspRequestError)
  }, 20_000)

  test("one server per (repository, language): a second file reuses the process", async () => {
    const first = await session("src/index.ts")
    const second = await session("src/greet.ts")
    expect(second.pid).toBe(first.pid)
    expect(host.list()).toHaveLength(1)
  })

  test("idle shutdown ends the server cleanly and drops it from the table", async () => {
    const idle = createLspHost({
      publish: () => {},
      node: Promise.resolve(node),
      home: tmpdir(),
      sandbox: currentSandboxHost(),
      idleMs: 1000,
      log: () => {}
    })
    try {
      const result = await idle.session("repo-idle", root, "src/index.ts")
      if (result.status !== "ok") throw new Error(result.status)
      expect(await result.session.hover("src/index.ts", { line: 3, character: 7 })).not.toBeNull()
      const deadline = Date.now() + 10_000
      while (idle.list().length > 0) {
        if (Date.now() > deadline) throw new Error("the idle server never shut down")
        await Bun.sleep(50)
      }
      expect(result.session.state).toBe("exited")
      // LSP shutdown then exit: the server leaves on its own, no signal needed.
      expect(await result.session.exited).toBe(0)
    } finally {
      await idle.killAll()
    }
  }, 20_000)

  test("closeRepo ends the repository's servers and leaves other repositories alone; killAll ends the rest", async () => {
    const other = await host.session("repo-other", root, "src/index.ts")
    if (other.status !== "ok") throw new Error(other.status)
    await other.session.ready
    const mine = await session()
    expect(host.list().map((row) => row.repoId).sort()).toEqual(["repo-fixture", "repo-other"])
    await host.closeRepo(repoId)
    expect(mine.state).toBe("exited")
    expect(host.list()).toEqual([{ repoId: "repo-other", language: "typescript", state: "ready" }])
    await host.killAll()
    expect(other.session.state).toBe("exited")
    expect(host.list()).toEqual([])
    // The next request after a close starts a fresh server.
    const fresh = await session()
    expect(fresh.pid).not.toBe(mine.pid)
    expect(await fresh.hover("src/index.ts", { line: 3, character: 7 })).not.toBeNull()
  }, 30_000)
})
