import { expect, test } from "bun:test"
import { cardFrameId, rootFrameId } from "./AppState"
import type { Card, CloudWorkspaceInput } from "./AppState"
import { createAppStore } from "./AppStore"
import { workspaceCardFacts } from "./WorkspaceViews"

const workspace: CloudWorkspaceInput = {
  id: "computer",
  repoId: "org/repo",
  name: "Computer",
  status: "running",
  targetBookmark: "main",
  provisioningStage: null,
  suspendedAt: null,
  createdAt: null,
  head: { changeId: "change", commitId: "commit" }
}
const card: Card = {
  id: "workspace-computer",
  kind: "workspace",
  title: "Computer",
  status: "active",
  createdAt: 1,
  ordinal: 1,
  payload: {
    ...workspaceCardFacts(workspace),
    bookmarkHead: null,
    snapshots: [],
    sessions: [],
    files: [],
    facet: "files"
  }
}

test("one workspace update drives both live views while frame captures remain fixed, including after restore and restart", async () => {
  const data = new Map<string, string>()
  const backend = {
    kind: "localStorage" as const,
    storage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value)
      },
      removeItem: (key: string) => {
        data.delete(key)
      }
    }
  }
  const store = await createAppStore(backend)
  const apply = async (transition: Parameters<typeof store.dispatch>[0]) =>
    store.dispatch(transition).isPersisted.promise
  await apply({ type: "workspace.updated", actor: "system", workspace })
  await apply({ type: "card.upsert", actor: "system", card })
  await apply({ type: "card.maximized", actor: "user", id: card.id })
  const { activeBranchId: branchId, activeWorkspaceId: workspaceId } = store.session()
  const captured = store.collections.frames.get(cardFrameId(branchId!, card.id))!.snapshot!
  await apply({
    type: "workspace.updated",
    actor: "system",
    workspace: {
      ...workspace,
      name: "Renamed",
      status: "failed",
      failureMessage: "Stopped by the provider",
      head: null
    }
  })
  expect(store.collections.workingCopies.get("workspace:computer")).toMatchObject({ label: "Renamed", state: "failed" })
  expect(store.collections.cards.get(card.id)).toMatchObject({
    title: "Renamed · org/repo",
    payload: {
      name: "Renamed",
      status: "failed",
      head: null,
      failureMessage: "Stopped by the provider",
      files: [],
      facet: "files"
    }
  })
  expect(captured.cards[0]).toMatchObject({ payload: { name: "Computer", status: "running", snapshot: true } })

  // Archive the current facts, then change the live row while that branch is absent.
  await apply({ type: "conversation.cleared", actor: "user", branchId: "next-conversation", notes: [] })
  await apply({ type: "workspace.updated", actor: "system", workspace })
  await apply({
    type: "frame.navigated",
    actor: "user",
    workspaceId: workspaceId!,
    branchId: branchId!,
    frameId: rootFrameId(branchId!)
  })
  expect(store.collections.cards.get(card.id)).toMatchObject({ payload: { status: "failed", snapshot: true } })
  expect(store.collections.workingCopies.get("workspace:computer")).toMatchObject({ state: "running" })
  await store.dispose?.()

  const reopened = await createAppStore(backend)
  expect(reopened.collections.cards.get(card.id)).toMatchObject({ payload: { status: "failed", snapshot: true } })
  expect(reopened.collections.workingCopies.get("workspace:computer")).toMatchObject({ state: "running" })
  await reopened.dispose?.()
})

test("full rows supersede legacy inventory; leaving the scope captures the last live card facts", async () => {
  const store = await createAppStore({
    kind: "localStorage",
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  })
  await store.dispatch({
    type: "workingcopies.workspaces.loaded",
    actor: "system",
    copies: [{
      id: "workspace:computer",
      workspaceId: "computer",
      repoId: "org/repo",
      kind: "workspace",
      label: "Old name"
    }]
  }).isPersisted.promise
  expect(store.collections.workingCopies.get("workspace:computer")?.label).toBe("Old name")
  await store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
  await store.dispatch({
    type: "workspace.updated",
    actor: "system",
    workspace: { ...workspace, name: "Renamed", status: "suspended" }
  }).isPersisted.promise
  expect([...store.collections.workingCopies.values()]).toMatchObject([{ label: "Renamed", state: "suspended" }])
  await store.dispatch({ type: "workspaces.loaded", actor: "system", workspaces: [], repoId: "org/repo" }).isPersisted
    .promise
  expect(store.collections.workingCopies.size).toBe(0)
  expect(store.collections.cards.get(card.id)).toMatchObject({
    payload: { name: "Renamed", status: "suspended" }
  })
  await store.dispatch({ type: "workspace.updated", actor: "system", workspace }).isPersisted.promise
  expect(store.collections.cards.get(card.id)).toMatchObject({ payload: { name: "Computer", status: "running" } })
  await store.dispose?.()
})
