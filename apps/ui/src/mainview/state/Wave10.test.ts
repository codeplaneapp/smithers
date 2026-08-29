import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { AgentTurnFrame, StartAgentTurnRequest } from "smithers-shared/NativeAgent"
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge"
import { createAppController } from "./AppController"
import type { AppServices } from "./AppController"
import { createAppStore } from "./AppStore"

/*
 * Wave 10 — the onboarding conversation (repos.watch), the watched set, the
 * embed law's in-app half, transcript hygiene, /clear's sweep, and the
 * sign-in-is-the-connector truth (§2a′). Controller-level, against honest
 * fetch doubles.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const webStore = () => createAppStore({ kind: "localStorage", storage: memoryStorage() })

const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "Local repositories can only be connected from the Smithers native app."
  })
}

const silentAgent = (): NativeAgent => ({
  available: true,
  startTurn: async () => ({ status: "started" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
})

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const backend = (
  routes: Record<string, Response | ((request: Request) => Response | Promise<Response>)>,
  calls: Array<{ path: string; method: string; body: unknown }> = []
): AppServices => ({
  fetchImpl: async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const absolute = new URL(url, "https://app.test")
    const path = absolute.pathname + absolute.search
    calls.push({
      path,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    })
    for (const [route, answer] of Object.entries(routes)) {
      if (path === route || path.startsWith(`${route}?`)) {
        return typeof answer === "function"
          ? answer(new Request(absolute.toString(), init))
          : answer.clone()
      }
    }
    return json(404, { status: "error", message: `no stub for ${path}` })
  }
})

const CANDIDATES = [
  { fullName: "will/flows", private: false, pushedAt: "2026-08-07T12:00:00.000Z", openIssues: 4 },
  { fullName: "will/smithers", private: false, pushedAt: "2026-08-06T09:00:00.000Z", openIssues: 2 },
  { fullName: "will/mvp", private: true, pushedAt: "2026-08-05T18:00:00.000Z", openIssues: 1 }
]

const signIn = async (store: Awaited<ReturnType<typeof webStore>>): Promise<void> => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "will",
    allowlisted: true,
    admin: false,
    scopesPlain: null
  })
  await settled()
}

/** A scripted tool-loop agent (the ToolLoop.test.ts pattern). */
const scriptedToolAgent = (
  steps: ReadonlyArray<(request: StartAgentTurnRequest) => ReadonlyArray<Omit<AgentTurnFrame, "runId">>>
): { agent: NativeAgent; requests: Array<StartAgentTurnRequest> } => {
  const listeners = new Set<(frame: AgentTurnFrame) => void>()
  const requests: Array<StartAgentTurnRequest> = []
  let step = 0
  return {
    requests,
    agent: {
      available: true,
      startTurn: async (request) => {
        requests.push(request)
        const frames = (steps[Math.min(step, steps.length - 1)] ?? (() => []))(request)
        step += 1
        queueMicrotask(() => {
          for (const frame of frames) {
            for (const listener of listeners) listener({ ...frame, runId: request.runId } as AgentTurnFrame)
          }
        })
        return { status: "started" }
      },
      cancelTurn: async () => {},
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
  }
}

describe("wave 10 — the onboarding conversation", () => {
  test("never-chosen opens the chooser card with the inline candidates, on a welcome line", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      ...backend({
        "/api/identity/watched": json(200, { selected: null, selectedAt: null, via: null }),
        "/api/identity/repos": json(200, { candidates: CANDIDATES, cached: false })
      })
    })
    await signIn(store)
    await controller.openFirstRunRepos()

    const card = store.collections.cards.get("repo-chooser")
    expect(card?.kind).toBe("repo-chooser")
    if (card?.kind === "repo-chooser") {
      expect(card.payload.candidates.map((candidate) => candidate.fullName)).toEqual([
        "will/flows",
        "will/smithers",
        "will/mvp"
      ])
      expect(card.payload.selected).toEqual([])
      expect(card.payload.via).toBe("onboarding")
      expect(card.payload.phase).toBe("choosing")
    }
    // The welcome is the one question, and the chooser is the only card.
    expect(store.collections.messages.get("message-onboarding")?.text).toContain("choose which repositories")
    expect([...store.collections.cards.values()].map((c) => c.kind)).toEqual(["repo-chooser"])
    // The agent context says "unselected" — repo work routes to the chooser.
    expect(controller.commands.state().needsSelection).toBe(true)
  })

  test("toggle/all/none and confirm: PUT carries the selection with via onboarding, and the mirror lands", async () => {
    const store = await webStore()
    const calls: Array<{ path: string; method: string; body: unknown }> = []
    let selected: Array<string> = []
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      ...backend(
        {
          "/api/identity/repos": json(200, { candidates: CANDIDATES, cached: false }),
          "/api/identity/watched": (request) => {
            if (request.method === "PUT") {
              return json(200, {
                selected,
                selectedAt: "2026-08-09T10:00:00.000Z",
                via: "onboarding"
              })
            }
            return json(200, { selected: null, selectedAt: null, via: null })
          }
        },
        calls
      )
    })
    await signIn(store)
    await controller.openFirstRunRepos()

    // Toggle one, all, none, then the two the user wants.
    await controller.commands.run("repos.watch.toggle", "will/flows")
    expect(
      store.collections.cards.get("repo-chooser")?.kind === "repo-chooser" &&
        (store.collections.cards.get("repo-chooser") as Extract<
          NonNullable<ReturnType<typeof store.collections.cards.get>>,
          { kind: "repo-chooser" }
        >).payload.selected
    ).toEqual(["will/flows"])
    await controller.commands.run("repos.watch.all")
    let card = store.collections.cards.get("repo-chooser")
    expect(card?.kind === "repo-chooser" ? card.payload.selected : []).toHaveLength(3)
    await controller.commands.run("repos.watch.none")
    card = store.collections.cards.get("repo-chooser")
    expect(card?.kind === "repo-chooser" ? card.payload.selected : ["x"]).toEqual([])
    await controller.commands.run("repos.watch.toggle", "will/flows")
    await controller.commands.run("repos.watch.toggle", "will/mvp")

    selected = ["will/flows", "will/mvp"]
    const outcome = await controller.commands.run("repos.watch.confirm")
    expect(outcome.status).toBe("executed")
    await settled()
    await settled()

    // The PUT carried the selection with via:"onboarding".
    const put = calls.find((call) => call.path === "/api/identity/watched" && call.method === "PUT")
    expect(put?.body).toEqual({ selected: ["will/flows", "will/mvp"], via: "onboarding" })

    // The chooser left; the one calm line names the set AND that asking changes it.
    expect(store.collections.cards.get("repo-chooser")).toBeUndefined()
    const confirm = [...store.collections.messages.values()].find((message) =>
      message.text.includes("change this anytime")
    )
    expect(confirm?.text).toContain("Watching 2 repositories: will/flows, will/mvp")
    expect(confirm?.text).toContain("just ask")

    // The local mirror landed; the transcript holds the one calm line, no more.
    await settled()
    expect(store.collections.watchedRepos.get("watched")?.selected).toEqual(["will/flows", "will/mvp"])
    expect(store.collections.watchedRepos.get("watched")?.via).toBe("onboarding")
    expect(controller.commands.state().needsSelection).toBe(false)
  })

  test("re-running /repos.watch reopens the chooser pre-filled with the current selection (via command)", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      ...backend({
        "/api/identity/watched": json(200, {
          selected: ["will/flows"],
          selectedAt: "2026-08-09T09:00:00.000Z",
          via: "onboarding"
        }),
        "/api/identity/repos": json(200, { candidates: CANDIDATES, cached: false })
      })
    })
    await signIn(store)
    const outcome = await controller.commands.run("repos.watch")
    expect(outcome.status).toBe("executed")
    const card = store.collections.cards.get("repo-chooser")
    expect(card?.kind).toBe("repo-chooser")
    if (card?.kind === "repo-chooser") {
      expect(card.payload.selected).toEqual(["will/flows"])
      expect(card.payload.via).toBe("command")
      expect(card.payload.candidates).toHaveLength(3)
    }
  })

  test("the agent path: 'watch my flows repo too' resolves to the same command, pre-selected, via agent", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      ...backend({
        "/api/identity/watched": json(200, {
          selected: ["will/mvp"],
          selectedAt: "2026-08-09T09:00:00.000Z",
          via: "onboarding"
        }),
        "/api/identity/repos": json(200, { candidates: CANDIDATES, cached: false })
      })
    })
    await signIn(store)
    const result = await controller.commands.executeForAgent({
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "repos.watch", args: "will/flows" })
    })
    expect(result).toBe("executed /repos.watch")
    const card = store.collections.cards.get("repo-chooser")
    expect(card?.kind).toBe("repo-chooser")
    if (card?.kind === "repo-chooser") {
      // Pre-selected on top of the current set; the actor is recorded as agent.
      expect(card.payload.selected).toEqual(["will/mvp", "will/flows"])
      expect(card.payload.via).toBe("agent")
    }
  })

  test("an unknown pre-select is stated honestly and the chooser still opens", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      ...backend({
        "/api/identity/watched": json(200, { selected: null, selectedAt: null, via: null }),
        "/api/identity/repos": json(200, { candidates: CANDIDATES, cached: false })
      })
    })
    await signIn(store)
    const result = await controller.commands.executeForAgent({
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "repos.watch", args: "will/nope" })
    })
    expect(result).toContain("will/nope")
    expect(store.collections.cards.get("repo-chooser")?.kind).toBe("repo-chooser")
  })

  test("chose-zero is a real selection that mirrors empty — no chooser, no fabricated onboarding", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      ...backend({
        "/api/identity/watched": json(200, { selected: [], selectedAt: "2026-08-09T09:00:00.000Z", via: "command" })
      })
    })
    await signIn(store)
    await controller.openFirstRunRepos()
    expect(store.collections.watchedRepos.get("watched")?.selected).toEqual([])
    expect(store.collections.cards.get("repo-chooser")).toBeUndefined()
    expect(store.collections.messages.get("message-onboarding")).toBeUndefined()
    expect(controller.commands.state().needsSelection).toBe(false)
  })

  test("a failed confirm leaves the chooser open in honest error, retryable", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      ...backend({
        "/api/identity/repos": json(200, { candidates: CANDIDATES, cached: false }),
        "/api/identity/watched": (request) =>
          request.method === "PUT"
            ? json(400, {
              code: "unknown_repos",
              unknown: ["will/flows"],
              message: "unknown repositories"
            })
            : json(200, { selected: null, selectedAt: null, via: null })
      })
    })
    await signIn(store)
    await controller.openFirstRunRepos()
    await controller.commands.run("repos.watch.toggle", "will/flows")
    await controller.commands.run("repos.watch.confirm")
    const card = store.collections.cards.get("repo-chooser")
    expect(card?.status).toBe("error")
    if (card?.kind === "repo-chooser") {
      expect(card.payload.phase).toBe("failed")
      expect(card.payload.error).toContain("unknown repositories")
    }
  })
})

