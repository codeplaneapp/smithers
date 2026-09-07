import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { cloudCapabilities } from "@smthrs/rpc/HostCapabilities"
import type { NativeAgent, NativeRepositories } from "../../native/NativeBridge"
import type { AppServices } from "../AppController"
import type { Card } from "../AppState"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { scopedControllers } from "../ControllerTestScope"
import { parseActivity, summaryPredicate, welcomeSentence } from "./onboarding"

/*
 * The repository welcome's decisions, through the one run path: the gate
 * (signed-out + maintain parks the flow and renders the sign-in step; the
 * signed-in answer resumes it as the signed-in user; the model's invocation
 * renders the step and fails honestly), the explore branch (the guide
 * documents the repository actually holds, read through the public contents
 * route), the maintain card's honest line while the activity route 404s, and
 * the feature sketch as the human's own turn.
 */

const createAppController = scopedControllers()

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
  pickLocalRepository: async () => ({ status: "error", code: "native-required", message: "native only" })
}

const REPO = "smithersai/smithers"
const SUMMARY = "Smithers is a durable framework that lets agents plan, run, and review changes to a code repository through flows."

const WEB: AppBootstrap = {
  apiVersion: 1,
  host: "cloud",
  version: "test",
  buildSha: "cloud",
  capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: true, terminal: false }),
  authFlow: "redirect",
  sandbox: null
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const settled = async (ticks = 4): Promise<void> => {
  for (let tick = 0; tick < ticks; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

const fixture = async (routes: Record<string, () => Response>) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const requests: Array<string> = []
  const turns: Array<string> = []
  const agent: NativeAgent = {
    available: true,
    startTurn: async (request) => {
      const last = request.messages.at(-1)
      turns.push(last !== undefined && "content" in last ? last.content : "")
      return { status: "started" }
    },
    cancelTurn: async () => {},
    subscribe: () => () => {}
  }
  const services: AppServices = {
    bootstrap: WEB,
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const path = new URL(url, "https://app.test").pathname
      requests.push(path)
      return (routes[path] ?? (() => json(404, { status: "error", message: `no stub for ${path}` })))()
    }
  }
  const controller = createAppController(store, unavailableRepositories, agent, services)
  store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: [{ id: REPO, org: "smithersai", ownerKind: "user", name: "smithers", head: null, catalog: true, summary: SUMMARY }]
  })
  store.dispatch({ type: "repo.selected", actor: "user", id: REPO })
  return { store, controller, requests, turns }
}

const identity = (store: AppStore, state: "signed-out" | "signed-in"): void => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state,
    login: state === "signed-in" ? "will" : null,
    allowlisted: state === "signed-in",
    admin: false,
    scopesPlain: null
  })
}

const onboardingCards = (store: AppStore): Array<Extract<Card, { kind: "repo-onboarding" }>> =>
  [...store.collections.cards.values()]
    .flatMap((card) => (card.kind === "repo-onboarding" ? [card] : []))
    .sort((left, right) => left.ordinal - right.ordinal)

const lastMessage = (store: AppStore) =>
  [...store.collections.messages.values()].sort((left, right) => left.ordinal - right.ordinal).at(-1)

describe("the welcome's sentence", () => {
  test("turns the catalog's product sentence into a predicate of the repository", () => {
    expect(summaryPredicate(REPO, SUMMARY)).toBe(
      "a durable framework that lets agents plan, run, and review changes to a code repository through flows."
    )
    expect(welcomeSentence(REPO, summaryPredicate(REPO, SUMMARY))).toBe(`Welcome to Smithers. ${REPO} is ${summaryPredicate(REPO, SUMMARY)}`)
    // A sentence that does not open on the repository's name is kept whole.
    expect(summaryPredicate("acme/widgets", "A widget toolkit for the web.")).toBe("A widget toolkit for the web.")
    expect(summaryPredicate(REPO, undefined)).toBeNull()
    expect(summaryPredicate(REPO, "  ")).toBeNull()
  })

  test("the activity answer is read only in the route's shape", () => {
    expect(parseActivity({ sentence: "2 commits this week.", counts: { commits: 2, pullRequests: 0, issues: 0 }, since: "2026-08-31" }))
      .toEqual({ sentence: "2 commits this week.", counts: { commits: 2, pullRequests: 0, issues: 0 }, since: "2026-08-31" })
    // A count the mirror could not answer is null and rides the card as null, never as a zero.
    expect(parseActivity({ sentence: "Pull request activity is not available.", counts: { commits: 2, pullRequests: null, issues: 0 } }))
      .toEqual({ sentence: "Pull request activity is not available.", counts: { commits: 2, pullRequests: null, issues: 0 }, since: "" })
    expect(parseActivity({ sentence: "", counts: { commits: 2, pullRequests: 0, issues: 0 } })).toBeNull()
    expect(parseActivity({ sentence: "x", counts: { commits: -1, pullRequests: 0, issues: 0 } })).toBeNull()
    expect(parseActivity("nope")).toBeNull()
  })
})

