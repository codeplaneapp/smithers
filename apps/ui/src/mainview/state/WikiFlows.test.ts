import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge"
import { createAppController } from "./AppController"
import { createAppStore } from "./AppStore"

/*
 * The vault kit's three flows (Librarian L5) through the one run path, each
 * by both actors. wiki.open: the human's act selects the note and opens the
 * pane; the agent's act embeds the note as a world card and leaves the
 * surface alone (THE EMBED LAW). wiki.backlinks: a read, so both actors get
 * the same embedded rail card. wiki.graph: the human's act switches the
 * pane to graph mode and toggles back; the agent's embeds the graph card.
 * A path no note answers refuses with the note's name in the reason, from
 * every door.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const silentAgent: NativeAgent = {
  available: true,
  startTurn: async () => ({ status: "started" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const noRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({ status: "cancelled" })
}

const setup = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, noRepositories, silentAgent, {
    fetchImpl: async () => new Response("{}", { status: 200 })
  })
  await store.dispatch({
    type: "world.document.upserted",
    actor: "user",
    select: false,
    document: {
      id: "plans",
      path: "Plans.md",
      title: "Plans",
      body: "# Plans\n\nSee [[World]] and [[Ghost]].\n\n## Next\n\nShip.",
      links: ["World", "Ghost"],
      tags: [],
      sources: [],
      confidence: 0.8
    }
  }).isPersisted.promise
  return { store, controller }
}

describe("wiki.open", () => {
  test("the user's act selects the note by title and opens the pane in document mode", async () => {
    const { store, controller } = await setup()
    expect(store.session().surface).toBe("chat")
    expect((await controller.commands.run("wiki.open", "plans")).status).toBe("executed")
    expect(store.session().surface).toBe("world")
    expect(store.session().selectedWorldDocumentId).toBe("plans")
    expect(store.session().wikiPane).toBe("document")
    controller.dispose()
  })

  test("the agent's act embeds the one note as a world card and leaves the surface alone", async () => {
    const { store, controller } = await setup()
    expect((await controller.commands.runForAgent("wiki.open", "Plans.md")).status).toBe("executed")
    expect(store.session().surface).toBe("chat")
    const card = store.collections.cards.get("wiki-open-plans")
    expect(card?.kind).toBe("world")
    expect(card?.kind === "world" ? card.payload.documents.map((row) => row.path) : []).toEqual(["Plans.md"])
    controller.dispose()
  })

  test("a path no note answers refuses with the reason, from either door", async () => {
    const { store, controller } = await setup()
    const user = await controller.commands.run("wiki.open", "Nowhere.md")
    expect(user.status).toBe("failed")
    expect(user.status === "failed" ? user.error : "").toContain("There is no Wiki note at Nowhere.md")
    const agent = await controller.commands.runForAgent("wiki.open", "Nowhere.md")
    expect(agent.status).toBe("failed")
    expect(store.session().surface).toBe("chat")
    expect(store.collections.cards.size).toBe(0)
    controller.dispose()
  })
})

describe("wiki.backlinks", () => {
  test("either actor gets the rail card: who links here, where it links out, and the targets no note answers", async () => {
    const { store, controller } = await setup()
    expect((await controller.commands.run("wiki.backlinks", "World.md")).status).toBe("executed")
    const home = store.collections.cards.get("wiki-links-world-home")
    expect(home?.kind).toBe("wiki-links")
    if (home?.kind !== "wiki-links") throw new Error("no rail card")
    expect(home.payload.backlinks).toEqual([{ path: "Plans.md", title: "Plans" }])
    expect(home.payload.linksOut).toEqual([])
    expect((await controller.commands.runForAgent("wiki.backlinks", "Plans")).status).toBe("executed")
    const plans = store.collections.cards.get("wiki-links-plans")
    if (plans?.kind !== "wiki-links") throw new Error("no rail card")
    expect(plans.payload.linksOut).toEqual([{ path: "World.md", title: "World" }])
    expect(plans.payload.unresolved).toEqual(["Ghost"])
    expect(store.session().surface).toBe("chat")
    controller.dispose()
  })

  test("without a path the door renders the form, never a usage sentence", async () => {
    const { controller } = await setup()
    expect(await controller.commands.run("wiki.backlinks")).toMatchObject({ status: "form", flow: "wiki.backlinks", fields: ["path"] })
    controller.dispose()
  })
})

describe("wiki.graph", () => {
  test("the user's act opens the pane in graph mode, focuses on a note, and toggles back", async () => {
    const { store, controller } = await setup()
    expect((await controller.commands.run("wiki.graph")).status).toBe("executed")
    expect(store.session().surface).toBe("world")
    expect(store.session().wikiPane).toBe("graph")
    expect(store.session().wikiGraphPath).toBeNull()
    expect((await controller.commands.run("wiki.graph", "Plans")).status).toBe("executed")
    expect(store.session().wikiPane).toBe("graph")
    expect(store.session().wikiGraphPath).toBe("Plans.md")
    // The same call again returns to the editor (toggles toggle).
    expect((await controller.commands.run("wiki.graph", "Plans.md")).status).toBe("executed")
    expect(store.session().wikiPane).toBe("document")
    expect(store.session().wikiGraphPath).toBeNull()
    // Opening a note from graph mode returns the pane to the editor too.
    expect((await controller.commands.run("wiki.graph")).status).toBe("executed")
    expect((await controller.commands.run("wiki.open", "Plans")).status).toBe("executed")
    expect(store.session().wikiPane).toBe("document")
    controller.dispose()
  })

  test("the agent's act embeds the graph card, whole or around one note, with the dangling target as a missing node", async () => {
    const { store, controller } = await setup()
    expect((await controller.commands.runForAgent("wiki.graph")).status).toBe("executed")
    expect(store.session().surface).toBe("chat")
    const whole = store.collections.cards.get("wiki-graph")
    if (whole?.kind !== "wiki-graph") throw new Error("no graph card")
    expect(whole.payload.path).toBeNull()
    expect(whole.payload.notes.map((note) => [note.path, note.missing])).toEqual([
      ["Plans.md", false],
      ["World.md", false],
      ["Ghost.md", true]
    ])
    expect(whole.payload.links).toEqual([
      { source: "Plans.md", target: "World.md" },
      { source: "Plans.md", target: "Ghost.md" }
    ])
    expect((await controller.commands.runForAgent("wiki.graph", "World")).status).toBe("executed")
    const around = store.collections.cards.get("wiki-graph-world-home")
    if (around?.kind !== "wiki-graph") throw new Error("no focused graph card")
    expect(around.payload.path).toBe("World.md")
    expect(around.payload.notes.map((note) => note.path)).toEqual(["Plans.md", "World.md"])
    expect(around.payload.links).toEqual([{ source: "Plans.md", target: "World.md" }])
    const missing = await controller.commands.runForAgent("wiki.graph", "Nowhere")
    expect(missing.status).toBe("failed")
    controller.dispose()
  })
})
