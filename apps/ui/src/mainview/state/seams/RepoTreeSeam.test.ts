import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { Repo } from "@smthrs/rpc/LocalApp"
import type { NativeAgent, NativeRepositories } from "../../native/NativeBridge"
import { scopedControllers } from "../ControllerTestScope"
import { trackDispatchCommits } from "../StoreTestScope"
import type { AppServices } from "../AppController"
import { repoKeyOf, repoTreeRowId } from "../AppState"
import { createAppStore } from "../AppStore"

const createAppController = scopedControllers()

/*
 * The sidebar's file tree seam (RepoTreeSeam.ts) through the real command
 * path: /repo.tree <copyId>[#path] posts the SAME request the files flows
 * post (`POST /api/repo/files { repoId, path }`, the route contract in
 * @smthrs/rpc/LocalApp) and writes the app-repo-tree row for that
 * directory: loaded with exactly the entries the route answered, or failed
 * with the route's error text verbatim. Toggling is collection state, never
 * a second request; the rows never survive a relaunch.
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

const localRepo = (id: string, name: string, path: string): Repo => ({
  id,
  path,
  name,
  git: { branch: "main", remote: `git@github.com:${name}.git` },
  warnings: [],
  smithers: { detected: true, workspaceFile: "WORKSPACE.ts", declarationFiles: [], reason: "1 workspace detected", workspaces: [{ path: ".", title: name }] }
})
const SMITHERS = localRepo("repo-smithers", "smithersai/smithers", "/Users/will/smithers")
const COPY = repoKeyOf(SMITHERS.path)

/*
 * The local app double, answering the route's own shapes: the root (dirs
 * first, a `.git` entry like any other), an empty directory, a truncated one,
 * a file, and two refusals in the route's error envelope.
 */
const treeBackend = () => {
  const requests: Array<{ readonly repoId?: string; readonly path?: string }> = []
  const answers: Record<string, () => Response> = {
    "": () =>
      json(200, {
        kind: "dir",
        path: "",
        entries: [{ name: ".git", kind: "dir" }, { name: "packages", kind: "dir" }, { name: "README.md", kind: "file" }, { name: "zeta.txt", kind: "file" }]
      }),
    "packages": () => json(200, { kind: "dir", path: "packages", entries: [{ name: "ui", kind: "dir" }, { name: "PACKAGE.ts", kind: "file" }] }),
    "packages/smithers/ui": () => json(200, { kind: "dir", path: "packages/smithers/ui", entries: [] }),
    ".git": () => json(200, { kind: "dir", path: ".git", entries: [{ name: "HEAD", kind: "file" }], truncated: true }),
    "README.md": () => json(200, { kind: "file", path: "README.md", size: 14, content: "# Local — hi\n", truncated: false, binary: false }),
    "secret": () => json(403, { error: { code: "path_outside_repository", message: "secret points outside the repository." } }),
    "boom": () => json(500, { error: { code: "read_failed", message: "Could not list boom." } })
  }
  const services: AppServices = {
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const path = new URL(url, "http://local.test").pathname
      if (path !== "/api/repo/files") return json(404, { status: "error", message: `no stub for ${url}` })
      const body = JSON.parse(String(init?.body ?? "{}")) as { repoId?: string; path?: string }
      requests.push(body)
      const answer = answers[body.path ?? ""]
      return answer === undefined
        ? json(404, { error: { code: "path_not_found", message: `Path not found: ${body.path}` } })
        : answer()
    }
  }
  return { services, requests }
}

const treeController = async (repos: ReadonlyArray<Repo> = [SMITHERS]) => {
  const backend = treeBackend()
  const storage = memoryStorage()
  const { store, settle } = trackDispatchCommits(await createAppStore({ kind: "localStorage", storage }))
  const controller = createAppController(store, unavailableRepositories, unavailableAgent, {
    ...backend.services,
    bootstrap: {
      apiVersion: 1,
      host: "local",
      version: "test",
      buildSha: "test",
      capabilities: ["local.repositories", "local.targets", "local.terminal", "local.harnesses"],
      authFlow: "none",
      sandbox: { platform: "darwin", mode: "enforced" }
    }
  })
  await store.dispatch({ type: "repos.loaded", actor: "system", repos: [...repos] }).isPersisted.promise
  return { store, controller, storage, requests: backend.requests, settle }
}

