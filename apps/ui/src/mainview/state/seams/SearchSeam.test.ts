/*
 * The search seam (Search and Command Palette Spec 2026-09-07 §4, §5, §6)
 * against fixture seams: the palette's rows come from what the store holds,
 * the flow doors answer items as data and embed the search-results card for
 * a human, the signed-out scope hides, and a mode whose flow is not
 * registered yet refuses by name.
 */
import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { Card } from "@smthrs/rpc/Cards"
import type { NativeAgent, NativeRepositories } from "../../native/NativeBridge"
import { createAppController } from "../AppController"
import type { AppServices } from "../AppController"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { NO_FOCUSED_FILE, notRegisteredYet } from "./SearchSeam"

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

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const backend = (routes: Record<string, Response>): AppServices => ({
  fetchImpl: async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const absolute = new URL(url, "https://app.test")
    const path = absolute.pathname + absolute.search
    for (const [route, answer] of Object.entries(routes)) {
      if (path === route || path.startsWith(`${route}?`)) return answer.clone()
    }
    return json(404, { status: "error", message: `no stub for ${path}` })
  }
})

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

const identity = async (store: AppStore, state: "signed-in" | "signed-out"): Promise<void> => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state,
    login: state === "signed-in" ? "will" : null,
    allowlisted: state === "signed-in",
    admin: false,
    scopesPlain: null
  })
  await settled()
}

const REPO = "will/flows"

const ready = async (services: AppServices = backend({}), state: "signed-in" | "signed-out" = "signed-out") => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableRepositories, unavailableAgent, services)
  await identity(store, state)
  store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: [{ id: REPO, org: "will", ownerKind: "user", name: "flows", head: null }]
  })
  await settled()
  return { store, controller }
}

let ordinal = 100
const card = (store: AppStore, value: Omit<Card, "createdAt" | "ordinal" | "status">): void => {
  ordinal += 1
  store.dispatch({ type: "card.upsert", actor: "system", card: { ...value, status: "active", createdAt: ordinal, ordinal } as Card })
}

/** The fixture seam: the listing the files seam had already written to the store. */
const seed = async (store: AppStore): Promise<void> => {
  card(store, {
    id: "files-x",
    kind: "file-list",
    title: "files",
    payload: {
      repo: "smithers",
      localRepoId: "r1",
      path: "packages/journal",
      entries: [{ name: "Redaction.ts", kind: "file" }, { name: "Redaction.test.ts", kind: "file" }, { name: "src", kind: "dir" }]
    }
  })
  await settled()
}

const refs = (groups: ReadonlyArray<{ label: string; items: ReadonlyArray<{ item: { ref: string } }> }>, label: string): Array<string> =>
  groups.find((group) => group.label === label)?.items.map((row) => row.item.ref) ?? []

const resultsCard = (store: AppStore, flow: string) => {
  const found = store.collections.cards.get(`search-${flow}`)
  if (found === undefined || found.kind !== "search-results") throw new Error(`no search-results card for ${flow}`)
  return found
}

describe("the palette's rows (the button door) come from what the store holds", () => {
  test("a bare query groups files and flows by kind, files first for a file name", async () => {
    const { store, controller } = await ready()
    await seed(store)
    const answer = controller.searchPalette("redact")
    expect(answer.parsed.mode).toBe("all")
    expect(answer.refusal).toBeUndefined()
    expect(answer.groups.map((group) => group.label)).toEqual(["Files"])
    expect(refs(answer.groups, "Files")).toEqual(["packages/journal/Redaction.ts", "packages/journal/Redaction.test.ts"])
    // A directory is never a file result, and every row names its open flow.
    expect(answer.groups.flatMap((group) => group.items).every((row) => row.item.actions.some((action) => action.role === "open"))).toBe(true)
    expect(refs(controller.searchPalette("appearance").groups, "Flows")).toEqual(["appearance.theme", "appearance.dark-mode"])
  })

  test("a path query reads only the file index, fuzzy per segment", async () => {
    const { store, controller } = await ready()
    await seed(store)
    const answer = controller.searchPalette("journal/Redaction.test")
    expect(answer.parsed.mode).toBe("path")
    expect(answer.groups.map((group) => group.label)).toEqual(["Files"])
    expect(refs(answer.groups, "Files")[0]).toBe("packages/journal/Redaction.test.ts")
  })

  test("/ hands over to the slash tree; ? lists every prefix with the signed-in ones marked", async () => {
    const { controller } = await ready()
    expect(controller.searchPalette("/app")).toMatchObject({ groups: [], flow: "search.flows" })
    const help = controller.searchPalette("?")
    expect(help.help?.map((row) => row.label)).toContain("secret:")
    expect(help.help?.find((row) => row.mode === "boxes")?.available).toBe(false)
  })

  test("an empty query is the pills and the recents, nothing more; a recent item leads on the next query", async () => {
    const { store, controller } = await ready()
    await seed(store)
    expect(controller.searchPalette("").groups.map((group) => group.label)).toEqual(["Recommended"])
    controller.notePaletteItemOpened({ kind: "file", ref: "packages/journal/Redaction.test.ts" })
    await settled()
    expect(controller.searchPalette("").groups.map((group) => group.label)).toEqual(["Recommended", "Recent"])
    expect(refs(controller.searchPalette("redact").groups, "Files")[0]).toBe("packages/journal/Redaction.test.ts")
  })

  test(":120 jumps into the newest file card; without one it says so", async () => {
    const { store, controller } = await ready()
    expect(controller.searchPalette(":120").refusal).toBe(NO_FOCUSED_FILE)
    card(store, { id: "file-1", kind: "file", title: "f", payload: { repo: "smithers", path: "src/index.ts", content: "x", truncated: false } })
    await settled()
    const answer = controller.searchPalette(":120:8")
    expect(answer.groups[0]?.items[0]?.item.actions[0]).toEqual({ flow: "files.read", args: "src/index.ts:120:8", label: "Read a file from a repository", role: "open" })
  })

  test("a mode whose flow is not registered yet refuses in place by name, never with rows, and Enter has no flow to run", async () => {
    const { store, controller } = await ready()
    await seed(store)
    for (const text of ["wiki:redact", "history: retry", "run:run-9", "#412", "@redact", "text:useEffect", "//apps"]) {
      const answer = controller.searchPalette(text)
      expect(answer.groups).toEqual([])
      expect(answer.refusal).toBe(notRegisteredYet(answer.parsed.mode))
      expect(answer.flow).toBeNull()
    }
    expect(notRegisteredYet("wiki")).toBe("search.wiki is not registered yet; this landing searches files and flows.")
  })
})

