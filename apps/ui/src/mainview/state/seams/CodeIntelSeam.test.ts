import type { StorageApi } from "@tanstack/db"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RuntimeCapabilitySchema } from "@smthrs/rpc/AppBootstrap"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { CardSchema } from "@smthrs/rpc/Cards"
import { RepoSchema } from "@smthrs/rpc/LocalApp"
import type { Repo } from "@smthrs/rpc/LocalApp"
import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import { resolveServer, TYPESCRIPT_SERVER } from "../../../bun/lsp/LanguageServers"
import { emptyLookup, writeFixtureProject } from "../../../bun/lsp/LspFixture"
import { createLspHost, defaultServerLookup } from "../../../bun/lsp/LspHost"
import { findNode } from "../../../bun/Node"
import { startLocalServer } from "../../../bun/server"
import type { LocalServer, LocalServerOptions } from "../../../bun/server"
import type { NativeAgent, NativeRepositories } from "../../native/NativeBridge"
import { createAppFetch } from "../../runtime/LocalSession"
import { createAppController } from "../AppController"
import type { AppController } from "../AppController"
import type { Card } from "../AppState"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"

/*
 * The code-intel seam (CodeIntelSeam.ts, LspClient.ts) through the real
 * command path against a REAL local origin running the REAL
 * typescript-language-server (code-intel PLAN.md §4, §6): `/code.hover`,
 * `/code.definition` and `/code.diagnostics` answer `{ value }` for the model
 * and patch the human's FILE card; the definition opens its target through
 * files.read's line anchor; a diagnostics publication on `/ws` (`lsp:<repoId>`)
 * patches the card with no request; the missing-server door states the
 * install line on the card and to the model. Absent a language server or a
 * Node sidecar, the spawning tests skip and say why; nothing stands in for
 * the server. The refusal doors (missing server, unsupported file, a Cloud
 * target) need no server and always run.
 */

const node = await findNode()
const probeRoot = await mkdtemp(join(tmpdir(), "smithers-code-intel-probe-"))
const resolved = resolveServer(TYPESCRIPT_SERVER, defaultServerLookup(), probeRoot, node)
await rm(probeRoot, { recursive: true, force: true })
const skipReason = node === null
  ? "no Node.js >= 22.19 on this machine to run the language server"
  : "missing" in resolved
  ? `no typescript-language-server on this machine (install: ${resolved.missing})`
  : undefined
if (skipReason !== undefined) console.warn(`code-intel seam tests skipped: ${skipReason}`)

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableAgent: NativeAgent = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "Local repositories can only be connected from the Smithers native app."
  })
}

/** The native host with every door, `local.lsp` among them. */
const NATIVE: AppBootstrap = {
  apiVersion: 1,
  host: "local",
  version: "test",
  buildSha: "test",
  capabilities: [...RuntimeCapabilitySchema.options],
  authFlow: "both",
  sandbox: null
}

const INSTALL = "npm i -g typescript-language-server typescript"

let dist = ""
let repoDir = ""
const disposers: Array<() => Promise<void> | void> = []

/** One real local origin, the fixture repository opened on it, and the whole app pointed at it. */
const app = async (options: Partial<LocalServerOptions> = {}) => {
  const server: LocalServer = await startLocalServer({
    port: 0,
    distDir: dist,
    chatStub: true,
    allowManualRepositoryPaths: true,
    node,
    home: tmpdir(),
    log: () => {},
    ...options
  })
  disposers.push(() => server.stop())
  const opened = await fetch(`${server.origin}/api/repo/open`, {
    method: "POST",
    headers: { "content-type": "application/json", [LOCAL_SESSION_HEADER]: server.sessionToken },
    body: JSON.stringify({ path: repoDir })
  })
  expect(opened.status).toBe(200)
  const repo: Repo = RepoSchema.parse(((await opened.json()) as { repo: unknown }).repo)
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableRepositories, unavailableAgent, {
    bootstrap: NATIVE,
    baseUrl: server.origin,
    // The page's transport: the per-launch token rides same-origin /api calls and the /ws subprotocol.
    fetchImpl: createAppFetch({ token: server.sessionToken, location: { href: `${server.origin}/`, origin: server.origin } }),
    socketUrl: () => `${server.origin.replace(/^http/, "ws")}/ws`,
    socketProtocols: () => [server.websocketProtocol]
  })
  disposers.push(() => controller.dispose())
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-out",
    login: null,
    allowlisted: false,
    admin: false,
    scopesPlain: null
  })
  store.dispatch({ type: "repos.loaded", actor: "system", repos: [repo] })
  await new Promise((resolve) => setTimeout(resolve, 0))
  return { server, repo, store, controller }
}

type FileCard = Extract<Card, { kind: "file" }>

const fileCard = (store: AppStore, id: string): FileCard | undefined => {
  const card = store.collections.cards.get(id)
  return card?.kind === "file" ? card : undefined
}

