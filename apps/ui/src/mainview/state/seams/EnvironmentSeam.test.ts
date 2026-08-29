import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { NativeAgent, NativeRepositories } from "../../native/NativeBridge"
import { createAppController } from "../AppController"
import type { AppServices } from "../AppController"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"

/*
 * The agent-environment seam (EnvironmentSeam.ts) through the real command
 * path: /env.view reads GET /api/repos/{owner}/{repo}/agent-environment and
 * surfaces the "env" card (vars, setup script, secret NAMES only); /env.set
 * validates one NAME=value pair, merges it into the current answer, PUTs the
 * WHOLE document back, and re-reads. Failures are honest strings, never
 * throws.
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

interface EnvRequest {
  readonly method: string
  readonly url: string
  readonly body: unknown
}

type EnvFailure = "get-500" | "get-throw" | "put-500" | "put-throw"

/*
 * The platform double: one agent-environment document in the reference wire
 * shape (snake_case, secrets as {name, updated_at} metadata). A PUT replaces
 * the stored document, so the seam's re-read answers the merged truth. Every
 * agent-environment request is captured, body included.
 */
const envBackend = (failure?: EnvFailure) => {
  const requests: EnvRequest[] = []
  let setupScript = "bun install"
  let env: Array<{ name: string; value: string }> = [{ name: "CI", value: "1" }]
  const secrets = [{ name: "NPM_TOKEN", updated_at: "2026-08-01T00:00:00.000Z" }]
  const answer = () => ({
    setup_script: setupScript,
    env,
    secrets,
    updated_at: "2026-08-01T00:00:00.000Z"
  })
  const services: AppServices = {
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method ?? "GET"
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined
      if (!url.includes("/agent-environment")) {
        return json(404, { status: "error", message: `no stub for ${url}` })
      }
      requests.push({ method, url, body })
      if (method === "GET") {
        if (failure === "get-throw") throw new Error("socket hang up")
        if (failure === "get-500") return json(500, { message: "the platform fell over" })
        return json(200, answer())
      }
      if (method === "PUT") {
        if (failure === "put-throw") throw new Error("socket hang up")
        if (failure === "put-500") return json(500, { message: "the platform refused the write" })
        const document = body as {
          setup_script: string
          env: Array<{ name: string; value: string }>
        }
        setupScript = document.setup_script
        env = document.env
        return json(200, answer())
      }
      return json(405, { message: `no stub for ${method} ${url}` })
    }
  }
  return { services, requests }
}

const freshController = async (failure?: EnvFailure) => {
  const backend = envBackend(failure)
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  return {
    store,
    requests: backend.requests,
    controller: createAppController(store, unavailableRepositories, unavailableAgent, backend.services)
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

const ready = async (store: AppStore): Promise<void> => {
  await signedIn(store)
  await reposChosen(store)
}

const envCard = (store: AppStore, repo = "will/flows") => {
  const card = store.collections.cards.get(`env-${repo}`)
  if (card === undefined || card.kind !== "env") return undefined
  return card
}

describe("environment seam — env.view", () => {
  test("surfaces the env card from the platform answer: vars, setup script, secret NAMES only", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("env.view")
    expect(outcome.status).toBe("executed")
    await settled()

    expect(requests).toHaveLength(1)
    expect(requests[0]?.method).toBe("GET")
    expect(requests[0]?.url).toBe("/api/repos/will/flows/agent-environment")

    const card = envCard(store)
    expect(card).toBeDefined()
    expect(card?.title).toBe("Agent environment · will/flows")
    expect(card?.status).toBe("active")
    expect(card?.payload.repo).toBe("will/flows")
    expect(card?.payload.vars).toEqual([{ name: "CI", value: "1" }])
    expect(card?.payload.setupScript).toBe("bun install")
    // Secret NAMES only — no value and no metadata ever reaches the card.
    expect(card?.payload.secretNames).toEqual(["NPM_TOKEN"])
    expect(JSON.stringify(card)).not.toContain("updated_at")
  })

  test("an explicit owner/repo argument targets that repository", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("env.view", "acme/site")
    expect(outcome.status).toBe("executed")
    expect(requests[0]?.url).toBe("/api/repos/acme/site/agent-environment")
    expect(envCard(store, "acme/site")).toBeDefined()
  })

  test("a watched-less signed-in session answers the repo-resolution error as-is", async () => {
    const { store, controller, requests } = await freshController()
    await signedIn(store)
    const outcome = await controller.commands.run("env.view")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe(
        "No repository is watched yet — run /repos.watch first, or name one as owner/repo"
      )
    }
    expect(requests).toHaveLength(0)
  })
})

