import type { StorageApi } from "@tanstack/db"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { NativeAgent, NativeRepositories } from "../../native/NativeBridge"
import { createAppController } from "../AppController"
import type { AppServices } from "../AppController"
import type { Card } from "../AppState"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { REPO_IMPORT_LOST_STREAM_DETAIL, repoImportPolling } from "./RepoImportSeam"

/*
 * The repo-import seam: /repos.import starts POST /api/github/import, tracks
 * the job on ONE upserted "repo-import" card (stable id, stable ordinal), and
 * polls GET /api/github/import/{jobId} to a terminal phase. Failures answer
 * honest strings — the seam never throws.
 */

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

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Spin until the predicate holds — the poll loop runs on real (1ms) timers. */
const until = async (predicate: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Routes the two import endpoints; everything else answers 404. */
const importBackend = (
  start: () => Response | Promise<Response>,
  poll?: () => Response | Promise<Response>
): AppServices => ({
  fetchImpl: async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const path = new URL(url, "https://app.test").pathname
    const method = init?.method ?? "GET"
    if (path === "/api/github/import" && method === "POST") return start()
    if (path.startsWith("/api/github/import/") && method === "GET") {
      if (poll === undefined) return json(404, { message: `no poll stub for ${path}` })
      return poll()
    }
    return json(404, { status: "error", message: `no stub for ${path}` })
  }
})

/** Answers each poll in order, repeating the last answer once exhausted. */
const pollSequence = (answers: ReadonlyArray<() => Response>) => {
  let index = 0
  return () => {
    const answer = answers[Math.min(index, answers.length - 1)] as () => Response
    index += 1
    return answer()
  }
}

/** The reference wire shape (multi githubImport.ts parseImportJob). */
const jobBody = (
  status: "cloning" | "ready" | "failed",
  stage: string | null = null,
  error: string | null = null
) => ({
  importJobId: "job-1",
  repoOwner: "will",
  repoName: "flows",
  status,
  ...(stage === null ? {} : { stage }),
  ...(error === null ? {} : { error }),
  target_bookmark: "main",
  created_at: "2026-08-12T09:00:00.000Z",
  updated_at: "2026-08-12T09:00:00.000Z"
})

const freshController = async (services: AppServices) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  return {
    store,
    controller: createAppController(store, unavailableRepositories, unavailableAgent, services)
  }
}