describe("repo.welcome", () => {
  test("renders the welcome card for the selected catalog repository with its curated sentence", async () => {
    const { store, controller } = await fixture({})
    const outcome = await controller.commands.run("repo.welcome")
    expect(outcome.status).toBe("executed")
    const [card] = onboardingCards(store)
    expect(card?.id).toBe(`repo-welcome-${REPO}`)
    expect(card?.payload).toEqual({
      stage: "welcome",
      repo: REPO,
      summary: "a durable framework that lets agents plan, run, and review changes to a code repository through flows."
    })
  })

  test("the model's door answers the sentence and names the three flows", async () => {
    const { controller } = await fixture({})
    const outcome = await controller.commands.runForAgent("repo.welcome")
    expect(outcome.status).toBe("executed")
    if (outcome.status === "executed") {
      expect(outcome.value).toContain(`Welcome to Smithers. ${REPO} is a durable framework`)
      expect(outcome.value).toContain("repo.maintain")
      expect(outcome.value).toContain("repo.explore")
    }
  })
})

describe("repo.maintain", () => {
  test("signed out, the human's click parks the flow and renders the sign-in step; the signed-in answer resumes it", async () => {
    const { store, controller } = await fixture({})
    identity(store, "signed-out")
    await settled()
    const outcome = await controller.commands.run("repo.maintain", REPO)
    expect(outcome.status).toBe("executed")
    await settled()
    // The gating decision: the auth.prompt step, one click away, and no maintain card yet.
    const prompt = lastMessage(store)
    expect(prompt?.action).toEqual({ flow: "auth.sign-in", label: "Sign in with GitHub" })
    expect(onboardingCards(store)).toEqual([])
    expect(store.session().pendingCommand).toMatchObject({ name: "repo.maintain", args: REPO, requirement: "signed-in" })

    // The existing auth-return path: the signed-in answer (the session load calls
    // resumeDeferredCommand after it settles) continues the parked flow as the signed-in user.
    identity(store, "signed-in")
    controller.resumeDeferredCommand()
    await settled(8)
    expect(store.session().pendingCommand ?? null).toBeNull()
    const [card] = onboardingCards(store)
    expect(card?.payload.stage).toBe("maintain")
  })

  test("the model's signed-out invocation renders the step and fails honestly without parking", async () => {
    const { store, controller } = await fixture({})
    identity(store, "signed-out")
    await settled()
    const outcome = await controller.commands.runForAgent("repo.maintain")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toContain("Sign in with GitHub first")
    expect(lastMessage(store)?.action?.flow).toBe("auth.sign-in")
    expect(store.session().pendingCommand ?? null).toBeNull()
  })

  test("signed in, while the activity route answers 404 the card says so and still offers the maintainer's reads", async () => {
    const { store, controller, requests } = await fixture({})
    identity(store, "signed-in")
    await settled()
    const outcome = await controller.commands.run("repo.maintain")
    expect(outcome.status).toBe("executed")
    expect(requests).toContain(`/api/public/repos/${REPO}/activity`)
    const [card] = onboardingCards(store)
    expect(card?.payload).toEqual({
      stage: "maintain",
      repo: REPO,
      activity: null,
      reason: "Recent activity is not available yet.",
      flows: ["issues.list", "prs.list", "runs.list", "triggers.list"]
    })
  })

  test("signed in, the route's sentence rides the card", async () => {
    const { store, controller } = await fixture({
      [`/api/public/repos/${REPO}/activity`]: () =>
        json(200, { sentence: "3 commits, 1 pull request, and 2 issues in the last 7 days.", counts: { commits: 3, pullRequests: 1, issues: 2 }, since: "2026-08-31" })
    })
    identity(store, "signed-in")
    await settled()
    await controller.commands.run("repo.maintain")
    const [card] = onboardingCards(store)
    expect(card?.payload.stage === "maintain" ? card.payload.activity?.sentence : undefined)
      .toBe("3 commits, 1 pull request, and 2 issues in the last 7 days.")
  })
})

