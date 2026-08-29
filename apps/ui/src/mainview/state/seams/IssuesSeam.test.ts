import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { NativeAgent, NativeRepositories } from "../../native/NativeBridge"
import { createAppController } from "../AppController"
import type { AppServices } from "../AppController"
import type { Card } from "../AppState"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"

/*
 * The issues seam, driven through the one command run path: issues.list /
 * issues.view / issues.close / issues.comment against stubbed platform routes.
 * Substance lands as cards ("issue-list", "issue") in store.collections.cards;
 * failures come back as honest error strings (CommandOutcome "failed"), never
 * throws. One watched repository ("will/flows") stands in for the repo
 * resolution, matching the RepoContext single-watched rule.
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

type RouteAnswer = Response | ((request: Request) => Response | Promise<Response>)

/**
 * Route stub keyed "METHOD /path" (pathname only — the query is recorded in
 * `calls` so tests can assert it). Unstubbed routes answer 404 honestly.
 */
const backend = (routes: Record<string, RouteAnswer>, calls: string[] = []): AppServices => ({
  fetchImpl: async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const absolute = new URL(url, "https://app.test")
    const method = (init?.method ?? "GET").toUpperCase()
    calls.push(`${method} ${absolute.pathname}${absolute.search}`)
    for (const [route, answer] of Object.entries(routes)) {
      const spaceIndex = route.indexOf(" ")
      const routeMethod = route.slice(0, spaceIndex)
      const routePath = route.slice(spaceIndex + 1)
      if (routeMethod !== method || absolute.pathname !== routePath) continue
      return typeof answer === "function"
        ? answer(new Request(absolute.toString(), init))
        : answer.clone()
    }
    return json(404, { status: "error", message: `no stub for ${method} ${absolute.pathname}` })
  }
})

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

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

/** ONE watched repo, so repo resolution answers "will/flows" without an argument. */
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

const issuesController = async (services: AppServices) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableRepositories, unavailableAgent, services)
  await signedIn(store)
  await reposChosen(store)
  return { store, controller }
}

/* Plue's issue wire shape (multi src/smithersCloud/issues.ts). */
const wireIssue = (number: number, overrides: Record<string, unknown> = {}) => ({
  id: number * 100,
  number,
  title: `Fix the flake ${number}`,
  body: "It **flakes** on CI.",
  state: "open",
  labels: [{ id: 1, name: "bug", color: "d73a4a", description: "" }],
  assignees: [],
  author: { id: 3, login: "ana" },
  milestone_id: null,
  comment_count: 2,
  created_at: "2026-08-10T09:00:00Z",
  updated_at: "2026-08-11T09:00:00Z",
  closed_at: null,
  ...overrides
})

/* GitHub's issue wire shape off the source read (multi src/smithersCloud/githubIssues.ts). */
const wireGithubIssue = (number: number, overrides: Record<string, unknown> = {}) => ({
  id: number * 1000,
  number,
  title: `Upstream bug ${number}`,
  body: "Seen on main.",
  state: "open",
  user: { login: "octo", avatar_url: "https://avatars.test/octo" },
  labels: [{ name: "bug", color: "d73a4a" }],
  assignees: [],
  comments: 4,
  html_url: `https://github.com/will/flows/issues/${number}`,
  created_at: "2026-08-09T09:00:00Z",
  updated_at: "2026-08-10T09:00:00Z",
  ...overrides
})

/* Plue's IssueCommentResponse wire shape (multi src/smithersCloud/issueComments.ts). */
const wireComment = (id: number, body: string) => ({
  id,
  issue_id: 7,
  user_id: 4,
  commenter: "bob",
  body,
  type: "comment",
  created_at: "2026-08-11T10:00:00Z",
  updated_at: "2026-08-11T10:00:00Z"
})

const cardOfKind = <K extends Card["kind"]>(
  store: AppStore,
  id: string,
  kind: K
): Extract<Card, { kind: K }> => {
  const card: Card | undefined = store.collections.cards.get(id)
  if (card === undefined || card.kind !== kind) {
    throw new Error(`Expected card ${id} of kind ${kind}, got ${card?.kind ?? "nothing"}`)
  }
  return card as Extract<Card, { kind: K }>
}