describe("wave 10 — the embed law's in-app half (§2c″)", () => {
  test("'what is in world?' through the tool double: the answer + an embedded card; the surface NEVER changes", async () => {
    const store = await webStore()
    const { agent } = scriptedToolAgent([
      () => [
        {
          type: "tool_call" as const,
          call_id: "call_1",
          name: "commands",
          arguments: JSON.stringify({ action: "execute", name: "world" })
        },
        { type: "done" as const, reason: "tool_call" as const }
      ],
      () => [
        { type: "delta" as const, kind: "text" as const, text: "World holds 1 note: World." },
        { type: "done" as const }
      ]
    ])
    const controller = createAppController(store, unavailableRepositories, agent)
    controller.send("what is in world?")
    await settled()
    await settled()

    // The surface never left the chat — a takeover is structurally unavailable to the agent.
    expect(store.session().surface).toBe("chat")
    // The embedded world card rendered in the transcript.
    const card = store.collections.cards.get("world-embedded")
    expect(card?.kind).toBe("world")
    if (card?.kind === "world") {
      expect(card.payload.documents.map((document) => document.path)).toContain("World.md")
    }
    // The answer text arrived beside it, and the act line is one compact line.
    const texts = [...store.collections.messages.values()].map((message) => message.text)
    expect(texts.some((text) => text.includes("World holds 1 note"))).toBe(true)
    expect(texts).toContain("Smithers ran /world")
  })

  test("the agent's connect invocation renders the embedded connect card, not the pane", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent())
    await signIn(store)
    const result = await controller.commands.executeForAgent({
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "connect" })
    })
    expect(result).toBe("executed /connect")
    expect(store.session().surface).toBe("chat")
    const card = store.collections.cards.get("connect-embedded")
    expect(card?.kind).toBe("connect")
    if (card?.kind === "connect") {
      // Sign-in IS the connector (§2a′): the signed-in session reads Connected.
      expect(card.payload.github).toEqual({ connected: true, login: "will" })
    }
  })
})

