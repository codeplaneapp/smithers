import { Author, ScriptRunner } from "@smthrs/chain"
import type { Catalog } from "@smthrs/chain"
import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { AgentTurnFrame, StartAgentTurnRequest } from "smithers-shared/NativeAgent"
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge"
import { createAppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import type { AppStore } from "../state/AppStore"
import { createAgentSeat, createChainRuntime } from "./ChainRuntime"

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "Local repositories can only be connected from the Smithers native app."
  })
}

/*
 * The native shell's agent: a different HOST for the same loop, and the seat's
 * only fallback. It must never see a browser turn — that is what "one backend"
 * means, so every case below asserts it stayed empty.
 */
const recordingNative = (): { agent: NativeAgent; requests: Array<StartAgentTurnRequest> } => {
  const requests: Array<StartAgentTurnRequest> = []
  return {
    requests,
    agent: {
      available: true,
      startTurn: async (request) => {
        requests.push(request)
        return { status: "started" }
      },
      cancelTurn: async () => {},
      subscribe: () => () => {}
    }
  }
}

const flow = (...lines: ReadonlyArray<string>): string => ["```flow", ...lines, "```"].join("\n")

const scripts = [
  flow(
    `await ctx.call("say", { text: "Working on it." })`,
    `const s = await ctx.call("author", { context: ["carry the plan"] })`,
    `return to(s)`
  ),
  flow(
    `await ctx.call("world.new-note", {})`,
    `await ctx.call("say", { text: "Done — noted." })`,
    `return done({ ok: true })`
  )
]

interface Harness {
  readonly store: AppStore
  readonly controller: ReturnType<typeof createAppController>
  readonly frames: Array<AgentTurnFrame>
  readonly nativeRequests: Array<StartAgentTurnRequest>
  readonly waitForDone: () => Promise<AgentTurnFrame & { readonly type: "done" }>
}

const harness = async (options: {
  readonly storage?: StorageApi
  readonly author: Layer.Layer<Author.Author>
  readonly entries?: ReadonlyArray<Catalog.Entry>
}): Promise<Harness> => {
  const store = await createAppStore({
    kind: "localStorage",
    storage: options.storage ?? memoryStorage()
  })
  const native = recordingNative()
  const agent = createAgentSeat(native.agent)
  const controller = createAppController(store, unavailableRepositories, agent)
  agent.bindChain(
    createChainRuntime({
      store,
      commands: controller.commands,
      entries: options.entries,
      authorLayer: options.author,
      runnerLayer: ScriptRunner.layerInProcess
    })
  )
  const frames: Array<AgentTurnFrame> = []
  const doneWaiters: Array<(frame: AgentTurnFrame & { readonly type: "done" }) => void> = []
  agent.subscribe((frame) => {
    frames.push(frame)
    if (frame.type === "done") { for (const resolve of doneWaiters.splice(0)) resolve(frame) }
  })
  const waitForDone = () =>
    new Promise<AgentTurnFrame & { readonly type: "done" }>((resolve, reject) => {
      doneWaiters.push(resolve)
      setTimeout(() => reject(new Error("no done frame within 5s")), 5000)
    })
  return { store, controller, frames, nativeRequests: native.requests, waitForDone }
}