describe("environment seam — env.set", () => {
  test("concurrent edits preserve both variables", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const [first, second] = await Promise.all([
      controller.commands.run("env.set", "FIRST=1"),
      controller.commands.run("env.set", "SECOND=2")
    ])
    expect(first.status).toBe("executed")
    expect(second.status).toBe("executed")
    expect(envCard(store)?.payload.vars).toEqual([
      { name: "CI", value: "1" },
      { name: "FIRST", value: "1" },
      { name: "SECOND", value: "2" }
    ])
  })

  test("merges the pair into the WHOLE document PUT, then re-reads into the card", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("env.set", "NODE_ENV=production")
    expect(outcome.status).toBe("executed")
    await settled()

    // Read → write → re-read, all against the one environment endpoint.
    expect(requests.map((request) => request.method)).toEqual(["GET", "PUT", "GET"])
    expect(requests[1]?.url).toBe("/api/repos/will/flows/agent-environment")
    // The reference body shape (agentEnvironment.ts putAgentEnvironment):
    // setup_script + env, sorted by name, and NO secrets key — secrets are
    // write-only through their own endpoint, never round-tripped here.
    expect(requests[1]?.body).toEqual({
      setup_script: "bun install",
      env: [
        { name: "CI", value: "1" },
        { name: "NODE_ENV", value: "production" }
      ]
    })

    const card = envCard(store)
    expect(card?.payload.vars).toEqual([
      { name: "CI", value: "1" },
      { name: "NODE_ENV", value: "production" }
    ])
    expect(card?.payload.setupScript).toBe("bun install")
    expect(card?.payload.secretNames).toEqual(["NPM_TOKEN"])
  })

  test("an existing name is replaced, not duplicated", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("env.set", "CI=0")
    expect(outcome.status).toBe("executed")
    expect(requests[1]?.body).toEqual({
      setup_script: "bun install",
      env: [{ name: "CI", value: "0" }]
    })
    expect(envCard(store)?.payload.vars).toEqual([{ name: "CI", value: "0" }])
  })

  test("a value carrying = signs splits on the FIRST = only", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("env.set", "TOKEN=abc=def==")
    expect(outcome.status).toBe("executed")
    const document = requests[1]?.body as { env: Array<{ name: string; value: string }> }
    expect(document.env).toContainEqual({ name: "TOKEN", value: "abc=def==" })
  })

  test("an empty pair answers the Commands.ts error; malformed pairs answer the seam's own", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)

    const empty = await controller.commands.run("env.set")
    expect(empty.status).toBe("failed")
    if (empty.status === "failed") expect(empty.error).toBe("env.set needs a NAME=value pair")

    const noEquals = await controller.commands.run("env.set", "NOEQUALS")
    expect(noEquals.status).toBe("failed")
    if (noEquals.status === "failed") {
      expect(noEquals.error).toBe(
        "\"NOEQUALS\" isn't a NAME=value pair — write it like NODE_ENV=production"
      )
    }

    const badName = await controller.commands.run("env.set", "1BAD=x")
    expect(badName.status).toBe("failed")
    if (badName.status === "failed") {
      expect(badName.error).toContain("\"1BAD\" isn't a valid variable name")
    }

    // None of the invalid shapes touched the platform.
    expect(requests).toHaveLength(0)
  })
})

describe("environment seam — honest failures", () => {
  test("a 500 on the read answers the platform's message, never a throw", async () => {
    const { store, controller } = await freshController("get-500")
    await ready(store)
    const outcome = await controller.commands.run("env.view")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("the platform fell over")
    expect(envCard(store)).toBeUndefined()
  })

  test("a network throw on the read answers an honest string", async () => {
    const { store, controller } = await freshController("get-throw")
    await ready(store)
    const outcome = await controller.commands.run("env.view")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe(
        "The agent environment for will/flows couldn't be read — the platform didn't answer."
      )
    }
  })

  test("a 500 on the write answers the platform's message and surfaces no card", async () => {
    const { store, controller, requests } = await freshController("put-500")
    await ready(store)
    const outcome = await controller.commands.run("env.set", "NODE_ENV=production")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("the platform refused the write")
    expect(requests.map((request) => request.method)).toEqual(["GET", "PUT"])
    expect(envCard(store)).toBeUndefined()
  })

  test("a network throw on the write answers an honest string naming the pair", async () => {
    const { store, controller } = await freshController("put-throw")
    await ready(store)
    const outcome = await controller.commands.run("env.set", "NODE_ENV=production")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe(
        "NODE_ENV couldn't be saved to will/flows — the platform didn't answer."
      )
    }
    expect(envCard(store)).toBeUndefined()
  })
})