describe("wave 10 — transcript hygiene (§2b)", () => {
  test("a tool act is one compact line; a raw JSON payload can never reach transcript text", async () => {
    const store = await webStore()
    const { agent } = scriptedToolAgent([
      () => [
        {
          type: "tool_call" as const,
          call_id: "call_1",
          name: "commands",
          arguments: JSON.stringify({ action: "list" })
        },
        { type: "done" as const, reason: "tool_call" as const }
      ],
      () => [
        { type: "delta" as const, kind: "text" as const, text: "Here is what I can do." },
        { type: "done" as const }
      ]
    ])
    const controller = createAppController(store, unavailableRepositories, agent)
    controller.send("what can you do?")
    await settled()
    await settled()

    const texts = [...store.collections.messages.values()].map((message) => message.text)
    expect(texts).toContain("Smithers checked what it can do here")
    for (const text of texts) {
      expect(text).not.toContain("{\"state\"")
      expect(text).not.toContain("\"commands\":[")
    }
    // The act line's actor is smithers, never the user.
    const act = [...store.collections.messages.values()].find((message) => message.act !== undefined)
    expect(act?.role).toBe("smithers")
    // The full-fidelity record lives in the tool-call stream for the admin panel.
    const records = [...store.collections.toolCalls.values()]
    expect(records).toHaveLength(1)
    expect(records[0]?.result).toContain("\"state\"")
  })
})