describe("repo tree seam — one directory per request, the route's answer verbatim", () => {
  test("/repo.tree <copyId> lists the root through POST /api/repo/files and writes the loaded row, nothing filtered", async () => {
    const { store, controller, requests } = await treeController()
    const outcome = await controller.commands.run("repo.tree", COPY)
    expect(outcome.status).toBe("executed")
    expect(requests).toEqual([{ repoId: "repo-smithers", path: "" }])
    const root = store.collections.repoTree.get(repoTreeRowId(COPY, ""))
    expect(root).toMatchObject({
      copyId: COPY,
      path: "",
      expanded: true,
      state: "loaded",
      entries: [{ name: ".git", kind: "dir" }, { name: "packages", kind: "dir" }, { name: "README.md", kind: "file" }, { name: "zeta.txt", kind: "file" }]
    })
    expect(root?.truncated).toBeUndefined()
    expect(root?.error).toBeUndefined()
  })

  test("a nested path rides the `#` grammar; a second toggle collapses without a request, a third expands without one", async () => {
    const { store, controller, requests } = await treeController()
    expect((await controller.commands.run("repo.tree", `${COPY}#packages`)).status).toBe("executed")
    expect(requests).toEqual([{ repoId: "repo-smithers", path: "packages" }])
    const id = repoTreeRowId(COPY, "packages")
    expect(store.collections.repoTree.get(id)?.entries).toEqual([{ name: "ui", kind: "dir" }, { name: "PACKAGE.ts", kind: "file" }])
    expect((await controller.commands.run("repo.tree", `${COPY}#packages`)).status).toBe("executed")
    expect(store.collections.repoTree.get(id)?.expanded).toBe(false)
    expect((await controller.commands.run("repo.tree", `${COPY}#packages/`)).status).toBe("executed")
    expect(store.collections.repoTree.get(id)?.expanded).toBe(true)
    expect(requests).toHaveLength(1)
    // An empty directory is a loaded row with no entries — the tree says "empty", never invents a child.
    expect((await controller.commands.run("repo.tree", `${COPY}#packages/smithers/ui`)).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId(COPY, "packages/smithers/ui"))).toMatchObject({ state: "loaded", entries: [] })
  })

  test("a capped listing keeps the route's truncated flag", async () => {
    const { store, controller } = await treeController()
    expect((await controller.commands.run("repo.tree", `${COPY}#.git`)).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId(COPY, ".git"))).toMatchObject({ state: "loaded", truncated: true, entries: [{ name: "HEAD", kind: "file" }] })
  })

  test("a refusal writes the failed row with the server's message verbatim, and the next toggle retries", async () => {
    const { store, controller, requests } = await treeController()
    expect((await controller.commands.run("repo.tree", `${COPY}#secret`)).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId(COPY, "secret"))).toMatchObject({
      state: "failed",
      expanded: true,
      entries: [],
      error: "secret points outside the repository."
    })
    expect((await controller.commands.run("repo.tree", `${COPY}#boom`)).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId(COPY, "boom"))?.error).toBe("Could not list boom.")
    expect((await controller.commands.run("repo.tree", `${COPY}#missing`)).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId(COPY, "missing"))?.error).toBe("Path not found: missing")
    // A file behind a caret cannot happen from the tree, but the row still says so honestly.
    expect((await controller.commands.run("repo.tree", `${COPY}#README.md`)).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId(COPY, "README.md"))?.error).toBe("README.md in smithersai/smithers is a file — run /files.read README.md instead")
    // A failed row collapses like any other; expanding it again is the retry.
    const before = requests.length
    expect((await controller.commands.run("repo.tree", `${COPY}#boom`)).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId(COPY, "boom"))?.expanded).toBe(false)
    expect(requests.length).toBe(before)
    expect((await controller.commands.run("repo.tree", `${COPY}#boom`)).status).toBe("executed")
    expect(requests.length).toBe(before + 1)
    expect(store.collections.repoTree.get(repoTreeRowId(COPY, "boom"))).toMatchObject({ expanded: true, state: "failed", error: "Could not list boom." })
  })

  test("a copy that is not open on this machine, or not a checkout, fails in place; an unknown copy is a refusal", async () => {
    const { store, controller, requests } = await treeController()
    const other = repoKeyOf("/Users/will/plue")
    await store.dispatch({
      type: "repo.pinned",
      actor: "user",
      pin: { id: other, name: "plue", path: "/Users/will/plue", branch: "main", origin: "local", pinnedAt: 1 }
    }).isPersisted.promise
    expect((await controller.commands.run("repo.tree", other)).status).toBe("executed")
    expect(store.collections.repoTree.get(repoTreeRowId(other, ""))).toMatchObject({
      state: "failed",
      error: "plue is pinned but not open on this machine — open it with /repo.open, then retry."
    })
    expect(requests).toHaveLength(0)
    await store.dispatch({
      type: "workingcopies.workspaces.loaded",
      actor: "system",
      copies: [{ id: "ws-1", repoId: "will/flows", kind: "workspace", label: "fix-landings", workspaceId: "ws-1", state: "running" }]
    }).isPersisted.promise
    const cloud = await controller.commands.run("repo.tree", "ws-1")
    expect(cloud.status).toBe("failed")
    expect(JSON.stringify(cloud)).toContain("fix-landings is a cloud workspace")
    const unknown = await controller.commands.run("repo.tree", "local:/nowhere")
    expect(unknown.status).toBe("failed")
    expect(JSON.stringify(unknown)).toContain("There is no working copy with id local:/nowhere.")
    // A blank line lacks the copy id: the form asks for it (THE FORM LAW), nothing is refused.
    const blank = await controller.commands.run("repo.tree", "")
    expect(blank).toEqual({ status: "form", flow: "repo.tree", cardId: "form-repo.tree", fields: ["copy"] })
  })

  test("the rows are collection state for this launch only: a store reopened over the same storage starts collapsed", async () => {
    const { store, controller, storage, settle } = await treeController()
    expect((await controller.commands.run("repo.tree", COPY)).status).toBe("executed")
    expect(store.collections.repoTree.size).toBe(1)
    expect([...store.collections.repoTree.values()][0]?.expanded).toBe(true)
    await controller.dispose()
    await settle()
    const reopened = await createAppStore({ kind: "localStorage", storage })
    expect(reopened.collections.repoTree.size).toBe(0)
    // Nothing under the tree's id ever reached the shared storage.
    expect(storage.getItem("smithers-mvp.app-repo-tree")).toBeNull()
  })

  test("unpinning a checkout forgets its tree rows", async () => {
    const { store, controller } = await treeController()
    expect((await controller.commands.run("repo.tree", COPY)).status).toBe("executed")
    expect((await controller.commands.run("repo.tree", `${COPY}#packages`)).status).toBe("executed")
    expect(store.collections.repoTree.size).toBe(2)
    expect((await controller.commands.run("repo.unpin", COPY)).status).toBe("executed")
    expect(store.collections.repoTree.size).toBe(0)
  })

  test("repo.tree is one flow with three doors: the caret, the slash, and the agent (the three-door law); the agent reads contents with files.list", async () => {
    const { controller } = await treeController()
    const catalog = controller.commands.all().find((command) => command.name === "repo.tree")
    expect(catalog?.hidden).toBeUndefined()
    expect(catalog?.confirm).toBeUndefined()
    expect(controller.commands.find("repo.tree")?.binding.descriptor.modelInvocable).toBe(true)
  })
})

