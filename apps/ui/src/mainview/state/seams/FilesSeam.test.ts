import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { CardSchema } from "smithers-shared/Cards"
import type { NativeAgent, NativeRepositories } from "../../native/NativeBridge"
import { createAppController } from "../AppController"
import type { AppServices } from "../AppController"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"

/*
 * The repo files seam (FilesSeam.ts) through the real command path: /files.list
 * reads GET /api/repos/{owner}/{repo}/contents[/path] and surfaces the
 * "file-list" card (entries sorted dirs-first, then by name); /files.read reads
 * the same route for a file path and surfaces the "file" card (base64 decoded,
 * capped at 16 KB, binary refused). Failures are honest strings, never throws;
 * a namespace 404 answers the /repos.import hint. The wire shapes mirror multi
 * src/files/filesClient.ts: a directory answers a JSON array of {name, path,
 * type} entries, a file answers one {path, content, encoding, size} record.
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

const base64 = (text: string): string => Buffer.from(text, "utf8").toString("base64")

/** A README with a multi-byte character: the decode must answer UTF-8, not mojibake. */
const README_TEXT = "# Flows — the runtime\n\nbun install\n"
/** Longer than the 16 KB card cap, so the card truncates honestly. */
const BIG_TEXT = "x".repeat(16 * 1024 + 100)

interface SeenRequest {
  readonly method: string
  readonly url: string
}

/*
 * The platform double: one imported repository (will/flows) answered in the
 * reference wire shape. Directory answers are DELIBERATELY unsorted and carry
 * one malformed row, so the card pins the seam's sorting and dropping. Every
 * other namespace 404s the way the platform 404s an un-imported repo.
 */
const filesBackend = () => {
  const requests: SeenRequest[] = []
  const routes: Record<string, () => Response> = {
    "/api/repos/will/flows/contents": () =>
      json(200, [
        { name: "zeta.txt", path: "zeta.txt", type: "file" },
        { name: "src", path: "src", type: "dir" },
        { name: "README.md", path: "README.md", type: "file" },
        { name: "docs", path: "docs", type: "dir" },
        { name: "broken", path: "broken", type: "symlink" },
        null
      ]),
    "/api/repos/will/flows/contents/src": () =>
      json(200, [
        { name: "lib", path: "src/lib", type: "dir" },
        // No name — the seam derives it from the path's last segment.
        { path: "src/app.ts", type: "file" }
      ]),
    "/api/repos/will/flows/contents/src/lib": () => json(200, []),
    "/api/repos/will/flows/contents/README.md": () =>
      json(200, {
        path: "README.md",
        content: base64(README_TEXT),
        encoding: "base64",
        size: README_TEXT.length
      }),
    "/api/repos/will/flows/contents/plain.txt": () =>
      json(200, { path: "plain.txt", content: "hello, plain wire\n", encoding: "", size: 18 }),
    "/api/repos/will/flows/contents/big.txt": () =>
      json(200, { path: "big.txt", content: base64(BIG_TEXT), encoding: "base64", size: BIG_TEXT.length }),
    "/api/repos/will/flows/contents/logo.png": () =>
      json(200, {
        path: "logo.png",
        content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]).toString("base64"),
        encoding: "base64",
        size: 7
      }),
    "/api/repos/will/flows/contents/raw.bin": () =>
      json(200, { path: "raw.bin", content: "PK\u0000\u0003", encoding: "", size: 4 }),
    /*
     * The shape the real platform answers for blob.bin: base64 bytes with
     * `encoding: "utf-8"` on them.
     */
    "/api/repos/will/flows/contents/mislabelled.bin": () =>
      json(200, {
        path: "mislabelled.bin",
        content: Buffer.from(
          Array.from({ length: 512 }, (_byte, index) => (index * 7 + 3) % 256)
        ).toString("base64"),
        encoding: "utf-8",
        size: 512
      }),
    "/api/repos/will/flows/contents/long.md": () =>
      json(200, {
        path: "long.md",
        content: `# Smithers\n\n${"Smithers keeps what it learns in world notes. ".repeat(40)}`,
        encoding: "utf-8",
        size: 2000
      }),
    "/api/repos/will/flows/contents/missing.txt": () => json(404, { message: "Path not found: missing.txt" }),
    "/api/repos/will/flows/contents/boom.txt": () => json(500, { message: "the platform fell over" })
  }
  const services: AppServices = {
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (!url.includes("/contents")) {
        return json(404, { status: "error", message: `no stub for ${url}` })
      }
      requests.push({ method: "GET", url })
      if (url.includes("net.txt")) throw new Error("socket hang up")
      const route = routes[url]
      if (route !== undefined) return route()
      // The platform 404s the whole namespace of a repo it never imported.
      return json(404, { code: "not_found", message: "repository not found" })
    }
  }
  return { services, requests }
}