describe("wave 10 — /clear sweeps before it clears (§2h)", () => {
  test("sweep → world notes → clear, in that order, with the one calm confirm line", async () => {
    const store = await webStore()
    const calls: Array<{ path: string; method: string; body: unknown }> = []
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      ...backend(
        {
          "/api/model/stream": () =>
            new Response(
              `${
                JSON.stringify({
                  runId: "sweep",
                  type: "delta",
                  kind: "text",
                  text:
                    "{\"notes\":[{\"title\":\"Prefers dark mode\",\"body\":\"The user keeps the app in dark mode.\",\"confidence\":0.9}]}"
                })
              }\n${JSON.stringify({ runId: "sweep", type: "done" })}\n`,
              { status: 200, headers: { "content-type": "application/x-ndjson" } }
            )
        },
        calls
      )
    })
    await signIn(store)
    controller.send("remember that I prefer dark mode")
    await settled()
    // There is a real transcript to sweep. Wave 14 §1 removed the seeded
    // welcome, so this is the user's own turn and nothing else.
    const beforeClear = [...store.collections.messages.values()]
    expect(beforeClear.length).toBeGreaterThan(0)
    expect(beforeClear.some((message) => message.text === "remember that I prefer dark mode")).toBe(true)

    const outcome = await controller.commands.run("clear")
    expect(outcome.status).toBe("executed")
    await settled()

    // The sweep is a model call, so it rode the one metered model route.
    expect(calls.some((call) => call.path === "/api/model/stream" && call.method === "POST")).toBe(true)
    // The note landed in world with the house provenance BEFORE the clear.
    const notes = [...store.collections.worldDocuments.values()].filter((document) =>
      document.sources.includes("chat-sweep")
    )
    expect(notes).toHaveLength(1)
    expect(notes[0]?.title).toBe("Prefers dark mode")
    expect(notes[0]?.updatedBy).toBe("smithers")
    expect(notes[0]?.confidence).toBe(0.9)
    const journal = [...store.collections.transitions.values()].sort((a, b) => a.revision - b.revision)
    const upsertRevision = journal.find((record) => record.type === "world.document.upserted")?.revision ?? 0
    const clearedRevision = journal.find((record) => record.type === "conversation.cleared")?.revision ?? 0
    expect(upsertRevision).toBeLessThan(clearedRevision)
    // The chat is cleared and the one line states what was kept.
    const messages = [...store.collections.messages.values()]
    expect(messages).toHaveLength(1)
    expect(messages[0]?.text).toBe("Saved 1 note to World. Cleared.")
  })

  test("a failed sweep leaves the chat UNcleared with an honest line", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      ...backend({
        "/api/model/stream": json(500, { status: "error", message: "chat upstream down" })
      })
    })
    await signIn(store)
    controller.send("some conversation worth keeping")
    await settled()
    const before = [...store.collections.messages.values()].length

    await controller.commands.run("clear")
    await settled()

    const messages = [...store.collections.messages.values()]
    expect(messages.length).toBe(before + 1)
    expect(messages.some((message) => message.text.includes("left it exactly as it was"))).toBe(true)
    expect([...store.collections.transitions.values()].some((record) => record.type === "conversation.cleared")).toBe(
      false
    )
  })

  test("a transcript with nothing worth keeping clears with the zero-kept line", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      ...backend({
        "/api/model/stream": () =>
          new Response(
            `${JSON.stringify({ runId: "sweep", type: "delta", kind: "text", text: "{\"notes\":[]}" })}\n${
              JSON.stringify({ runId: "sweep", type: "done" })
            }\n`,
            { status: 200, headers: { "content-type": "application/x-ndjson" } }
          )
      })
    })
    await signIn(store)
    controller.send("hi")
    await settled()
    await controller.commands.run("clear")
    const messages = [...store.collections.messages.values()]
    expect(messages).toHaveLength(1)
    expect(messages[0]?.text).toBe("Cleared — there was nothing new worth keeping.")
  })
})