describe("issues seam — the list", () => {
  test("rejects malformed top-level lists instead of reporting an empty success", async () => {
    for (const body of [{}, "not a list", null]) {
      const { store, controller } = await issuesController(
        backend({ "GET /api/repos/will/flows/issues": json(200, body) })
      )
      const outcome = await controller.commands.run("issues.list")
      expect(outcome.status).toBe("failed")
      expect(store.collections.cards.get("issues-will/flows")).toBeUndefined()
    }
  })
  test("issues.list upserts the issue-list card with defensively parsed rows and asks state=open", async () => {
    const calls: string[] = []
    const { store, controller } = await issuesController(
      backend(
        {
          "GET /api/repos/will/flows/issues": json(200, [
            wireIssue(7),
            "junk",
            { title: "no number at all" },
            wireIssue(9, { state: "closed", author: null, comment_count: "not-a-number", updated_at: null })
          ])
        },
        calls
      )
    )
    const outcome = await controller.commands.run("issues.list")
    expect(outcome.status).toBe("executed")
    await settled()
    const card = cardOfKind(store, "issues-will/flows", "issue-list")
    expect(card.title).toBe("Issues · will/flows")
    expect(card.status).toBe("active")
    expect(card.payload.repo).toBe("will/flows")
    expect(card.payload.filter).toBe("open")
    // The two real rows survive; garbage entries drop; missing fields go null/zero.
    expect(card.payload.issues).toEqual([
      {
        number: 7,
        title: "Fix the flake 7",
        state: "open",
        author: "ana",
        comments: 2,
        updatedAt: "2026-08-11T09:00:00Z"
      },
      {
        number: 9,
        title: "Fix the flake 9",
        state: "closed",
        author: null,
        comments: 0,
        updatedAt: null
      }
    ])
    expect(calls).toContain("GET /api/repos/will/flows/issues?state=open")
  })

  test("issues.list all omits the state param — Plue rejects state=all", async () => {
    const calls: string[] = []
    const { store, controller } = await issuesController(
      backend({ "GET /api/repos/will/flows/issues": json(200, []) }, calls)
    )
    const outcome = await controller.commands.run("issues.list", "all")
    expect(outcome.status).toBe("executed")
    await settled()
    const card = cardOfKind(store, "issues-will/flows", "issue-list")
    expect(card.payload.filter).toBe("all")
    expect(card.payload.issues).toEqual([])
    expect(calls).toContain("GET /api/repos/will/flows/issues")
    expect(calls.some((call) => call.includes("state=all"))).toBe(false)
  })
})

describe("issues seam — the detail", () => {
  test("issues.view fetches the issue AND its comments and upserts the detail card", async () => {
    const { store, controller } = await issuesController(
      backend({
        "GET /api/repos/will/flows/issues/7": json(200, wireIssue(7)),
        "GET /api/repos/will/flows/issues/7/comments": json(200, [
          wireComment(1, "First!"),
          "junk"
        ])
      })
    )
    const outcome = await controller.commands.run("issues.view", "7")
    expect(outcome.status).toBe("executed")
    await settled()
    const card = cardOfKind(store, "issue-will/flows-7", "issue")
    expect(card.payload).toEqual({
      repo: "will/flows",
      number: 7,
      title: "Fix the flake 7",
      state: "open",
      author: "ana",
      issueBody: "It **flakes** on CI.",
      labels: ["bug"],
      comments: [{ author: "bob", commentBody: "First!", createdAt: "2026-08-11T10:00:00Z" }]
    })
  })
})