describe("repo.contribute", () => {
  test("signed out, it parks like maintain; signed in, it finds the contributing guide through the public contents route", async () => {
    const { store, controller, requests } = await fixture({
      [`/api/repos/smithersai/smithers/contents`]: () =>
        json(200, [{ name: "README.md", type: "file" }, { name: "CONTRIBUTING.md", type: "file" }, { name: "src", type: "dir" }])
    })
    identity(store, "signed-out")
    await settled()
    await controller.commands.run("repo.contribute")
    await settled()
    expect(store.session().pendingCommand?.name).toBe("repo.contribute")
    expect(lastMessage(store)?.action?.flow).toBe("auth.sign-in")

    identity(store, "signed-in")
    controller.resumeDeferredCommand()
    await settled(8)
    expect(store.session().pendingCommand ?? null).toBeNull()
    expect(requests).toContain("/api/repos/smithersai/smithers/contents")
    const [card] = onboardingCards(store)
    expect(card?.payload).toEqual({ stage: "contribute", repo: REPO, guide: "CONTRIBUTING.md" })
  })

  test("a repository without a contributing guide says so", async () => {
    const { store, controller } = await fixture({
      [`/api/repos/smithersai/smithers/contents`]: () => json(200, [{ name: "README.md", type: "file" }])
    })
    identity(store, "signed-in")
    await settled()
    await controller.commands.run("repo.contribute")
    const [card] = onboardingCards(store)
    expect(card?.payload).toEqual({ stage: "contribute", repo: REPO, guide: null, reason: "This repository has no CONTRIBUTING.md." })
  })
})

describe("repo.explore", () => {
  test("signed out, it lists the guide documents the repository holds, docs index included, and never a made-up one", async () => {
    const { store, controller, requests } = await fixture({
      [`/api/repos/smithersai/smithers/contents`]: () =>
        json(200, [
          { name: "readme.md", type: "file" },
          { name: "llms.txt", type: "file" },
          { name: "docs", type: "dir" },
          { name: "CONTRIBUTING.md", type: "dir" }
        ]),
      [`/api/repos/smithersai/smithers/contents/docs`]: () => json(200, [{ name: "index.md", type: "file" }])
    })
    identity(store, "signed-out")
    await settled()
    const outcome = await controller.commands.run("repo.explore")
    expect(outcome.status).toBe("executed")
    expect(store.session().pendingCommand ?? null).toBeNull()
    expect(requests.filter((path) => path.startsWith("/api/repos/"))).toEqual([
      "/api/repos/smithersai/smithers/contents",
      "/api/repos/smithersai/smithers/contents/docs"
    ])
    const [card] = onboardingCards(store)
    expect(card?.payload).toEqual({
      stage: "explore",
      repo: REPO,
      guides: [{ path: "readme.md" }, { path: "llms.txt" }, { path: "docs/index.md" }]
    })
  })

  test("an unreadable repository carries the honest reason and no rows", async () => {
    const { store, controller } = await fixture({
      [`/api/repos/smithersai/smithers/contents`]: () => json(502, { message: "Repository data is temporarily unavailable." })
    })
    identity(store, "signed-out")
    await settled()
    await controller.commands.run("repo.explore")
    const [card] = onboardingCards(store)
    expect(card?.payload).toEqual({ stage: "explore", repo: REPO, guides: [], reason: "Repository data is temporarily unavailable." })
  })
})

describe("feature.prototype", () => {
  test("the human's invocation starts one read-only chat turn on the request; the model's answers the brief to sketch in its own turn", async () => {
    const { store, controller, turns } = await fixture({})
    identity(store, "signed-in")
    await settled()
    // Missing input renders the form, never a usage sentence (THE FORM LAW).
    const form = await controller.commands.run("feature.prototype")
    expect(form.status).toBe("form")
    if (form.status === "form") expect(form.fields).toEqual(["request"])

    const outcome = await controller.commands.run("feature.prototype", "a dark mode toggle")
    expect(outcome.status).toBe("executed")
    await settled(8)
    const user = [...store.collections.messages.values()].find((message) => message.role === "user")
    expect(user?.text).toContain(`Sketch a feature for ${REPO}, read-only: a dark mode toggle.`)
    expect(user?.text).toContain("Do not create a workspace, a branch, or a pull request.")
    expect(turns).toHaveLength(1)

    const viaAgent = await controller.commands.runForAgent("feature.prototype", "a dark mode toggle")
    expect(viaAgent.status).toBe("executed")
    if (viaAgent.status === "executed") expect(viaAgent.value).toContain("Sketch a feature for")
    expect(turns).toHaveLength(1)
  })
})
