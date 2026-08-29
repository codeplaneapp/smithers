import type { StorageApi } from "@tanstack/db"
import { expect, test } from "bun:test"
import type { TargetRunFrame } from "smithers-shared/LocalApp"
import { createAppStore } from "../AppStore"
import type { Card } from "../AppState"
import type { TargetRunClient } from "../TargetRunClient"
import type { ControllerContext } from "./context"
import { createTargetsController, targetsCardId } from "./targets"

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const setup = async (answer: Promise<Response> | Response) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const targetCard: Card = {
    id: targetsCardId("repo-1"),
    kind: "targets",
    title: "repo targets",
    status: "acted",
    createdAt: 1,
    ordinal: 1,
    payload: {
      repoId: "repo-1",
      repoName: "repo",
      status: "done",
      warnings: [],
      targets: [{
        id: "opaque-target",
        label: "//:check",
        target: "Shell.Test",
        kinds: ["test"],
        package: "//",
        name: "check",
        workspace: "."
      }]
    }
  }
  store.dispatch({ type: "card.upsert", actor: "system", card: targetCard })
  const attachments: Array<{ readonly runId: string; readonly onFrame: (frame: TargetRunFrame) => void }> = []
  const runs: TargetRunClient = {
    attach: (runId, onFrame) => {
      attachments.push({ runId, onFrame })
      return () => {}
    },
    dispose: () => {}
  }
  const ctx = {
    store,
    baseUrl: "",
    commandActor: "user",
    boundedFetch: async () => await answer,
    errorMessageOf: async (response: Response, fallback: string) => {
      const body = (await response.json().catch(() => undefined)) as { message?: unknown } | undefined
      return typeof body?.message === "string" ? body.message : fallback
    }
  } as unknown as ControllerContext
  const controller = createTargetsController(ctx, {
    nextOrdinal: () => 2,
    loadRepos: async () => {},
    runs
  })
  return { controller, store, attachments }
}

const runCards = (store: Awaited<ReturnType<typeof createAppStore>>) =>
  [...store.collections.cards.values()].filter((card) => card.kind === "target-run")

test("a slow target validation is represented immediately, then adopts the server run id", async () => {
  let resolve!: (response: Response) => void
  const pending = new Promise<Response>((accept) => { resolve = accept })
  const { controller, store, attachments } = await setup(pending)

  const running = controller.runTarget("repo-1", ".", "//:check")
  expect(runCards(store)).toHaveLength(1)
  expect(runCards(store)[0]?.payload).toMatchObject({
    runId: "",
    label: "//:check",
    status: "running",
    output: "Validating the target against the current repository…\n"
  })

  resolve(Response.json({ runId: "run-1" }))
  expect(await running).toBeUndefined()
  expect(runCards(store)[0]?.payload).toMatchObject({ runId: "run-1", status: "running", output: "" })
  expect(attachments.map(({ runId }) => runId)).toEqual(["run-1"])
})

test("a refused validation settles the request card as failed", async () => {
  const { controller, store, attachments } = await setup(
    Response.json({ message: "That target is stale." }, { status: 409 })
  )

  expect(await controller.runTarget("repo-1", ".", "//:check")).toBe("That target is stale.")
  expect(runCards(store)[0]).toMatchObject({
    status: "error",
    payload: { runId: "", status: "failed", output: "error: That target is stale.\n" }
  })
  expect(attachments).toEqual([])
})