describe("issues seam — mutations re-fetch so the card states the new truth", () => {
  test("issues.close PATCHes {state:'closed'} then upserts the re-fetched closed card", async () => {
    let patched: unknown
    const { store, controller } = await issuesController(
      backend({
        "PATCH /api/repos/will/flows/issues/7": async (request) => {
          patched = await request.json()
          return json(200, wireIssue(7, { state: "closed", closed_at: "2026-08-12T09:30:00Z" }))
        },
        "GET /api/repos/will/flows/issues/7": json(
          200,
          wireIssue(7, { state: "closed", closed_at: "2026-08-12T09:30:00Z" })
        ),
        "GET /api/repos/will/flows/issues/7/comments": json(200, [])
      })
    )
    const outcome = await controller.commands.run("issues.close", "7")
    expect(outcome.status).toBe("executed")
    expect(patched).toEqual({ state: "closed" })
    await settled()
    const card = cardOfKind(store, "issue-will/flows-7", "issue")
    expect(card.payload.state).toBe("closed")
    expect(card.payload.comments).toEqual([])
  })

  test("issues.comment POSTs {body} then upserts the card carrying the new comment", async () => {
    let posted: unknown
    const { store, controller } = await issuesController(
      backend({
        "POST /api/repos/will/flows/issues/7/comments": async (request) => {
          posted = await request.json()
          return json(201, wireComment(2, "hello"))
        },
        "GET /api/repos/will/flows/issues/7": json(200, wireIssue(7, { comment_count: 3 })),
        "GET /api/repos/will/flows/issues/7/comments": json(200, [
          wireComment(1, "First!"),
          wireComment(2, "hello")
        ])
      })
    )
    const outcome = await controller.commands.run("issues.comment", "7 hello")
    expect(outcome.status).toBe("executed")
    expect(posted).toEqual({ body: "hello" })
    await settled()
    const card = cardOfKind(store, "issue-will/flows-7", "issue")
    expect(card.payload.comments.map((comment) => comment.commentBody)).toEqual([
      "First!",
      "hello"
    ])
  })
})

describe("issues seam — honest failures, never throws", () => {
  test("a 500 answers the backend's message as a failed outcome and upserts no card", async () => {
    const { store, controller } = await issuesController(
      backend({
        "GET /api/repos/will/flows/issues": json(500, { message: "the platform exploded" })
      })
    )
    const outcome = await controller.commands.run("issues.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("the platform exploded")
    await settled()
    expect(store.collections.cards.get("issues-will/flows")).toBeUndefined()
  })

  test("a network throw answers an honest string and upserts no card", async () => {
    // Only the issues routes throw; everything else 404s so startup seams stay honest.
    const throwingBackend: AppServices = {
      fetchImpl: async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        const path = new URL(url, "https://app.test").pathname
        if (path.startsWith("/api/repos/")) throw new TypeError("socket hangup")
        return json(404, { status: "error", message: `no stub for ${path}` })
      }
    }
    const { store, controller } = await issuesController(throwingBackend)
    const outcome = await controller.commands.run("issues.view", "7")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toContain("Could not reach the backend")
      expect(outcome.error).toContain("socket hangup")
    }
    await settled()
    expect(store.collections.cards.get("issue-will/flows-7")).toBeUndefined()
  })

  test("with several watched repositories and no argument, the answer is the honest choice", async () => {
    const { store, controller } = await issuesController(backend({}))
    store.dispatch({
      type: "watched.replaced",
      actor: "system",
      selected: ["will/flows", "will/smithers"],
      selectedAt: "2026-08-12T09:05:00.000Z",
      via: "command"
    })
    await settled()
    const outcome = await controller.commands.run("issues.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toContain("Several repositories are watched")
    }
    expect(store.collections.cards.get("issues-will/flows")).toBeUndefined()
  })
})

/*
 * IMPORT-READINESS degradation (multi importReadiness.ts + githubIssues.ts):
 * the imported namespace 404s for a source-only repo, so the list falls back
 * to the GET-only GitHub-source read; detail and mutations answer honest
 * strings pointing at /repos.import and never touch the source namespace.
 */