describe("ChainRuntime behind the NativeAgent seam", () => {
  test("a chain turn drives the real app end-to-end through send()", async () => {
    const h = await harness({ author: Author.layerMock(scripts) })
    const worldBefore = h.store.collections.worldDocuments.size

    const done = h.waitForDone()
    h.controller.send("make a note about the plan")
    const terminal = await done
    expect(terminal.reason).toBe("stop")
    expect("error" in terminal ? terminal.error : undefined).toBeUndefined()

    // The native agent never saw the turn; the chain did the work.
    expect(h.nativeRequests).toHaveLength(0)
    // The say door rendered into the real transcript. (Collection order is
    // keyed, not insertion — the prose message is the one without an act.)
    const smithers = [...h.store.collections.messages.values()].find(
      (message) => message.role === "smithers" && message.act === undefined
    )
    expect(smithers?.text).toContain("Working on it.")
    expect(smithers?.text).toContain("Done — noted.")
    // The command executed as a real actor-attributed effect.
    expect(h.store.collections.worldDocuments.size).toBe(worldBefore + 1)
    // The journal is populated and the frame fold streamed it live.
    expect(h.store.collections.chainEvents.size).toBeGreaterThan(0)
    expect(h.frames.some((frame) => frame.type === "link.authored")).toBe(true)
    expect(
      h.frames.some((frame) => frame.type === "call.settled" && frame.name === "world.new-note")
    ).toBe(true)
    // Three links end: the bootstrap's harness-authored link 0 (to), the
    // authored link 1 (to), and link 2 (done) — the Chain Slice's golden shape.
    expect(h.frames.filter((frame) => frame.type === "link.ended")).toHaveLength(3)
    // The act row renders exactly as the tool loop's did; the chain's own
    // doors (say, author) render no act of their own.
    const acts = [...h.store.collections.messages.values()]
      .filter((message) => message.act !== undefined)
      .map((message) => message.text)
    expect(acts).toContain("Smithers ran /world.new-note")
    expect(acts.some((act) => act.includes("/say") || act.includes("/author"))).toBe(false)
    // The turn settled the session.
    expect(h.store.session().phase).toBe("idle")
  })

  test("a gate rejection renders as an in-character course correction, never an error bubble", async () => {
    const h = await harness({
      author: Author.layerMock([
        flow(`await ctx.call("workflow.frobnicate", {})`, `return done({})`),
        flow(`await ctx.call("say", { text: "Recovered." })`, `return done({ ok: true })`)
      ])
    })
    const done = h.waitForDone()
    h.controller.send("try the thing")
    const terminal = await done
    expect("error" in terminal ? terminal.error : undefined).toBeUndefined()
    const acts = [...h.store.collections.messages.values()]
      .filter((message) => message.act !== undefined)
      .map((message) => message.text)
    expect(acts).toContain("Smithers adjusted its approach")
    const smithers = [...h.store.collections.messages.values()].find(
      (message) => message.role === "smithers" && message.act === undefined
    )
    expect(smithers?.text).toContain("Recovered.")
  })

  test("every turn is a chain turn — nothing routes to the native agent", async () => {
    const h = await harness({ author: Author.layerMock(scripts) })
    h.controller.send("hello there")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.nativeRequests).toHaveLength(0)
    expect(h.store.collections.chainEvents.size).toBeGreaterThan(0)
  })

  test("/debug.backend reports the one backend and refuses to pretend it can switch", async () => {
    const h = await harness({ author: Author.layerMock(scripts) })
    expect(h.controller.describeAgentBackend("")).toEqual({
      value: "agent backend: chain (in-browser Agent Chain over /api/model/stream)"
    })
    expect(h.controller.describeAgentBackend("proxy")).toContain("cannot be switched")
  })

  test("stop() interrupts a hung chain turn into an honest cancelled state", async () => {
    const hanging = Layer.succeed(Author.Author)(
      Author.make({ author: () => Effect.never })
    )
    const h = await harness({ author: hanging })
    const done = h.waitForDone()
    h.controller.send("do something slow")
    // A tick, not a clock: startTurn's synchronous prefix registers the fiber
    // within a microtask, so one macrotask is enough for stop() to find it.
    await new Promise((resolve) => setTimeout(resolve, 0))
    h.controller.stop()
    const terminal = await done
    expect(terminal.reason).toBe("cancelled")
    expect(h.store.session().phase).toBe("idle")
  })

  test("mid-turn input steers the chain and lands in the next author call's context", async () => {
    let releaseWait!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseWait = resolve
    })
    let waitEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      waitEntered = resolve
    })
    const waitEntry: Catalog.Entry = {
      name: "test.wait",
      description: "test gate",
      handler: () =>
        Effect.promise(async () => {
          waitEntered()
          await gate
          return { released: true }
        })
    }
    const contexts: Array<ReadonlyArray<string>> = []
    let authored = 0
    const author = Layer.succeed(Author.Author)(
      Author.make({
        author: (input) =>
          Effect.sync(() => {
            contexts.push(input.context)
            authored += 1
            return authored === 1
              ? flow(
                `await ctx.call("test.wait", {})`,
                `await ctx.call("say", { text: "Started." })`,
                `const s = await ctx.call("author", { context: ["carry"] })`,
                `return to(s)`
              )
              : flow(`await ctx.call("say", { text: "Wrapped with your note." })`, `return done({})`)
          })
      })
    )
    const h = await harness({ author, entries: [waitEntry] })
    const done = h.waitForDone()
    h.controller.send("start the work")
    await entered

    // The composer mid-turn: rendered as the user's bubble, admitted as steering.
    // The admit lands in the steering Ref within a microtask, so one tick —
    // not a wall-clock wait — orders it before the gate releases.
    h.controller.send("also check the tests")
    await new Promise((resolve) => setTimeout(resolve, 0))
    releaseWait()
    const terminal = await done
    expect("error" in terminal ? terminal.error : undefined).toBeUndefined()

    // The steered words reached the NEXT author call's context.
    expect(contexts.length).toBe(2)
    expect(JSON.stringify(contexts[1])).toContain("also check the tests")
    // The drain journaled and framed; the transcript shows bubble + marker.
    expect(h.frames.some((frame) => frame.type === "steering.drained")).toBe(true)
    const messages = [...h.store.collections.messages.values()]
    expect(
      messages.some((message) => message.role === "user" && message.text === "also check the tests")
    ).toBe(true)
    expect(messages.some((message) => message.act === "Smithers picked up your note")).toBe(true)
  })

  test("the agent can never approve for itself — approve:* is structurally denied", async () => {
    const h = await harness({
      author: Author.layerMock([
        flow(`await ctx.call("approval.approve", {})`, `return done({})`),
        flow(`await ctx.call("say", { text: "Understood — that's yours to decide." })`, `return done({})`)
      ])
    })
    const done = h.waitForDone()
    h.controller.send("approve that for me")
    await done
    const denied = h.frames.find(
      (frame) => frame.type === "gate.rejected" && frame.kind === "denied"
    )
    expect(denied).toBeDefined()
    expect(denied !== undefined && "message" in denied ? denied.message : "").toContain(
      "approvals belong to the human"
    )
  })

  test("an outbound call parks for approval; approving resumes the lineage and runs it once", async () => {
    const deploys = { count: 0 }
    const deploy: Catalog.Entry = {
      name: "deploy.thing",
      description: "test outbound",
      capabilities: ["outbound:launch"],
      handler: () =>
        Effect.sync(() => {
          deploys.count += 1
          return { deployed: true }
        })
    }
    const h = await harness({
      author: Author.layerMock([
        flow(`await ctx.call("deploy.thing", {})`, `await ctx.call("say", { text: "Shipped." })`, `return done({})`)
      ]),
      entries: [deploy]
    })
    const parked = h.waitForDone()
    h.controller.send("ship it")
    await parked

    // The park: nothing ran, the turn settled, the approval card is live.
    expect(deploys.count).toBe(0)
    expect(h.frames.some((frame) => frame.type === "park" && frame.code === "approval")).toBe(true)
    expect(h.store.session().phase).toBe("idle")
    const card = [...h.store.collections.cards.values()].find(
      (candidate) => candidate.kind === "approval" && candidate.payload.chain === true
    )
    expect(card).toBeDefined()
    expect(card?.kind === "approval" ? card.payload.capability : "").toBe("outbound:launch")

    // Approve → the same lineage resumes from its settled prefix and converges.
    const resumed = h.waitForDone()
    h.controller.decideApproval(card!.id, "approved")
    const terminal = await resumed
    expect("error" in terminal ? terminal.error : undefined).toBeUndefined()
    expect(deploys.count).toBe(1)
    const decided = h.store.collections.cards.get(card!.id)
    expect(decided?.kind === "approval" ? decided.payload.decision : undefined).toBe("approved")
    const smithers = [...h.store.collections.messages.values()].find(
      (message) => message.role === "smithers" && message.act === undefined
    )
    expect(smithers?.text).toContain("Shipped.")
  })

  test("denying an outbound call resumes into a denial the model routes around", async () => {
    const deploys = { count: 0 }
    const deploy: Catalog.Entry = {
      name: "deploy.thing",
      description: "test outbound",
      capabilities: ["outbound:launch"],
      handler: () =>
        Effect.sync(() => {
          deploys.count += 1
          return { deployed: true }
        })
    }
    /*
     * layerMock's queue re-seeds per Chain.run provision, so a resumed
     * lineage's recovery author would re-pop the first script. A closure
     * over layerFn survives the rebuild — first authoring ships, every
     * later one is the model routing around the recorded denial.
     */
    let authored = 0
    const h = await harness({
      author: Author.layerFn(() => {
        authored += 1
        return authored === 1
          ? flow(`await ctx.call("deploy.thing", {})`, `return done({})`)
          : flow(`await ctx.call("say", { text: "Okay — not shipping." })`, `return done({})`)
      }),
      entries: [deploy]
    })
    const parked = h.waitForDone()
    h.controller.send("ship it")
    await parked
    const card = [...h.store.collections.cards.values()].find(
      (candidate) => candidate.kind === "approval" && candidate.payload.chain === true
    )
    const resumed = h.waitForDone()
    h.controller.decideApproval(card!.id, "denied")
    await resumed
    expect(deploys.count).toBe(0)
    expect(h.frames.some((frame) => frame.type === "gate.rejected" && frame.kind === "denied")).toBe(true)
    const smithers = [...h.store.collections.messages.values()].find(
      (message) => message.role === "smithers" && message.act === undefined
    )
    expect(smithers?.text).toContain("not shipping")
  })

  test("a session-tier grant is remembered across turns within the session", async () => {
    const peeks = { count: 0 }
    const peek: Catalog.Entry = {
      name: "peek.web",
      description: "test session-tier read",
      capabilities: ["session:net-read"],
      handler: () =>
        Effect.sync(() => {
          peeks.count += 1
          return { ok: true }
        })
    }
    const script = flow(
      `await ctx.call("peek.web", {})`,
      `await ctx.call("say", { text: "Looked." })`,
      `return done({})`
    )
    const h = await harness({ author: Author.layerMock([script, script]), entries: [peek] })

    const parked = h.waitForDone()
    h.controller.send("look at the web")
    await parked
    expect(peeks.count).toBe(0)
    const card = [...h.store.collections.cards.values()].find(
      (candidate) => candidate.kind === "approval" && candidate.payload.chain === true
    )
    const resumed = h.waitForDone()
    h.controller.decideApproval(card!.id, "approved")
    await resumed
    expect(peeks.count).toBe(1)

    // A NEW turn: the session grant holds, no second ask.
    const cardsBefore = h.store.collections.cards.size
    const second = h.waitForDone()
    h.controller.send("look again")
    await second
    expect(peeks.count).toBe(2)
    expect(h.store.collections.cards.size).toBe(cardsBefore)
  })

  test("an inline sub-agent is an ordinary catalog call whose child works in the same journal", async () => {
    let authored = 0
    const author = Author.layerFn(() => {
      authored += 1
      return authored === 1
        ? flow(
          `const child = await ctx.call("agent", { goal: "note the plan" })`,
          `await ctx.call("say", { text: "child finished: " + child._tag })`,
          `return done({})`
        )
        : flow(`await ctx.call("world.new-note", {})`, `return done({ noted: true })`)
    })
    const h = await harness({ author })
    const worldBefore = h.store.collections.worldDocuments.size
    const done = h.waitForDone()
    h.controller.send("delegate the note")
    const terminal = await done
    expect("error" in terminal ? terminal.error : undefined).toBeUndefined()
    // The child ran a real command in the same journal, chain-scoped.
    expect(h.store.collections.worldDocuments.size).toBe(worldBefore + 1)
    const scoped = [...h.store.collections.chainEvents.values()].filter(
      (record) => (record.event as { readonly chain?: string }).chain !== undefined
    )
    expect(scoped.length).toBeGreaterThan(0)
    const smithers = [...h.store.collections.messages.values()].find(
      (message) => message.role === "smithers" && message.act === undefined
    )
    expect(smithers?.text).toContain("child finished: Done")
  })

  test("a background sub-agent works after the turn and its result arrives as a note", async () => {
    /*
     * The gate makes "after the turn" a fact instead of a race. A background
     * lineage starts while its parent turn is still running, so whether its
     * note steers the live turn or waits in pendingNotes would otherwise be
     * decided by how many ticks the runner happens to spend on the parent.
     * Holding the background at this entry until the parent's done frame
     * lands pins the case this test is about: the note arrives with no turn
     * to steer, so the NEXT turn's context carries it.
     */
    let releaseBackground!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseBackground = resolve
    })
    const waitEntry: Catalog.Entry = {
      name: "test.wait",
      description: "test gate",
      handler: () =>
        Effect.promise(async () => {
          await gate
          return { released: true }
        })
    }
    const contexts: Array<ReadonlyArray<string>> = []
    let authored = 0
    const author = Author.layerFn((input) => {
      contexts.push(input.context)
      authored += 1
      if (authored === 1) {
        return flow(
          `const bg = await ctx.call("background", { goal: "count the stars" })`,
          `await ctx.call("say", { text: "On it — working in the background." })`,
          `return done({})`
        )
      }
      if (authored === 2) {
        return flow(
          `await ctx.call("test.wait", {})`,
          `await ctx.call("world.new-note", {})`,
          `return done({ counted: 42 })`
        )
      }
      return flow(`await ctx.call("say", { text: "Caught up." })`, `return done({})`)
    })
    const h = await harness({ author, entries: [waitEntry] })
    const worldBefore = h.store.collections.worldDocuments.size
    const done = h.waitForDone()
    h.controller.send("count the stars in the background")
    const terminal = await done
    expect("error" in terminal ? terminal.error : undefined).toBeUndefined()
    releaseBackground()

    // The background lineage completes after the turn: real effect, honest note.
    const finished = async (): Promise<boolean> =>
      [...h.store.collections.messages.values()].some((message) =>
        message.text.includes("A background task finished: count the stars")
      )
    for (let waited = 0; !(await finished()) && waited < 100; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(await finished()).toBe(true)
    expect(h.store.collections.worldDocuments.size).toBe(worldBefore + 1)
    // Its journal is its own lineage in the same collection.
    expect(
      [...h.store.collections.chainEvents.values()].some((record) => record.lineageId.startsWith("bg-"))
    ).toBe(true)

    // The NEXT turn's harness-built context carries the note.
    const second = h.waitForDone()
    h.controller.send("anything new?")
    await second
    expect(JSON.stringify(contexts.at(-1))).toContain("[background]")
    expect(JSON.stringify(contexts.at(-1))).toContain("count the stars")
  })

  test("a background parked without an approval frees its slot instead of parking capacity forever", async () => {
    // Non-approval parks have no wake-up (only approval parks resume through
    // resolveApproval), so the lineage must leave backgroundGoals — otherwise
    // three dormant parks exhaust MAX_BACKGROUNDS and every later spawn is
    // refused. The fourth parker is the tell: it only parks when the first
    // three slots were released.
    const author = Author.layerFn((input) =>
      input.context.includes("role:park")
        ? flow(`return park("quota", "out of budget")`)
        : flow(
          `const bg = await ctx.call("background", { goal: "park work", context: ["role:park"] })`,
          `await ctx.call("say", { text: "spawned" })`,
          `return done({})`
        )
    )
    const h = await harness({ author })
    const pausedCount = (): number =>
      [...h.store.collections.messages.values()].filter((message) =>
        message.text.includes("A background task paused (quota)")
      ).length
    const untilPaused = async (count: number): Promise<void> => {
      for (let waited = 0; pausedCount() < count && waited < 200; waited += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }

    for (let round = 1; round <= 4; round += 1) {
      const done = h.waitForDone()
      h.controller.send(`spawn parker ${round}`)
      const terminal = await done
      expect("error" in terminal ? terminal.error : undefined).toBeUndefined()
      await untilPaused(round)
    }
    expect(pausedCount()).toBe(4)
  })

  test("scripts read and write the worldview through recall and remember", async () => {
    const h = await harness({
      author: Author.layerMock([
        flow(
          `const found = await ctx.call("recall", { query: "world" })`,
          `await ctx.call("remember", { title: "Learned", text: "The user likes Tuesdays." })`,
          `await ctx.call("say", { text: "Recalled " + found.results.length + " notes." })`,
          `return done({})`
        )
      ])
    })
    const done = h.waitForDone()
    h.controller.send("remember what I like")
    const terminal = await done
    expect("error" in terminal ? terminal.error : undefined).toBeUndefined()
    const learned = [...h.store.collections.worldDocuments.values()].find(
      (document) => document.title === "Learned"
    )
    expect(learned?.sources).toContain("chain-remember")
    const smithers = [...h.store.collections.messages.values()].find(
      (message) => message.role === "smithers" && message.act === undefined
    )
    expect(smithers?.text).toMatch(/Recalled [1-9]\d* notes\./)
  })

  test("a reload replays the finished lineage with zero authored calls and zero effects", async () => {
    const storage = memoryStorage()
    const first = await harness({ storage, author: Author.layerMock(scripts) })
    const done = first.waitForDone()
    first.controller.send("make a note about the plan")
    await done
    const lineage = first.frames.find((frame) => frame.type === "link.authored")?.runId
    expect(lineage).toBeDefined()
    const worldAfterFirst = first.store.collections.worldDocuments.size

    // The reload: same storage, an author that fails if ever consulted.
    const second = await harness({ storage, author: Author.layerMock([]) })
    const agentDone = second.waitForDone()
    const runtime = createChainRuntime({
      store: second.store,
      commands: second.controller.commands,
      authorLayer: Author.layerMock([]),
      runnerLayer: ScriptRunner.layerInProcess
    })
    runtime.subscribe((frame) => {
      if (frame.type === "done") second.frames.push(frame)
    })
    const terminalDone = new Promise<void>((resolve) => {
      runtime.subscribe((frame) => {
        if (frame.type === "done") resolve()
      })
    })
    const result = await runtime.startTurn({
      runId: lineage!,
      messages: [{ role: "user", content: "make a note about the plan" }],
      instructions: ""
    })
    expect(result.status).toBe("started")
    await terminalDone
    const terminal = second.frames.find((frame) => frame.type === "done")
    expect(terminal).toBeDefined()
    expect(terminal !== undefined && "error" in terminal ? terminal.error : undefined).toBeUndefined()
    // Zero re-executed effects: the world did not grow again.
    expect(second.store.collections.worldDocuments.size).toBe(worldAfterFirst)
    void agentDone.catch(() => {})
  })
})