const freshController = async () => {
  const backend = filesBackend()
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  return {
    store,
    requests: backend.requests,
    controller: createAppController(store, unavailableRepositories, unavailableAgent, backend.services)
  }
}

const ready = async (store: AppStore): Promise<void> => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "will",
    allowlisted: true,
    admin: false,
    scopesPlain: null
  })
  store.dispatch({
    type: "watched.replaced",
    actor: "system",
    selected: ["will/flows"],
    selectedAt: "2026-08-12T09:00:00.000Z",
    via: "command"
  })
  await settled()
}

const listCard = (store: AppStore, id: string) => {
  const card = store.collections.cards.get(id)
  if (card === undefined || card.kind !== "file-list") return undefined
  return card
}

const fileCard = (store: AppStore, id: string) => {
  const card = store.collections.cards.get(id)
  if (card === undefined || card.kind !== "file") return undefined
  return card
}

describe("files seam — files.list", () => {
  test("rejects dot-segment and mixed-separator traversal before any request", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    for (const path of ["../../api/admin/health", "src/../secret", String.raw`..\api\admin`, "%2e%2e/admin"]) {
      const outcome = await controller.commands.run("files.list", path)
      expect(outcome.status).toBe("failed")
    }
    expect(requests).toEqual([])
  })
  test("the bare command lists the root: entries sorted dirs-first then by name, malformed rows dropped", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.list")
    expect(outcome.status).toBe("executed")
    await settled()

    expect(requests).toEqual([{ method: "GET", url: "/api/repos/will/flows/contents" }])

    const card = listCard(store, "files-will/flows-/")
    expect(card).toBeDefined()
    expect(card?.payload.repo).toBe("will/flows")
    expect(card?.payload.path).toBe("")
    expect(card?.payload.entries).toEqual([
      { name: "docs", kind: "dir" },
      { name: "src", kind: "dir" },
      { name: "README.md", kind: "file" },
      { name: "zeta.txt", kind: "file" }
    ])
    // The payload matches the shared wire schema exactly.
    expect(CardSchema.safeParse(card).success).toBe(true)
  })

  test("a \"/\" path is the root too: the same card id, one route", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.list", "/")
    expect(outcome.status).toBe("executed")
    expect(requests[0]?.url).toBe("/api/repos/will/flows/contents")
    expect(listCard(store, "files-will/flows-/")).toBeDefined()
  })

  test("a path plus an explicit owner/repo targets that directory; names derive from paths when absent", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.list", "src will/flows")
    expect(outcome.status).toBe("executed")
    await settled()

    expect(requests[0]?.url).toBe("/api/repos/will/flows/contents/src")
    const card = listCard(store, "files-will/flows-src")
    expect(card).toBeDefined()
    expect(card?.payload.path).toBe("src")
    expect(card?.payload.entries).toEqual([
      { name: "lib", kind: "dir" },
      { name: "app.ts", kind: "file" }
    ])
    expect(CardSchema.safeParse(card).success).toBe(true)
  })

  test("an empty directory surfaces an empty-entries card, not an error", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.list", "src/lib")
    expect(outcome.status).toBe("executed")
    expect(listCard(store, "files-will/flows-src/lib")?.payload.entries).toEqual([])
  })

  test("an un-imported repository's namespace 404 answers the /repos.import hint", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.list", "src acme/ghost")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("acme/ghost isn't imported yet — run /repos.import acme/ghost first")
    }
    expect(listCard(store, "files-acme/ghost-src")).toBeUndefined()
  })
})