const valueOf = (outcome: Awaited<ReturnType<AppController["commands"]["run"]>>): string => {
  expect(outcome.status).toBe("executed")
  return outcome.status === "executed" ? outcome.value ?? "" : ""
}

const until = async (predicate: () => boolean, what: string, deadlineMs = 10_000): Promise<void> => {
  const deadline = Date.now() + deadlineMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "smithers-code-intel-dist-"))
  await writeFile(join(dist, "index.html"), "<!doctype html><title>Smithers</title>")
  repoDir = await realpath(await mkdtemp(join(tmpdir(), "smithers-code-intel-repo-")))
  await writeFixtureProject(repoDir)
})

afterAll(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  await rm(dist, { recursive: true, force: true })
  await rm(repoDir, { recursive: true, force: true })
})

describe("code-intel seam — refusals that need no language server", () => {
  test("a missing language server states the install line on the card and to the model, and starts nothing", async () => {
    const { server, repo, store, controller } = await app({
      lsp: (deps) => createLspHost({ ...deps, lookup: emptyLookup(tmpdir()) })
    })
    const outcome = await controller.commands.run("code.hover", "src/index.ts:3:7")
    expect(outcome).toEqual({ status: "failed", error: `No TypeScript language server on this machine. Install: ${INSTALL}` })
    const card = fileCard(store, `file-${repo.name}-src/index.ts`)
    // The file card rendered (the human sees the file at the position) and states the door honestly.
    expect(card?.payload).toMatchObject({ path: "src/index.ts", line: 3, column: 7, intel: { state: "missing", note: INSTALL } })
    expect(card?.payload.hover).toBeUndefined()
    expect(CardSchema.safeParse(card).success).toBe(true)
    const servers = await fetch(`${server.origin}/api/lsp/servers`, { headers: { [LOCAL_SESSION_HEADER]: server.sessionToken } })
    expect(await servers.json()).toEqual({ servers: [] })
    // The agent door reads the same sentence.
    const agent = await controller.commands.executeForAgent({
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "code.diagnostics", args: "src/index.ts" })
    })
    expect(agent).toBe(`failed: No TypeScript language server on this machine. Install: ${INSTALL}`)
  }, 30_000)

  test("a file no server handles answers the host's typed refusal, stated on the card as unavailable", async () => {
    const { repo, store, controller } = await app()
    const outcome = await controller.commands.run("code.diagnostics", "README.md")
    expect(outcome).toEqual({ status: "failed", error: "No language server handles .md files." })
    expect(fileCard(store, `file-${repo.name}-README.md`)?.payload.intel).toEqual({
      state: "unavailable",
      note: "No language server handles .md files."
    })
  }, 30_000)

  test("a Cloud target is refused honestly: Smithers Cloud relays no language server yet", async () => {
    const { controller, store } = await app()
    // A cloud file card already on screen learns the state, so its gestures unbind (FileCards L4) instead of refusing on every pointer rest.
    store.dispatch({
      type: "card.upsert",
      actor: "smithers",
      card: {
        id: "file-will/flows-src/x.ts",
        kind: "file",
        title: "File · will/flows · src/x.ts",
        status: "active",
        createdAt: 1,
        ordinal: 1,
        payload: { repo: "will/flows", path: "src/x.ts", content: "export {}\n", truncated: false }
      }
    })
    expect(await controller.commands.run("code.hover", "src/x.ts:1:1 will/flows")).toEqual({
      status: "failed",
      error: "Hover and definitions need a workspace language server; Smithers Cloud does not relay one yet."
    })
    expect(fileCard(store, "file-will/flows-src/x.ts")?.payload.intel).toEqual({
      state: "unavailable",
      note: "Hover and definitions need a workspace language server; Smithers Cloud does not relay one yet."
    })
    expect(await controller.commands.run("code.diagnostics", "src/x.ts will/flows")).toEqual({
      status: "failed",
      error: "Diagnostics need a workspace language server; Smithers Cloud does not relay one yet."
    })
    expect(await controller.commands.run("code.definition", "../etc/passwd:1:1")).toEqual({
      status: "failed",
      error: "File paths must stay inside the repository."
    })
  }, 30_000)
})

