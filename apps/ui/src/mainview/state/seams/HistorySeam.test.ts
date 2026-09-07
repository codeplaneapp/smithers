import type { StorageApi } from "@tanstack/db"
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import type { NativeAgent, NativeRepositories } from "../../native/NativeBridge"
import { createAppController } from "../AppController"
import type { AppServices } from "../AppController"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { emptyHistorySentence, MAX_CHANGE_PAGES, parseNote } from "./HistorySeam"

// The first controller in a file pays the module warm-up; under machine load that alone passes 5 s.
setDefaultTimeout(30_000)

/*
 * The history seam through the real command path: controller.commands.run
 * drives history.show exactly as the chrome button and the slash do, the
 * stubbed mirror answers the wire shapes probed on smithers.sh on 2026-09-07
 * (git/refs, the change feed, /contents against a commit, git/commits 501),
 * and the "history" card states only what the mirror answered.
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

type Route = Response | ((request: Request) => Response | Promise<Response>)

const backend = (routes: Record<string, Route>, seen: Array<string> = []): AppServices => ({
  fetchImpl: async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const absolute = new URL(url, "https://app.test")
    const path = absolute.pathname + absolute.search
    seen.push(path)
    for (const [route, answer] of Object.entries(routes)) {
      if (path === route || path.startsWith(`${route}?`)) {
        return typeof answer === "function" ? answer(new Request(absolute.toString(), init)) : answer.clone()
      }
    }
    return json(404, { status: "error", message: `no stub for ${path}` })
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

const reposChosen = async (store: AppStore): Promise<void> => {
  store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: [{ id: "will/flows", org: "will", ownerKind: "user", name: "flows", head: null }]
  })
  await settled()
}

/** A controller watching exactly will/flows over the given mirror, signed out unless asked. */
const ready = async (services: AppServices, options: { signedIn?: boolean } = {}) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableRepositories, unavailableAgent, services)
  if (options.signedIn === true) await signedIn(store)
  await reposChosen(store)
  return { store, controller }
}

/* ---- the mirror's wire shapes ---- */

const REPO = "/api/repos/will/flows"

const ref = (name: string, sha: string) => ({ ref: name, object: { sha, type: "commit" } })

/** One change-feed row; parents are change ids in git parent order, the first is the first parent. */
const change = (changeId: string, commitId: string, description: string, parents: ReadonlyArray<string>) => ({
  change_id: changeId,
  commit_id: commitId,
  description,
  author_name: "will",
  author_email: "will@example.test",
  timestamp: "2026-09-07T00:00:00Z",
  has_conflict: false,
  is_empty: false,
  parent_change_ids: parents
})

/** The feed paginated newest first: `cursor` is the offset, `next_cursor` empty on the last page. */
const feed = (items: ReadonlyArray<unknown>, pageSize: number): Route => (request) => {
  const offset = Number(new URL(request.url).searchParams.get("cursor") ?? "0")
  const page = items.slice(offset, offset + pageSize)
  const next = offset + pageSize < items.length ? String(offset + pageSize) : ""
  return json(200, { items: page, next_cursor: next })
}

const notImplemented = (): Response => json(501, { status: "error", message: "not implemented" })

const historyCard = (store: AppStore) => {
  const card = store.collections.cards.get("history-will/flows")
  if (card === undefined || card.kind !== "history") throw new Error("expected the history card")
  return card
}

/* The main line M3 -> M2 -> M1, plus X off M1 on another bookmark: main has 3 commits, the feed 4. */
const MAIN_ONLY = [
  change("c-m3", "aaa3000000000000000000000000000000000003", "third\n\nbody", ["c-m2"]),
  change("c-x", "ffffff00000000000000000000000000000000ff", "side branch", ["c-m1"]),
  change("c-m2", "aaa2000000000000000000000000000000000002", "second", ["c-m1"]),
  change("c-m1", "aaa1000000000000000000000000000000000001", "first", [])
]