describe("files seam — files.read", () => {
  test("reads a base64 file into the file card, UTF-8 decoded, untruncated", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "README.md")
    expect(outcome.status).toBe("executed")
    await settled()

    expect(requests).toEqual([{ method: "GET", url: "/api/repos/will/flows/contents/README.md" }])
    const card = fileCard(store, "file-will/flows-README.md")
    expect(card).toBeDefined()
    expect(card?.payload.repo).toBe("will/flows")
    expect(card?.payload.path).toBe("README.md")
    // The em-dash proves base64 bytes went back through UTF-8, not latin1.
    expect(card?.payload.content).toBe(README_TEXT)
    expect(card?.payload.truncated).toBe(false)
    expect(CardSchema.safeParse(card).success).toBe(true)
  })

  test("a plain (non-base64) wire answer passes through as-is", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "plain.txt")
    expect(outcome.status).toBe("executed")
    expect(fileCard(store, "file-will/flows-plain.txt")?.payload.content).toBe("hello, plain wire\n")
  })

  test("a file beyond 16 KB is cut at the cap with truncated: true", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "big.txt")
    expect(outcome.status).toBe("executed")
    const card = fileCard(store, "file-will/flows-big.txt")
    expect(card?.payload.content.length).toBe(16 * 1024)
    expect(card?.payload.truncated).toBe(true)
  })

  /*
   * §8.27: the read SUCCEEDED — the file is simply not text. That is an
   * answer about the file, so it is a card, and the card states it instead of
   * printing 42 000 pixels of base64 the reader can neither use nor reach.
   */
  test("binary base64 content (NUL bytes) renders a card that says so, never the bytes", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "logo.png")
    expect(outcome.status).toBe("executed")
    const card = fileCard(store, "file-will/flows-logo.png")
    expect(card?.payload.binary).toBe(true)
    expect(card?.payload.content).toBe("")
  })

  test("binary plain content (a NUL byte in the string) is stated the same way", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "raw.bin")
    expect(outcome.status).toBe("executed")
    expect(fileCard(store, "file-will/flows-raw.bin")?.payload.binary).toBe(true)
  })

  /*
   * The platform answers `encoding: "utf-8"` for a file whose content is
   * plainly base64-encoded bytes, so the declared encoding is not trusted on
   * its own. A real text file never matches: the base64 alphabet excludes
   * every punctuation mark prose and code use.
   */
  test("base64 bytes mislabelled as utf-8 are still recognised as binary", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "mislabelled.bin")
    expect(outcome.status).toBe("executed")
    expect(fileCard(store, "file-will/flows-mislabelled.bin")?.payload.binary).toBe(true)
  })

  test("a long plain-text file is not mistaken for base64", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "long.md")
    expect(outcome.status).toBe("executed")
    const card = fileCard(store, "file-will/flows-long.md")
    expect(card?.payload.binary ?? false).toBe(false)
    expect(card?.payload.content).toContain("Smithers")
  })

  test("a missing path inside an imported repo answers the platform's path message, not the import hint", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "missing.txt")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("Path not found: missing.txt")
  })

  test("an un-imported repository's namespace 404 answers the /repos.import hint", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "README.md acme/ghost")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("acme/ghost isn't imported yet — run /repos.import acme/ghost first")
    }
  })
})

describe("files seam — honest failures", () => {
  test("a 500 answers the platform's message, never a throw", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "boom.txt")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("the platform fell over")
    expect(fileCard(store, "file-will/flows-boom.txt")).toBeUndefined()
  })

  test("a network throw answers an honest string naming the path and repo", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("files.read", "net.txt")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe(
        "Could not reach the backend to read net.txt in will/flows: socket hang up"
      )
    }
  })

  test("a watched-less signed-in session answers the repo-resolution error before any request", async () => {
    const backend = filesBackend()
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(
      store,
      unavailableRepositories,
      unavailableAgent,
      backend.services
    )
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
    const outcome = await controller.commands.run("files.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe(
        "No repository is watched yet — run /repos.watch first, or name one as owner/repo"
      )
    }
    expect(backend.requests).toHaveLength(0)
  })
})