describe("issues seam — source-only fallback (repo not imported)", () => {
  test("issues.list on an imported-namespace 404 reads the GitHub source and marks the card", async () => {
    const calls: string[] = []
    const { store, controller } = await issuesController(
      backend(
        {
          "GET /api/repos/will/flows/issues": json(404, { message: "repository not found" }),
          "GET /api/user/github-repos/will/flows/issues": json(200, [
            wireGithubIssue(12),
            // GitHub's issues endpoint includes pull requests — the row drops.
            wireGithubIssue(99, { pull_request: { url: "https://api.github.test/pulls/99" } }),
            "junk",
            wireGithubIssue(15, {
              state: "closed",
              user: null,
              comments: "not-a-number",
              updated_at: null
            })
          ])
        },
        calls
      )
    )
    const outcome = await controller.commands.run("issues.list")
    expect(outcome.status).toBe("executed")
    await settled()
    const card = cardOfKind(store, "issues-will/flows", "issue-list")
    expect(card.title).toBe("Issues · will/flows")
    expect(card.body).toBe("Read from GitHub — import for full features: /repos.import will/flows")
    expect(card.payload.repo).toBe("will/flows")
    expect(card.payload.filter).toBe("open")
    // GitHub spellings land in the same rows: user.login → author, comments → comments.
    expect(card.payload.issues).toEqual([
      {
        number: 12,
        title: "Upstream bug 12",
        state: "open",
        author: "octo",
        comments: 4,
        updatedAt: "2026-08-10T09:00:00Z"
      },
      {
        number: 15,
        title: "Upstream bug 15",
        state: "closed",
        author: null,
        comments: 0,
        updatedAt: null
      }
    ])
    expect(calls).toContain("GET /api/repos/will/flows/issues?state=open")
    expect(calls).toContain("GET /api/user/github-repos/will/flows/issues?state=open")
  })

  test("issues.list all asks the GitHub source with state=all — only Plue rejects state=all", async () => {
    const calls: string[] = []
    const { store, controller } = await issuesController(
      backend(
        {
          "GET /api/repos/will/flows/issues": json(404, { message: "repository not found" }),
          "GET /api/user/github-repos/will/flows/issues": json(200, [wireGithubIssue(3)])
        },
        calls
      )
    )
    const outcome = await controller.commands.run("issues.list", "all")
    expect(outcome.status).toBe("executed")
    await settled()
    const card = cardOfKind(store, "issues-will/flows", "issue-list")
    expect(card.payload.filter).toBe("all")
    expect(card.payload.issues.map((issue) => issue.number)).toEqual([3])
    expect(calls).toContain("GET /api/user/github-repos/will/flows/issues?state=all")
  })

  test("the GitHub source failing too answers the honest error and upserts no card", async () => {
    const { store, controller } = await issuesController(
      backend({
        "GET /api/repos/will/flows/issues": json(404, { message: "repository not found" }),
        "GET /api/user/github-repos/will/flows/issues": json(404, {
          message: "GitHub answered 404 for will/flows"
        })
      })
    )
    const outcome = await controller.commands.run("issues.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("GitHub answered 404 for will/flows")
    }
    await settled()
    expect(store.collections.cards.get("issues-will/flows")).toBeUndefined()
  })

  test("issues.view on a 404 states that detail needs the import — no per-issue source read exists", async () => {
    const calls: string[] = []
    const { store, controller } = await issuesController(
      backend({ "GET /api/repos/will/flows/issues/7": json(404, { message: "not found" }) }, calls)
    )
    const outcome = await controller.commands.run("issues.view", "7")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toContain("Issue #7 in will/flows answered 404")
      expect(outcome.error).toContain("run /repos.import will/flows")
    }
    expect(calls.some((call) => call.includes("/api/user/github-repos/"))).toBe(false)
    expect(store.collections.cards.get("issue-will/flows-7")).toBeUndefined()
  })

  test("mutations on a 404 answer the repos.import error and never write to the source", async () => {
    const calls: string[] = []
    // Nothing stubbed: every imported-namespace mutation answers the honest 404.
    const { store, controller } = await issuesController(backend({}, calls))
    const mutations: ReadonlyArray<readonly [string, string]> = [
      ["issues.create", "A brand new idea"],
      ["issues.close", "7"],
      ["issues.reopen", "7"],
      ["issues.comment", "7 hello there"]
    ]
    for (const [command, args] of mutations) {
      const outcome = await controller.commands.run(command, args)
      expect(outcome.status).toBe("failed")
      if (outcome.status === "failed") {
        expect(outcome.error).toBe("will/flows isn't imported yet — run /repos.import will/flows first")
      }
    }
    // Zero fallback traffic: the GET-only source namespace was never touched.
    expect(calls.some((call) => call.includes("/api/user/github-repos/"))).toBe(false)
    await settled()
    expect(store.collections.cards.get("issue-will/flows-7")).toBeUndefined()
  })
})
