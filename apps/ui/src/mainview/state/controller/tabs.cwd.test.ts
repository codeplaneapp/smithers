import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { Harness, Repo } from "smithers-shared/LocalApp"
import { createAppStore } from "../AppStore"
import type { ControllerContext } from "./context"
import { createTabsController } from "./tabs"

/*
 * Regression: a Claude Code tab launched with no repository open started in
 * `~` and its tab read "Claude Code" as if it sat in the repository. The
 * PTY request carries the open repository's id so the server starts the
 * process there, and the tab's title names where it actually runs.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const repo: Repo = {
  id: "repo-1",
  path: "/Users/u/smithers",
  name: "smithers",
  git: { branch: "main", remote: null },
  warnings: [],
  smithers: { detected: true, workspaceFile: null, declarationFiles: [], reason: "", workspaces: [] }
}

const claude: Harness = {
  id: "claude",
  displayName: "Claude Code",
  binary: "/usr/local/bin/claude",
  version: "1.0.0",
  status: "signed-in",
  account: { email: "will@example.com" },
  launch: { argv: ["claude"] }
}

const setup = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const bodies: Array<Record<string, unknown>> = []
  let next = 0
  const ctx = {
    store,
    baseUrl: "http://local",
    boundedFetch: async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>)
      next += 1
      return new Response(JSON.stringify({ sessionId: `pty-${next}` }), { status: 200 })
    },
    errorMessageOf: async (_response: Response, fallback: string) => fallback,
    unref: () => {}
  } as unknown as ControllerContext
  store.dispatch({ type: "harnesses.loaded", actor: "system", harnesses: [claude] })
  return { store, ctx, bodies, tabs: createTabsController(ctx) }
}

describe("where a process tab runs", () => {
  test("with no repository open the request carries no repoId and the tab says ~", async () => {
    const { store, bodies, tabs } = await setup()
    await tabs.openTerminalTab()
    await tabs.openHarnessTab("claude")
    expect(bodies.map((body) => body.repoId)).toEqual([undefined, undefined])
    expect(store.collections.tabs.get("pty-1")).toMatchObject({ kind: "terminal", title: "Terminal · ~", cwd: "~" })
    expect(store.collections.tabs.get("pty-2")).toMatchObject({ kind: "harness", title: "Claude Code · ~", cwd: "~" })
  })

  test("with a repository open the request carries its repoId and the tab names it", async () => {
    const { store, bodies, tabs } = await setup()
    store.dispatch({ type: "repos.loaded", actor: "system", repos: [repo] })
    await tabs.openTerminalTab()
    await tabs.openHarnessTab("claude")
    expect(bodies.map((body) => body.repoId)).toEqual(["repo-1", "repo-1"])
    expect(store.collections.tabs.get("pty-1")).toMatchObject({ title: "Terminal · smithers", cwd: "/Users/u/smithers" })
    expect(store.collections.tabs.get("pty-2")).toMatchObject({ title: "Claude Code · smithers", cwd: "/Users/u/smithers" })
  })
})