describe("history seam: the empty state", () => {
  test("no mythical bookmark: the card states the default bookmark's commit count from the change feed, walked across pages, signed out", async () => {
    const seen: Array<string> = []
    const { store, controller } = await ready(
      backend({
        [REPO]: json(200, { full_name: "will/flows", default_bookmark: "main" }),
        [`${REPO}/git/refs`]: json(200, [ref("refs/heads/main", "aaa3000000000000000000000000000000000003"), ref("refs/heads/side", "ffffff00000000000000000000000000000000ff")]),
        [`${REPO}/changes`]: feed(MAIN_ONLY, 2)
      }, seen)
    )
    const outcome = await controller.commands.run("history.show")
    expect(outcome.status).toBe("executed")
    await settled()
    const card = historyCard(store)
    expect(card.title).toBe("Mythical history · will/flows")
    expect(card.payload).toEqual({ repo: "will/flows", defaultBookmark: "main", mainCommits: 3, mythical: { state: "absent" } })
    expect(emptyHistorySentence(card.payload.defaultBookmark, card.payload.mainCommits)).toBe("No mythical history yet. main has 3 commits.")
    // Both feed pages were read: the root sits on the second one.
    expect(seen.filter((path) => path.startsWith(`${REPO}/changes`))).toEqual([`${REPO}/changes?limit=100`, `${REPO}/changes?limit=100&cursor=2`])
  })

  test("a feed the walk cannot finish within the page bound answers a null count, never a partial one", async () => {
    const pages: Array<string> = []
    const { store, controller } = await ready(
      backend({
        [REPO]: json(200, { default_bookmark: "main" }),
        [`${REPO}/git/refs`]: json(200, [ref("refs/heads/main", "aaa3000000000000000000000000000000000003")]),
        // Every page names a parent the next page never delivers.
        [`${REPO}/changes`]: (request) => {
          const cursor = new URL(request.url).searchParams.get("cursor") ?? ""
          pages.push(cursor)
          const n = pages.length
          return json(200, {
            items: [change(`c-${n}`, n === 1 ? "aaa3000000000000000000000000000000000003" : `sha-${n}`, `commit ${n}`, [`c-${n + 1}`])],
            next_cursor: String(n * 100)
          })
        }
      })
    )
    expect((await controller.commands.run("history.show")).status).toBe("executed")
    await settled()
    expect(pages.length).toBe(MAX_CHANGE_PAGES)
    const card = historyCard(store)
    expect(card.payload.mainCommits).toBeNull()
    expect(emptyHistorySentence(card.payload.defaultBookmark, card.payload.mainCommits)).toBe(
      "No mythical history yet. The commit count of main is not available."
    )
  })

  test("the write doors are registered and signed-in, and refuse with the empty state's own sentence", async () => {
    const { controller } = await ready(
      backend({
        [REPO]: json(200, { default_bookmark: "main" }),
        [`${REPO}/git/refs`]: json(200, [ref("refs/heads/main", "aaa3000000000000000000000000000000000003")]),
        [`${REPO}/changes`]: feed(MAIN_ONLY, 100)
      }),
      { signedIn: true }
    )
    for (const door of ["history.bootstrap", "history.amend", "history.fold"]) {
      const outcome = await controller.commands.run(door)
      expect(outcome.status).toBe("failed")
      if (outcome.status === "failed") expect(outcome.error).toBe("No mythical history yet. main has 3 commits.")
    }
    // Signed out, the doors defer behind sign-in instead of running.
    const anonymous = await ready(backend({}))
    const deferred = await anonymous.controller.commands.run("history.bootstrap")
    expect(deferred.status).not.toBe("executed")
  })
})

/*
 * The mythical history E2 -> E1 -> R on the first-parent line. E1 merges a1
 * (an epic of one commit); E2 merges b2 -> b1 (an epic of two). main's head M
 * sits on its own line. Notes exist for b2 only.
 */
const R = "0000000000000000000000000000000000000000"
const A1 = "a100000000000000000000000000000000000001"
const E1 = "e100000000000000000000000000000000000001"
const B1 = "b100000000000000000000000000000000000001"
const B2 = "b200000000000000000000000000000000000002"
const E2 = "e200000000000000000000000000000000000002"
const M = "3333333333333333333333333333333333333333"
const NOTES = "9999999999999999999999999999999999999999"

const MYTHICAL = [
  change("c-e2", E2, "02 · Targets are declared in PACKAGE.ts", ["c-e1", "c-b2"]),
  change("c-m", M, "🔧 ci: something on main", ["c-r"]),
  change("c-b2", B2, "feat(targets): declare targets", ["c-b1"]),
  change("c-b1", B1, "docs(targets): what a target is", ["c-e1"]),
  change("c-e1", E1, "01 · The workspace declares its toolchain", ["c-r", "c-a1"]),
  change("c-a1", A1, "feat(workspace): WORKSPACE.ts", ["c-r"]),
  change("c-r", R, "root", [])
]

const NOTE_B2 = [
  "---",
  "commit: b2",
  "---",
  "",
  "## Tried",
  "A single PACKAGE.json (run r-1): lost type checking.",
  "",
  "## Evidence",
  "//packages/targets:test green at 4b1c.",
  "",
  "## folded",
  "9a0f2e1, c31d7a4",
  ""
].join("\n")

const mythicalMirror = (options: { tree?: (sha: string) => Response; notes?: boolean } = {}): AppServices =>
  backend({
    [REPO]: json(200, { default_bookmark: "main" }),
    [`${REPO}/git/refs`]: json(200, [
      ref("refs/heads/main", M),
      ref("refs/heads/mythical", E2),
      ...(options.notes === true ? [ref("refs/notes/mythical", NOTES)] : [])
    ]),
    [`${REPO}/changes`]: feed(MYTHICAL, 3),
    [`${REPO}/git/commits/${E2}`]: options.tree === undefined ? notImplemented() : options.tree(E2),
    [`${REPO}/git/commits/${M}`]: options.tree === undefined ? notImplemented() : options.tree(M),
    // git notes: flat `<sha>` in the notes commit's tree, read through /contents against that commit.
    [`${REPO}/contents/${B2}`]: (request) =>
      new URL(request.url).searchParams.get("ref") === NOTES
        ? json(200, { name: B2, path: B2, type: "file", encoding: "utf-8", content: NOTE_B2 })
        : json(404, { status: "error", message: "content not found" })
  })