describe.skipIf(skipReason !== undefined)("code-intel seam — against the real typescript-language-server", () => {
  let repo: Repo
  let store: AppStore
  let controller: AppController
  const cardId = (path: string): string => `file-${repo.name}-${path}`

  beforeAll(async () => {
    ;({ repo, store, controller } = await app())
  })

  test("/code.hover answers the type as { value } and patches the open file card's hover", async () => {
    valueOf(await controller.commands.run("files.read", "src/index.ts"))
    const value = valueOf(await controller.commands.run("code.hover", "src/index.ts:3:7"))
    expect(value).toStartWith(`src/index.ts:3:7 in ${repo.name}\n`)
    expect(value).toContain("const message: string")
    const card = fileCard(store, cardId("src/index.ts"))
    expect(card?.payload.hover).toEqual({ line: 3, character: 7, contents: expect.stringContaining("const message: string") })
    expect(card?.payload.intel).toEqual({ state: "ready" })
    // The read's own fields survive the patch: the card is the same card.
    expect(card?.payload.content).toContain("message.lenght")
    expect(card?.payload.line).toBeUndefined()
    expect(CardSchema.safeParse(card).success).toBe(true)
  }, 30_000)

  test("a position the server has nothing for is stated, and the card's hover is cleared to null", async () => {
    const value = valueOf(await controller.commands.run("code.hover", "src/index.ts:2:1"))
    expect(value).toBe(`The language server has nothing at src/index.ts:2:1 in ${repo.name}.`)
    expect(fileCard(store, cardId("src/index.ts"))?.payload.hover).toBeNull()
  }, 30_000)

  test("hover on a file with no card renders the file card at the position first", async () => {
    expect(store.collections.cards.get(cardId("src/greet.ts"))).toBeUndefined()
    const value = valueOf(await controller.commands.run("code.hover", "src/greet.ts:6:14"))
    expect(value).toContain("const greet:")
    const card = fileCard(store, cardId("src/greet.ts"))
    expect(card?.payload).toMatchObject({ path: "src/greet.ts", line: 6, column: 14, intel: { state: "ready" } })
    expect(card?.payload.hover?.contents).toContain("const greet:")
  }, 30_000)

  test("/code.definition answers path:line:col and opens the target file card at its line", async () => {
    const value = valueOf(await controller.commands.run("code.definition", "src/index.ts:3:17"))
    expect(value).toBe(`src/index.ts:3:17 in ${repo.name} is defined at:\nsrc/greet.ts:6:14`)
    const target = fileCard(store, cardId("src/greet.ts"))
    expect(target?.payload).toMatchObject({ path: "src/greet.ts", line: 6, column: 14 })
    expect(target?.payload.content).toContain("export const greet")
    // A symbol with no definition is stated, not invented.
    expect(valueOf(await controller.commands.run("code.definition", "src/index.ts:2:1"))).toBe(
      `No definition found for src/index.ts:2:1 in ${repo.name}.`
    )
  }, 30_000)

  test("/code.diagnostics answers the rows and patches the card; a /ws publication then patches it with no request", async () => {
    /*
     * The route answers the server's latest publication for the file, and
     * tsserver publishes in passes (syntactic, semantic, suggestions), so the
     * deliberate error is awaited across calls rather than pinned to the
     * first answer; the shape of the answer is what is asserted.
     */
    let value = ""
    const deadline = Date.now() + 10_000
    while (!value.includes("2551")) {
      if (Date.now() > deadline) throw new Error(`the deliberate diagnostic never arrived; last answer: ${value}`)
      value = valueOf(await controller.commands.run("code.diagnostics", "src/index.ts"))
    }
    expect(value.split("\n")[0]).toMatch(/^src\/index\.ts in .+: \d+ diagnostics?$/)
    expect(value).toContain(` in ${repo.name}: `)
    expect(value).toContain("4:24 error Property 'lenght' does not exist on type 'string'. Did you mean 'length'? (typescript 2551)")
    const card = fileCard(store, cardId("src/index.ts"))
    expect(card?.payload.intel).toEqual({ state: "ready" })
    expect(card?.payload.diagnostics?.find((item) => item.code === "2551")).toMatchObject({ line: 4, character: 24, severity: "error" })
    // A second error lands on disk; a hover re-reads the file, the server publishes, and the
    // subscription on lsp:<repoId> patches the card's diagnostics — code.diagnostics never ran again.
    const indexPath = join(repoDir, "src", "index.ts")
    await writeFile(indexPath, `${await Bun.file(indexPath).text()}const other: number = "x"\n`)
    valueOf(await controller.commands.run("code.hover", "src/index.ts:3:7"))
    const codes = (): ReadonlyArray<string | undefined> => (fileCard(store, cardId("src/index.ts"))?.payload.diagnostics ?? []).map((item) => item.code)
    await until(() => codes().includes("2322"), "the published diagnostics")
    // The publication is what the server said, hints included ('other' is declared but never read), never a filtered copy.
    expect(codes()).toEqual(expect.arrayContaining(["2551", "2322"]))
    expect(fileCard(store, cardId("src/index.ts"))?.payload.diagnostics?.find((item) => item.code === "2322")).toMatchObject({ line: 8, severity: "error" })
    expect(CardSchema.safeParse(fileCard(store, cardId("src/index.ts"))).success).toBe(true)
  }, 30_000)

  test("the agent door: the tool call answers the hover text, never a bare executed", async () => {
    const result = await controller.commands.executeForAgent({
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "code.hover", args: "src/index.ts:3:7" })
    })
    expect(result).toContain("const message: string")
    expect(result).not.toStartWith("executed")
    expect(result).not.toStartWith("failed")
  }, 30_000)
})