describe("§4 signed-out scope", () => {
  test("box:, secret: and user: are hidden signed out (no rows, no refusal, no badge)", async () => {
    const { store, controller } = await ready()
    await seed(store)
    expect(controller.searchPalette("box:main")).toMatchObject({ groups: [] })
    expect(controller.searchPalette("box:main").refusal).toBeUndefined()
    expect(controller.searchPalette("secret:NPM").refusal).toBeUndefined()
  })

  test("signed out, the flows a bare query lists are only the ones that work signed out", async () => {
    const { controller } = await ready()
    // Signed out, auth.sign-in is the exclusive recommendation, so it leads in Recommended rather than Flows.
    const answer = controller.searchPalette("sign")
    const names = answer.groups.flatMap((group) => group.items.map((row) => row.item.ref))
    expect(answer.groups[0]?.label).toBe("Recommended")
    expect(names).toContain("auth.sign-in")
    expect(names).not.toContain("auth.sign-out")
  })
})

describe("§6 the flow doors", () => {
  test("a human's search.files embeds the search-results card and answers the items as data", async () => {
    const { store, controller } = await ready()
    await seed(store)
    const outcome = await controller.commands.run("search.files", "Redaction")
    expect(outcome.status).toBe("executed")
    if (outcome.status !== "executed") return
    const value = JSON.parse(outcome.value ?? "{}") as { flow: string; count: number; items: Array<{ kind: string; ref: string }> }
    expect(value.flow).toBe("search.files")
    expect(value.count).toBe(2)
    expect(value.items.map((item) => item.ref)).toEqual(["packages/journal/Redaction.ts", "packages/journal/Redaction.test.ts"])
    const results = resultsCard(store, "search.files")
    expect(results.payload).toMatchObject({ query: "Redaction", flow: "search.files", args: "Redaction" })
    expect(results.payload.items.map((item) => item.ref)).toEqual(value.items.map((item) => item.ref))
  })

  test("the agent's search.files gets the same items as data and no card", async () => {
    const { store, controller } = await ready()
    await seed(store)
    const outcome = await controller.commands.runForAgent("search.files", "Redaction")
    expect(outcome.status).toBe("executed")
    if (outcome.status !== "executed") return
    expect((JSON.parse(outcome.value ?? "{}") as { count: number }).count).toBe(2)
    expect(store.collections.cards.get("search-search.files")).toBeUndefined()
  })

  test("search.flows answers the slash tree as data, and search.open --kinds narrows", async () => {
    const { store, controller } = await ready()
    await seed(store)
    const flows = await controller.commands.run("search.flows", "appearance")
    expect(flows.status).toBe("executed")
    expect(resultsCard(store, "search.flows").payload.items.map((item) => item.ref)).toEqual(["appearance.theme", "appearance.dark-mode"])
    const narrowed = await controller.commands.run("search.open", "redact --kinds flow")
    expect(narrowed.status).toBe("executed")
    expect(resultsCard(store, "search.open").payload.items.every((item) => item.kind === "flow")).toBe(true)
  })

  test("a search flow without its query renders the form (THE FORM LAW), and palette.open refuses the agent by naming search.*", async () => {
    const { controller } = await ready()
    const outcome = await controller.commands.run("search.files")
    expect(outcome).toMatchObject({ status: "form", flow: "search.files", fields: ["query"] })
    const refused = await controller.commands.runForAgent("palette.open")
    expect(refused).toMatchObject({ status: "failed", error: expect.stringContaining("search.*") })
  })

  test("palette.recent answers the ledger as data, most recent first, and the ledger counts repeats", async () => {
    const { controller } = await ready()
    controller.notePaletteItemOpened({ kind: "file", ref: "a.ts" })
    controller.notePaletteItemOpened({ kind: "run", ref: "run-1" })
    controller.notePaletteItemOpened({ kind: "file", ref: "a.ts" })
    await settled()
    const outcome = await controller.commands.runForAgent("palette.recent")
    expect(outcome.status).toBe("executed")
    if (outcome.status !== "executed") return
    const value = JSON.parse(outcome.value ?? "{}") as { items: Array<{ ref: string; count: number }> }
    expect(value.items.map((item) => [item.ref, item.count])).toEqual([["a.ts", 2], ["run-1", 1]])
  })
})