describe("history seam: the mythical history", () => {
  test("first-parent rows are epics, each merge's second-parent chain is its atomic commits, and the badge is unsupported while git/commits answers 501", async () => {
    const { store, controller } = await ready(mythicalMirror())
    expect((await controller.commands.run("history.show")).status).toBe("executed")
    await settled()
    const { payload } = historyCard(store)
    expect(payload.mainCommits).toBe(2)
    if (payload.mythical.state !== "present") throw new Error("expected the mythical history")
    expect(payload.mythical.head).toBe(E2)
    expect(payload.mythical.mainHead).toBe(M)
    expect(payload.mythical.treeEqual).toBe("unsupported")
    expect(payload.mythical.notes).toBe("absent")
    expect(payload.mythical.commitCount).toBe(6)
    expect(payload.mythical.epics.map((epic) => [epic.title, epic.merge, epic.commits.map((commit) => commit.title)])).toEqual([
      ["02 · Targets are declared in PACKAGE.ts", true, ["feat(targets): declare targets", "docs(targets): what a target is"]],
      ["01 · The workspace declares its toolchain", true, ["feat(workspace): WORKSPACE.ts"]],
      ["root", false, []]
    ])
    expect(payload.mythical.epics.flatMap((epic) => [epic.note, ...epic.commits.map((commit) => commit.note)]).every((note) => note === null)).toBe(true)
  })

  test("the badge compares the two heads' tree shas when the mirror serves git commits", async () => {
    const equal = await ready(mythicalMirror({ tree: () => json(200, { tree: { sha: "7777777777777777777777777777777777777777" } }) }))
    expect((await equal.controller.commands.run("history.show")).status).toBe("executed")
    await settled()
    const same = historyCard(equal.store).payload.mythical
    expect(same.state === "present" ? same.treeEqual : same).toBe("equal")

    const differ = await ready(mythicalMirror({ tree: (sha) => json(200, { tree: { sha: `tree-of-${sha}` } }) }))
    expect((await differ.controller.commands.run("history.show")).status).toBe("executed")
    await settled()
    const different = historyCard(differ.store).payload.mythical
    expect(different.state === "present" ? different.treeEqual : different).toBe("different")
  })

  test("notes under refs/notes/mythical are read per commit through /contents and parsed into the four sections", async () => {
    const { store, controller } = await ready(mythicalMirror({ notes: true }))
    expect((await controller.commands.run("history.show")).status).toBe("executed")
    await settled()
    const { mythical } = historyCard(store).payload
    if (mythical.state !== "present") throw new Error("expected the mythical history")
    expect(mythical.notes).toBe("read")
    const b2 = mythical.epics[0]!.commits.find((commit) => commit.sha === B2)
    expect(b2?.note).toEqual({
      tried: "A single PACKAGE.json (run r-1): lost type checking.",
      evidence: "//packages/targets:test green at 4b1c.",
      folded: "9a0f2e1, c31d7a4",
      superseded: null
    })
    expect(mythical.epics[0]!.note).toBeNull()
    expect(mythical.epics[0]!.commits.find((commit) => commit.sha === B1)?.note).toBeNull()
  })

  test("a write door on a present history refuses by name until the retell flow exists", async () => {
    const { controller } = await ready(mythicalMirror(), { signedIn: true })
    const outcome = await controller.commands.run("history.fold")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("The mythical history of will/flows cannot be rewritten from here yet: the retell flow does not exist.")
    }
  })

  test("a mirror that lists no refs is an honest error, not an empty card", async () => {
    const { store, controller } = await ready(backend({ [REPO]: json(200, { default_bookmark: "main" }) }))
    const outcome = await controller.commands.run("history.show")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("The history of will/flows couldn't be read: the mirror did not list its refs.")
    expect(store.collections.cards.get("history-will/flows")).toBeUndefined()
  })
})

describe("parseNote", () => {
  test("strips frontmatter, accepts any heading level and case, and answers null for a missing section", () => {
    expect(parseNote("---\na: 1\n---\nintro\n# TRIED\nx\n\n### Superseded\nby y\n")).toEqual({
      tried: "x",
      evidence: null,
      folded: null,
      superseded: "by y"
    })
  })

  test("a heading outside the four sections ends the current one", () => {
    expect(parseNote("## evidence\nproof\n## Other\nignored\n## folded\nabc").evidence).toBe("proof")
    expect(parseNote("## evidence\nproof\n## Other\nignored\n## folded\nabc").folded).toBe("abc")
  })
})
