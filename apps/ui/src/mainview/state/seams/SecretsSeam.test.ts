import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { NativeAgent, NativeRepositories } from "../../native/NativeBridge"
import { createAppController } from "../AppController"
import type { AppServices } from "../AppController"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"

/*
 * The secrets seam (SecretsSeam.ts) through the real command path:
 * /secrets.list reads GET /api/repos/{owner}/{repo}/agent-environment and
 * surfaces the "secrets" card with each secret's metadata (name, hosts,
 * match headers, updated time) and never a value. Failures are honest
 * strings, never throws; signed out, the agent door names the sign-in step.
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

type Failure = "get-500" | "get-403" | "get-throw" | "malformed"

/** The platform double: plue's AgentEnvironmentResponse, secrets as metadata rows with no value field. */
const backend = (failure?: Failure) => {
  const requests: Array<{ readonly method: string; readonly url: string }> = []
  const services: AppServices = {
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method ?? "GET"
      if (!url.includes("/agent-environment")) {
        return json(404, { status: "error", message: `no stub for ${url}` })
      }
      requests.push({ method, url })
      if (failure === "get-throw") throw new Error("socket hang up")
      if (failure === "get-500") return json(500, { message: "the platform fell over" })
      if (failure === "get-403") return json(403, { message: "forbidden: repository write access required" })
      if (failure === "malformed") return json(200, { setup_script: "", env: [], secrets: [{ hosts: [] }] })
      return json(200, {
        setup_script: "bun install",
        env: [{ name: "CI", value: "1" }],
        secrets: [
          {
            name: "NPM_TOKEN",
            hosts: ["registry.npmjs.org"],
            match_headers: ["authorization"],
            updated_at: "2026-08-01T00:00:00.000Z"
          },
          { name: "SETUP_ONLY", hosts: [], match_headers: [], updated_at: "2026-08-02T00:00:00.000Z" }
        ],
        updated_at: "2026-08-02T00:00:00.000Z"
      })
    }
  }
  return { services, requests }
}

const freshController = async (failure?: Failure) => {
  const stub = backend(failure)
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  return {
    store,
    requests: stub.requests,
    controller: createAppController(store, unavailableRepositories, unavailableAgent, stub.services)
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

const signedOut = async (store: AppStore): Promise<void> => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-out",
    login: null,
    allowlisted: false,
    admin: false,
    scopesPlain: null
  })
  await settled()
}

const reposChosen = async (store: AppStore): Promise<void> => {
  store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: [{ id: "will/flows", org: "will", ownerKind: "user", name: "flows", head: null }]
  })
  await settled()
}

const ready = async (store: AppStore): Promise<void> => {
  await signedIn(store)
  await reposChosen(store)
}

const secretsCard = (store: AppStore, repo = "will/flows") => {
  const card = store.collections.cards.get(`secrets-${repo}`)
  if (card === undefined || card.kind !== "secrets") return undefined
  return card
}

describe("secrets seam — secrets.list", () => {
  test("surfaces the secrets card from the agent-environment answer: name, hosts, header, updated time, no value", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("secrets.list")
    expect(outcome.status).toBe("executed")
    await settled()

    expect(requests).toEqual([{ method: "GET", url: "/api/repos/will/flows/agent-environment" }])
    const card = secretsCard(store)
    expect(card).toBeDefined()
    expect(card?.title).toBe("Secrets · will/flows")
    expect(card?.status).toBe("active")
    expect(card?.payload.repo).toBe("will/flows")
    expect(card?.payload.scope).toBe("repository")
    expect(card?.payload.secrets).toEqual([
      { name: "NPM_TOKEN", hosts: ["registry.npmjs.org"], matchHeaders: ["authorization"], updatedAt: "2026-08-01T00:00:00.000Z" },
      { name: "SETUP_ONLY", hosts: [], matchHeaders: [], updatedAt: "2026-08-02T00:00:00.000Z" }
    ])
    // The environment's vars and setup script are the env card's, not this one's.
    expect(JSON.stringify(card)).not.toContain("bun install")
    expect(JSON.stringify(card)).not.toContain("\"CI\"")
  })

  test("an explicit owner/repo argument targets that repository", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("secrets.list", "acme/site")
    expect(outcome.status).toBe("executed")
    expect(requests[0]?.url).toBe("/api/repos/acme/site/agent-environment")
    expect(secretsCard(store, "acme/site")).toBeDefined()
  })

  test("listing twice re-surfaces the one card at a later ordinal, never a second card", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    await controller.commands.run("secrets.list")
    const first = secretsCard(store)?.ordinal
    await controller.commands.run("secrets.list")
    const cards = [...store.collections.cards.values()].filter((card) => card.kind === "secrets")
    expect(cards).toHaveLength(1)
    expect(cards[0]?.ordinal).toBeGreaterThan(first ?? Number.POSITIVE_INFINITY)
  })

  test("the agent's door reads the same list", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    const outcome = await controller.commands.runForAgent("secrets.list")
    expect(outcome.status).toBe("executed")
    expect(requests).toHaveLength(1)
    expect(secretsCard(store)?.payload.secrets.map((secret) => secret.name)).toEqual(["NPM_TOKEN", "SETUP_ONLY"])
  })

  test("an inventory-less signed-in session answers the repo-resolution error as-is", async () => {
    const { store, controller, requests } = await freshController()
    await signedIn(store)
    const outcome = await controller.commands.run("secrets.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe(
        "No repository is loaded yet — sign in with /cloud.sign-in, or name one as owner/repo"
      )
    }
    expect(requests).toHaveLength(0)
  })

  test("signed out, the agent's invocation names the sign-in step and reads nothing", async () => {
    const { store, controller, requests } = await freshController()
    await signedOut(store)
    const outcome = await controller.commands.runForAgent("secrets.list", "will/flows")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toContain("Sign in with GitHub first")
    expect(requests).toHaveLength(0)
    expect(secretsCard(store)).toBeUndefined()
  })
})

describe("secrets seam — honest failures", () => {
  test("a 403 answers the platform's message and surfaces no card", async () => {
    const { store, controller } = await freshController("get-403")
    await ready(store)
    const outcome = await controller.commands.run("secrets.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("forbidden: repository write access required")
    expect(secretsCard(store)).toBeUndefined()
  })

  test("a 500 answers the platform's message, never a throw", async () => {
    const { store, controller } = await freshController("get-500")
    await ready(store)
    const outcome = await controller.commands.run("secrets.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("the platform fell over")
    expect(secretsCard(store)).toBeUndefined()
  })

  test("a network throw answers an honest string", async () => {
    const { store, controller } = await freshController("get-throw")
    await ready(store)
    const outcome = await controller.commands.run("secrets.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("The agent environment for will/flows couldn't be read — the platform didn't answer.")
    }
  })

  test("a malformed answer names the shape problem and surfaces no card", async () => {
    const { store, controller } = await freshController("malformed")
    await ready(store)
    const outcome = await controller.commands.run("secrets.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("The agent-environment answer for will/flows wasn't in the expected shape.")
    }
    expect(secretsCard(store)).toBeUndefined()
  })
})
