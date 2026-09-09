import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { NativeRepositories } from "../../native/NativeBridge"
import type { AgentPort } from "../../runtime/AgentPort"
import { createAppStore } from "../AppStore"
import { createAuthBillingController } from "./auth-billing"
import { createControllerContext } from "./context"

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const repositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "native unavailable"
  })
}

const agent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", code: "native-required", message: "native unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const signedIn = {
  state: "signed-in" as const,
  login: "will",
  allowlisted: true,
  admin: false
}

const runSignedInEntry = async (entry: "load" | "adopt") => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const calls: string[] = []
  const ctx = createControllerContext(store, repositories, agent, {
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const body = new URL(url, "https://app.test").pathname.endsWith("/auth/session")
        ? signedIn
        : {
          state: "ok",
          allowedToStartWork: true,
          balance: { totalUsd: "500", lifetimeChargedUsd: "0", chargeCount: 0 }
        }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    }
  })
  ctx.identityChanged = () => calls.push("identityChanged")
  ctx.resumeWorkflowRuns = () => calls.push("resumeWorkflowRuns")
  ctx.resumeDeferredCommand = () => calls.push("resumeDeferredCommand")
  ctx.withToast = async <T>(
    key: string,
    _title: string,
    _doneTitle: string,
    work: () => Promise<T | string>
  ): Promise<T | string> => {
    if (key === "billing.balance.refresh") calls.push("refreshBalance")
    return work()
  }

  const controller = createAuthBillingController(ctx, () => 0)
  if (entry === "load") await controller.loadSession()
  else await controller.adoptSession(signedIn)
  await new Promise((resolve) => setTimeout(resolve, 0))

  return {
    calls,
    transitions: [...store.collections.transitions.values()].map(({ actor, type, payload }) => ({
      actor,
      type,
      payload: JSON.parse(payload) as unknown
    }))
  }
}

describe("signed-in session adoption", () => {
  test("live and server-resolved sessions share every transition and follow-on call", async () => {
    const live = await runSignedInEntry("load")
    const adopted = await runSignedInEntry("adopt")

    expect(adopted.transitions).toEqual(live.transitions)
    expect(live.transitions).toEqual([
      {
        actor: "system",
        type: "identity.session.loaded",
        payload: { ...signedIn, scopesPlain: null }
      },
      {
        actor: "system",
        type: "billing.refreshed",
        payload: {
          state: "ok",
          totalUsd: "500",
          allowedToStartWork: true,
          lifetimeChargedUsd: "0",
          chargeCount: 0
        }
      }
    ])
    expect(adopted.calls).toEqual(live.calls)
    expect(live.calls).toEqual([
      "identityChanged",
      "refreshBalance",
      "resumeWorkflowRuns",
      "resumeDeferredCommand"
    ])
  })
})

/*
 * The sign-in return path. From a repository page (`/owner/name`) the
 * sign-in door names that page as `return_to`; from the landing page it
 * names nothing. Coming back, `?signed-in=github` on either page counts as
 * handled (so the boot strips it) without a chat message: the session probe
 * already says who signed in.
 */
describe("sign-in return path", () => {
  interface WindowStub {
    location: { pathname: string; search: string; assign: (url: string) => void }
  }
  const withWindow = async (pathname: string, search: string, run: (assigned: string[]) => Promise<void>) => {
    const assigned: string[] = []
    const stub: WindowStub = { location: { pathname, search, assign: (url) => void assigned.push(url) } }
    const globals = globalThis as unknown as { window?: unknown }
    const had = "window" in globals
    const previous = globals.window
    globals.window = stub
    try {
      await run(assigned)
    } finally {
      if (had) globals.window = previous
      else delete globals.window
    }
  }

  const signedOutController = async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const ctx = createControllerContext(store, repositories, agent, {
      fetchImpl: async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    })
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-out",
      login: null,
      allowlisted: false,
      admin: false,
      scopesPlain: null
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    return { store, controller: createAuthBillingController(ctx, () => 0) }
  }

  test("from a repository page the sign-in door names that page as return_to", async () => {
    const { controller } = await signedOutController()
    await withWindow("/smithersai/smithers", "?tab=issues", async (assigned) => {
      controller.signIn()
      expect(assigned).toEqual(["/api/auth/github/start?return_to=%2Fsmithersai%2Fsmithers%3Ftab%3Dissues"])
    })
  })

  test("from the landing page the sign-in door carries no return path", async () => {
    const { controller } = await signedOutController()
    await withWindow("/", "?repo=smithersai/smithers", async (assigned) => {
      controller.signIn()
      expect(assigned).toEqual(["/api/auth/github/start"])
    })
  })

  test("the signed-in marker is handled silently; a failed return still speaks", async () => {
    const { store, controller } = await signedOutController()
    const messages = () => [...store.collections.messages.values()].length
    const before = messages()
    expect(controller.handleAuthReturn("?signed-in=github")).toBe(true)
    expect(messages()).toBe(before)
    expect(controller.handleAuthReturn("?tab=issues")).toBe(false)
    expect(controller.handleAuthReturn("?auth=failed")).toBe(true)
    expect(messages()).toBe(before + 1)
  })
})
