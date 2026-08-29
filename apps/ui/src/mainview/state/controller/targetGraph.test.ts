/*
 * The chat half of the target-graph cards (docs/LOCAL-APP.md "Cards: target
 * graph"): every command the human types — /target.graph, /target.timeline,
 * /target.history, /target.affected, /target.ci and the hidden replay acts —
 * runs through the ONE registry path and lands the right card kind, filled
 * from the routes in smithers-shared/TargetGraph TARGET_GRAPH_ROUTES. The
 * routes are stubbed here at the fetch seam with the captured force
 * fixtures; the backend lane implements them against the same contract.
 */
import type { StorageApi } from "@tanstack/db"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Repo } from "smithers-shared/LocalApp"
import type { RunReplayResponse } from "smithers-shared/TargetGraph"
import { TARGET_GRAPH_ROUTES } from "smithers-shared/TargetGraph"
import { fixtureRunEvents, fixtureTargetGraph } from "../../dev/fixtureRunStream"
import type { NativeAgent, NativeRepositories } from "../../native/NativeBridge"
import { createAppController } from "../AppController"
import { createAppStore } from "../AppStore"
import type { Card } from "../AppState"
import { replayAtCursor } from "./targetGraph"

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

const REPO: Repo = {
  id: "force",
  path: "/tmp/force",
  name: "force",
  git: { branch: "main", remote: null },
  warnings: [],
  smithers: {
    detected: true,
    workspaceFile: null,
    declarationFiles: ["PACKAGE.ts"],
    reason: "declared",
    workspaces: [{ path: ".", title: "force" }]
  }
}

const GRAPH = fixtureTargetGraph("force")
const RUN_ID = "run-force-1"
const RUN_BASE = 1_700_000_000_000
const EVENTS = fixtureRunEvents(GRAPH, { runId: RUN_ID, root: "//:prePush", base: RUN_BASE })
const RUN_END = Math.max(...EVENTS.map((event) => ("at" in event ? event.at : 0)))
const SUMMARY = EVENTS.find((event) => event.type === "summary")
const REPLAY: RunReplayResponse = {
  run: {
    runId: RUN_ID,
    repoId: "force",
    label: "//:prePush",
    labels: ["//:prePush"],
    status: "failed",
    startedAt: RUN_BASE,
    endedAt: RUN_END,
    ...(SUMMARY?.type === "summary" ? { summary: SUMMARY.summary } : {})
  },
  events: [...EVENTS]
}

const AFFECTED = {
  repoId: "force",
  base: "HEAD",
  changedFiles: ["src/App.tsx"],
  affected: [{ label: "//src:typeCheck", reason: "src/App.tsx" }],
  durationMs: 42
}

const CI = {
  repoId: "force",
  workflows: [
    {
      name: "ci",
      path: ".github/workflows/ci.yml",
      yaml: "name: ci\n",
      jobs: [{ name: "check", targets: ["//src:typeCheck"], matrix: { shard: ["1/2", "2/2"] } }]
    }
  ],
  durationMs: 17
}

/* Every route answers its fixture; anything else is an honest 404. */
const stubRoutes = (): (() => void) => {
  const real = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const answer = url.endsWith(TARGET_GRAPH_ROUTES.graph)
      ? GRAPH
      : url.endsWith(TARGET_GRAPH_ROUTES.runs)
      ? { repoId: "force", runs: [REPLAY.run] }
      : url.endsWith(TARGET_GRAPH_ROUTES.replay)
      ? REPLAY
      : url.endsWith(TARGET_GRAPH_ROUTES.affected)
      ? AFFECTED
      : url.endsWith(TARGET_GRAPH_ROUTES.ci)
      ? CI
      : undefined
    if (answer === undefined) return new Response("not found", { status: 404 })
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch
  return () => {
    globalThis.fetch = real
  }
}

const freshController = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableRepositories, unavailableAgent)
  /* The commands resolve the one open repository, so open one. */
  store.dispatch({
    type: "card.upsert",
    actor: "user",
    card: {
      id: "repo-force",
      kind: "repo",
      title: "force",
      status: "acted",
      createdAt: 0,
      ordinal: 0,
      payload: { repo: REPO }
    }
  })
  return { store, controller }
}

const cardOf = (store: Awaited<ReturnType<typeof freshController>>["store"], id: string): Card | undefined =>
  store.collections.cards.get(id)