const signedIn = async (store: AppStore): Promise<void> => {
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

const reposChosen = async (store: AppStore): Promise<void> => {
  store.dispatch({
    type: "watched.replaced",
    actor: "system",
    selected: ["will/flows"],
    selectedAt: "2026-08-12T09:00:00.000Z",
    via: "command"
  })
  await settled()
}

const readyStore = async (services: AppServices) => {
  const built = await freshController(services)
  await signedIn(built.store)
  await reposChosen(built.store)
  return built
}

const CARD_ID = "repo-import-will/flows"

const importCard = (store: AppStore) =>
  store.collections.cards.get(CARD_ID) as Extract<Card, { kind: "repo-import" }> | undefined

/** Every journaled card.upsert of the import card, in dispatch order. */
const importUpserts = (store: AppStore): ReadonlyArray<Extract<Card, { kind: "repo-import" }>> =>
  [...store.collections.transitions.values()]
    .filter((record) => record.type === "card.upsert")
    .sort((a, b) => a.revision - b.revision)
    .map((record) => (JSON.parse(record.payload) as { card: Card }).card)
    .filter((card): card is Extract<Card, { kind: "repo-import" }> => card.kind === "repo-import")

beforeAll(() => {
  // The loop is setTimeout-driven; a 1ms cadence keeps the suite honest AND fast.
  repoImportPolling.delayMs = 1
})

afterAll(() => {
  repoImportPolling.delayMs = 2_000
})

describe("repo import — the happy path", () => {
  test("starting → running → done on one card with one stable ordinal", async () => {
    const { store, controller } = await readyStore(
      importBackend(
        () => json(202, jobBody("cloning", "resolving")),
        pollSequence([
          () => json(200, jobBody("cloning", "pushing_mirror")),
          () => json(200, jobBody("ready", "provisioning_workspace"))
        ])
      )
    )
    const outcome = await controller.commands.run("repos.import", "will/flows")
    // Success = the job STARTED and the card tracks it — not finished yet.
    expect(outcome.status).toBe("executed")
    expect(importCard(store)?.payload.phase).toBe("running")
    expect(importCard(store)?.payload.jobId).toBe("job-1")

    await until(() => importCard(store)?.payload.phase === "done", "the done phase")
    const card = importCard(store)
    expect(card?.status).toBe("acted")
    expect(card?.title).toBe("Import · will/flows")

    const upserts = importUpserts(store)
    const phases = upserts.map((entry) => entry.payload.phase)
    expect(phases[0]).toBe("starting")
    expect(phases).toContain("running")
    expect(phases[phases.length - 1]).toBe("done")
    // The creation-time ordinal rides every upsert — the card never jumps.
    const ordinals = new Set(upserts.map((entry) => entry.ordinal))
    expect(ordinals.size).toBe(1)
    expect(card?.ordinal).toBe(upserts[0]?.ordinal as number)
    // Statuses track the phases: active while moving, acted at the end.
    expect(upserts.map((entry) => entry.status)).toEqual([
      ...upserts.slice(0, -1).map(() => "active" as const),
      "acted"
    ])
  })

  test("a poll's stage surfaces as the card's human detail", async () => {
    const { store, controller } = await readyStore(
      importBackend(
        () => json(202, jobBody("cloning", "resolving")),
        pollSequence([
          () => json(200, jobBody("cloning", "cloning_github")),
          () => json(200, jobBody("ready"))
        ])
      )
    )
    await controller.commands.run("repos.import", "will/flows")
    await until(() => importCard(store)?.payload.phase === "done", "the done phase")
    const details = importUpserts(store).map((entry) => entry.payload.detail)
    expect(details).toContain("Downloading from GitHub…")
  })
})

describe("repo import — already imported", () => {
  test("a 409 start answers done · already imported, not a failure", async () => {
    const { store, controller } = await readyStore(
      importBackend(() => json(409, { message: "repository 'flows' already exists" }))
    )
    const outcome = await controller.commands.run("repos.import", "will/flows")
    expect(outcome.status).toBe("executed")
    const card = importCard(store)
    expect(card?.payload.phase).toBe("done")
    expect(card?.payload.detail).toBe("already imported")
    expect(card?.status).toBe("acted")
  })

  test("a start answer already 'ready' is stated as already imported", async () => {
    const { store, controller } = await readyStore(
      importBackend(() => json(202, jobBody("ready")))
    )
    const outcome = await controller.commands.run("repos.import", "will/flows")
    expect(outcome.status).toBe("executed")
    expect(importCard(store)?.payload.phase).toBe("done")
    expect(importCard(store)?.payload.detail).toBe("already imported")
  })
})

describe("repo import — honest failures", () => {
  test("a 500 start fails the command with the body's message and errors the card", async () => {
    const { store, controller } = await readyStore(
      importBackend(() => json(500, { message: "the mirror pool is full" }))
    )
    const outcome = await controller.commands.run("repos.import", "will/flows")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("the mirror pool is full")
    const card = importCard(store)
    expect(card?.payload.phase).toBe("failed")
    expect(card?.status).toBe("error")
    expect(card?.payload.detail).toBe("the mirror pool is full")
  })

  test("a network throw on start answers an honest string, never a throw", async () => {
    const { store, controller } = await readyStore({
      fetchImpl: async () => {
        throw new Error("socket dropped")
      }
    })
    const outcome = await controller.commands.run("repos.import", "will/flows")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toContain("socket dropped")
    const card = importCard(store)
    expect(card?.payload.phase).toBe("failed")
    expect(card?.status).toBe("error")
  })

  test("a failed job lands the job's error on the card", async () => {
    const { store, controller } = await readyStore(
      importBackend(
        () => json(202, jobBody("cloning", "resolving")),
        pollSequence([() => json(200, jobBody("failed", "cloning_github", "clone timed out"))])
      )
    )
    const outcome = await controller.commands.run("repos.import", "will/flows")
    expect(outcome.status).toBe("executed")
    await until(() => importCard(store)?.payload.phase === "failed", "the failed phase")
    const card = importCard(store)
    expect(card?.status).toBe("error")
    expect(card?.payload.detail).toBe("clone timed out")
  })

  test("persistent poll failures give up honestly with the lost-stream detail", async () => {
    const { store, controller } = await readyStore(
      importBackend(
        () => json(202, jobBody("cloning", "resolving")),
        () => {
          throw new Error("poll dropped")
        }
      )
    )
    const outcome = await controller.commands.run("repos.import", "will/flows")
    expect(outcome.status).toBe("executed")
    await until(
      () => importCard(store)?.payload.detail === REPO_IMPORT_LOST_STREAM_DETAIL,
      "the lost-stream detail"
    )
    const card = importCard(store)
    // Honest standstill: the job may still run upstream — active, not failed.
    expect(card?.payload.phase).toBe("running")
    expect(card?.status).toBe("active")
  })
})