describe("the workspace name", () => {
  test("/workspace.rename writes the heading's name; a blank name renders the form; the pencil toggles the inline editor", async () => {
    const { store, controller } = await treeController([])
    expect(store.session().workspaceName).toBeUndefined()
    expect((await controller.commands.run("workspace.rename", "  Force  ")).status).toBe("executed")
    expect(store.session().workspaceName).toBe("Force")
    expect(store.session().workspaceRenameOpen).toBe(false)
    const blank = await controller.commands.run("workspace.rename", "   ")
    expect(blank).toEqual({ status: "form", flow: "workspace.rename", cardId: "form-workspace.rename", fields: ["name"] })
    expect(store.session().workspaceName).toBe("Force")
    expect((await controller.commands.run("workspace.rename.edit")).status).toBe("executed")
    expect(store.session().workspaceRenameOpen).toBe(true)
    expect((await controller.commands.run("workspace.rename.edit")).status).toBe("executed")
    expect(store.session().workspaceRenameOpen).toBe(false)
    // A rename while the editor is open closes it.
    await controller.commands.run("workspace.rename.edit")
    expect((await controller.commands.run("workspace.rename", "Plue")).status).toBe("executed")
    expect(store.session()).toMatchObject({ workspaceName: "Plue", workspaceRenameOpen: false })
  })
})