describe("the chat commands dispatch the target-graph cards", () => {
  let restore = () => {}
  beforeEach(() => {
    restore = stubRoutes()
  })
  afterEach(() => {
    restore()
  })

  test("/target.graph lands a graph card filled from the graph route", async () => {
    const { store, controller } = await freshController()
    expect((await controller.commands.run("target.graph")).status).toBe("executed")
    const card = cardOf(store, "graph-force")
    expect(card?.kind).toBe("graph")
    if (card?.kind !== "graph") throw new Error("expected a graph card")
    expect(card.payload.status).toBe("done")
    expect(card.payload.graph?.nodes.length).toBe(82)
    expect(card.payload.graph?.edges.length).toBe(94)
    expect(card.payload.focus).toBeUndefined()
  })

  test("/target.graph //src:typeCheck focuses the card on that label", async () => {
    const { store, controller } = await freshController()
    expect((await controller.commands.run("target.graph", "//src:typeCheck")).status).toBe("executed")
    const card = cardOf(store, "graph-force")
    if (card?.kind !== "graph") throw new Error("expected a graph card")
    expect(card.payload.focus).toBe("//src:typeCheck")
    /* And the drawer's dismissal clears it, so the drawer can actually close. */
    expect((await controller.commands.run("target.graph.focus", "force")).status).toBe("executed")
    const cleared = cardOf(store, "graph-force")
    if (cleared?.kind !== "graph") throw new Error("expected a graph card")
    expect(cleared.payload.focus).toBeUndefined()
  })

  test("/target.history lands the run table; selecting a row replays it into a timeline", async () => {
    const { store, controller } = await freshController()
    expect((await controller.commands.run("target.history")).status).toBe("executed")
    const history = cardOf(store, "run-history-force")
    if (history?.kind !== "run-history") throw new Error("expected a run-history card")
    expect(history.payload.status).toBe("done")
    expect(history.payload.runs.map((run) => run.runId)).toEqual([RUN_ID])

    expect((await controller.commands.run("target.runs.select", `force ${RUN_ID}`)).status).toBe("executed")
    const selected = cardOf(store, "run-history-force")
    if (selected?.kind !== "run-history") throw new Error("expected a run-history card")
    expect(selected.payload.selected).toBe(RUN_ID)

    const timeline = cardOf(store, `run-timeline-${RUN_ID}`)
    if (timeline?.kind !== "run-timeline") throw new Error("expected a run-timeline card")
    expect(timeline.payload.cursor).toBe(RUN_END)
    expect(timeline.payload.summary?.total).toBe(timeline.payload.nodes.length)
    /* No graph card was opened in this test, so replay has none to paint — and invents none. */
    expect(cardOf(store, "graph-force")).toBeUndefined()
  })

  test("the scrubber replays deterministically into the timeline and the graph overlay", async () => {
    const { store, controller } = await freshController()
    expect((await controller.commands.run("target.graph")).status).toBe("executed")
    expect((await controller.commands.run("target.history")).status).toBe("executed")
    expect((await controller.commands.run("target.runs.select", `force ${RUN_ID}`)).status).toBe("executed")

    const midpoint = RUN_BASE + Math.round((RUN_END - RUN_BASE) / 2)
    expect((await controller.commands.run("target.run.scrub", `${RUN_ID} ${midpoint}`)).status).toBe("executed")
    const timeline = cardOf(store, `run-timeline-${RUN_ID}`)
    if (timeline?.kind !== "run-timeline") throw new Error("expected a run-timeline card")
    expect(timeline.payload.cursor).toBe(midpoint)
    /* The same fold the pure replay produces — no state the events did not carry. */
    const expected = replayAtCursor(EVENTS, midpoint)
    expect(timeline.payload.nodes.length).toBe(expected.nodes.length)
    expect(timeline.payload.nodes.length).toBeLessThan(EVENTS.filter((e) => e.type === "node").length)
    expect(timeline.payload.summary).toBeUndefined()
    /*
     * Time travel gates the LOGS too. stdout frames carry no `at` of their own,
     * so a fold that only checks the timed frames would hand a half-replayed
     * run every log line the whole run ever printed.
     */
    expect(Object.keys(timeline.payload.logs ?? {}).length).toBe(Object.keys(expected.logs).length)
    expect(Object.keys(timeline.payload.logs ?? {}).length).toBeLessThan(
      Object.keys(replayAtCursor(EVENTS, RUN_END).logs).length
    )

    const graph = cardOf(store, "graph-force")
    if (graph?.kind !== "graph") throw new Error("expected a graph card")
    expect(graph.payload.runId).toBe(RUN_ID)
    expect(graph.payload.run?.nodes.length).toBe(expected.nodes.length)

    /* Scrubbing back to the end restores the whole run — replay is a pure fold. */
    expect((await controller.commands.run("target.run.scrub", `${RUN_ID} ${RUN_END}`)).status).toBe("executed")
    const restored = cardOf(store, `run-timeline-${RUN_ID}`)
    if (restored?.kind !== "run-timeline") throw new Error("expected a run-timeline card")
    expect(restored.payload.summary?.total).toBe(restored.payload.nodes.length)
  })

  test("/target.affected and /target.ci land their cards from their routes", async () => {
    const { store, controller } = await freshController()
    expect((await controller.commands.run("target.affected")).status).toBe("executed")
    const affected = cardOf(store, "affected-force")
    if (affected?.kind !== "affected") throw new Error("expected an affected card")
    expect(affected.payload.status).toBe("done")
    expect(affected.payload.result?.affected[0]?.label).toBe("//src:typeCheck")

    expect((await controller.commands.run("target.ci")).status).toBe("executed")
    const ci = cardOf(store, "ci-force")
    if (ci?.kind !== "ci-matrix") throw new Error("expected a ci-matrix card")
    expect(ci.payload.status).toBe("done")
    expect(ci.payload.result?.workflows[0]?.jobs[0]?.name).toBe("check")
  })

  /*
   * No fake data in the product path (UI-COMMON "Rules"): a route that does
   * not answer leaves the card failed with the error, never a green state.
   */
  test("a route that refuses leaves the card failed, not green", async () => {
    restore()
    const real = globalThis.fetch
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch
    try {
      const { store, controller } = await freshController()
      await controller.commands.run("target.graph")
      const card = cardOf(store, "graph-force")
      if (card?.kind !== "graph") throw new Error("expected a graph card")
      expect(card.payload.status).toBe("failed")
      expect(card.status).toBe("error")
      expect(card.payload.graph).toBeUndefined()
      await controller.commands.run("target.history")
      const history = cardOf(store, "run-history-force")
      if (history?.kind !== "run-history") throw new Error("expected a run-history card")
      expect(history.payload.status).toBe("failed")
      expect(history.status).toBe("error")
      expect(history.payload.error).toContain("boom")
    } finally {
      globalThis.fetch = real
    }
  })
})