describe("wave 10 — the browser tool (§2d)", () => {
  test("the agent's browser call returns the extracted text and renders the embedded card", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      ...backend({
        "/api/tools/browser-fetch": json(200, {
          status: 200,
          finalUrl: "https://example.com/",
          contentType: "text/html",
          text: "Example Domain — for use in examples.",
          frameable: true,
          blockReason: null
        })
      })
    })
    await signIn(store)
    const result = await controller.commands.executeForAgent({
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "browser", args: "https://example.com/" })
    })
    expect(result).toContain("Example Domain")
    const card = store.collections.cards.get("browser-https://example.com/")
    expect(card?.kind).toBe("browser")
    if (card?.kind === "browser") {
      expect(card.payload.frameable).toBe(true)
      expect(card.payload.status).toBe(200)
    }
  })

  test("a site that refuses framing lands the honest blocked state on the card", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      ...backend({
        "/api/tools/browser-fetch": json(200, {
          status: 200,
          finalUrl: "https://x.com/",
          contentType: "text/html",
          text: "",
          frameable: false,
          blockReason: "The site refuses embedding (X-Frame-Options: DENY)."
        })
      })
    })
    await signIn(store)
    await controller.commands.run("browser", "https://x.com/")
    const card = store.collections.cards.get("browser-https://x.com/")
    expect(card?.kind).toBe("browser")
    if (card?.kind === "browser") {
      expect(card.payload.frameable).toBe(false)
      expect(card.payload.blockReason).toContain("X-Frame-Options")
    }
  })

  test("the browser act line names the host, never the payload", async () => {
    const store = await webStore()
    const { agent } = scriptedToolAgent([
      () => [
        {
          type: "tool_call" as const,
          call_id: "call_1",
          name: "commands",
          arguments: JSON.stringify({ action: "execute", name: "browser", args: "https://example.com/" })
        },
        { type: "done" as const, reason: "tool_call" as const }
      ],
      () => [
        { type: "delta" as const, kind: "text" as const, text: "The page says: Example Domain." },
        { type: "done" as const }
      ]
    ])
    const controller = createAppController(store, unavailableRepositories, agent, {
      ...backend({
        "/api/tools/browser-fetch": json(200, {
          status: 200,
          finalUrl: "https://example.com/",
          contentType: "text/html",
          text: "Example Domain",
          frameable: true,
          blockReason: null
        })
      })
    })
    controller.send("read https://example.com for me")
    await settled()
    await settled()
    await settled()

    const texts = [...store.collections.messages.values()].map((message) => message.text)
    expect(texts).toContain("Smithers read example.com")
    for (const text of texts) {
      expect(text).not.toContain("Example Domain —")
    }
  })
})

describe("wave 10 — sign-in IS the GitHub connector (§2a′)", () => {
  test("a signed-in session means connected: the snapshot and the agent context derive it", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent())
    expect(controller.commands.state().hasConnectors).toBe(false)
    await signIn(store)
    expect(controller.commands.state().hasConnectors).toBe(true)
  })

  test("the agent answering from the debug reads (admin) — snapshot/events contracts", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent())
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "will",
      allowlisted: true,
      admin: true,
      scopesPlain: null
    })
    await settled()
    const snapshot = await controller.commands.executeForAgent({
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "debug.snapshot" })
    })
    const parsed = JSON.parse(snapshot) as { surface: string; identity: { login: string } }
    expect(parsed.surface).toBe("chat")
    expect(parsed.identity.login).toBe("will")
    const events = await controller.commands.executeForAgent({
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "debug.events" })
    })
    expect(JSON.parse(events)).toBeInstanceOf(Array)
  })
})