/*
 * The replay fold is the whole of time travel: the cards, the overlay and the
 * scrubber all read it, so it is worth pinning on its own.
 */
describe("the replay fold gates every frame on the cursor", () => {
  test("untimed stdout frames inherit the clock of the last timed frame", () => {
    const first = EVENTS.find((event) => event.type === "node")
    if (first?.type !== "node") throw new Error("expected a node frame")
    const early = replayAtCursor(EVENTS, first.at)
    const whole = replayAtCursor(EVENTS, RUN_END)
    /* One node has been announced; nothing has printed yet. */
    expect(early.nodes.length).toBe(1)
    expect(Object.keys(early.logs)).toEqual([])
    expect(Object.keys(whole.logs).length).toBeGreaterThan(1)
    expect(whole.nodes.length).toBeGreaterThan(1)
  })

  test("a log line appears exactly at the cursor that reaches it, and not before", () => {
    const printed = EVENTS.findIndex((event) => event.type === "stdout")
    expect(printed).toBeGreaterThan(0)
    const label = EVENTS[printed]?.type === "stdout" ? (EVENTS[printed] as { label?: string }).label : undefined
    expect(label).toBeDefined()
    /* The stdout frame follows its node's settled frame, so that frame's `at` is its clock. */
    const timed = EVENTS.slice(0, printed).reverse().find((event) => "at" in event)
    if (timed === undefined || !("at" in timed)) throw new Error("expected a timed frame before the first stdout")
    expect(replayAtCursor(EVENTS, timed.at - 1).logs[label!]).toBeUndefined()
    expect(replayAtCursor(EVENTS, timed.at).logs[label!]).toContain(label!)
  })

  test("the fold is monotone: a later cursor never drops what an earlier one had", () => {
    const cursors = [RUN_BASE, RUN_BASE + (RUN_END - RUN_BASE) / 3, RUN_BASE + (RUN_END - RUN_BASE) / 2, RUN_END]
    let previousNodes = -1
    let previousLogs = -1
    for (const cursor of cursors) {
      const state = replayAtCursor(EVENTS, cursor)
      expect(state.nodes.length).toBeGreaterThanOrEqual(previousNodes)
      expect(Object.keys(state.logs).length).toBeGreaterThanOrEqual(previousLogs)
      previousNodes = state.nodes.length
      previousLogs = Object.keys(state.logs).length
    }
    expect(replayAtCursor(EVENTS, RUN_END).summary).toBeDefined()
    expect(replayAtCursor(EVENTS, RUN_BASE).summary).toBeUndefined()
  })
})
