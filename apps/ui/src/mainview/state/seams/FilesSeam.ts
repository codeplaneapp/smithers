/*
 * The repo files seam: GET /api/repos/{owner}/{repo}/contents[/path] lists a
 * directory ("file-list" card) or reads a file ("file" card, capped). A
 * repository open in the LOCAL app is read through its own route instead
 * (localTarget, POST /api/repo/files) and renders the same two cards. The
 * agent shares these commands, so reads must stay bounded. Reference: multi
 * src/files/filesClient.ts — buildContentsPath (:61, per-segment encoding via
 * encodeRepoPath :53), the directory answer is a JSON array of {name, path,
 * type: "file"|"dir"} entries (fetchDir :202, parseEntry :84), and the file
 * answer is one {path, content, encoding, size} record whose content is
 * base64 when encoding === "base64" (fetchFile :215, parseFile :122,
 * decodeContent :117). Parsing is defensive: unknown JSON in, typed card
 * payload out, malformed rows drop; failures are honest strings, never throws.
 */
import { REPO_FILES_PATH, RepoFilesResponseSchema } from "smithers-shared/LocalApp"
import type { Repo, RepoFilesResponse } from "smithers-shared/LocalApp"
import type { Card } from "../AppState"
import type { AppStore } from "../AppStore"
import { resolveOpenRepo, resolveTargetRepo } from "../RepoContext"
import { readErrorMessage } from "./SeamContext"
import type { SeamContext } from "./SeamContext"

/*
 * Both commands answer a `value` beside the card: the card is what the human
 * sees, the value is what the MODEL reads. 2026-09-01: asked "what does the
 * README say?", the model called files.read, got back only "executed
 * /files.read", and wrote a README that does not exist — the card it had
 * just rendered never reaches its context. A read the model cannot read is
 * a confabulation waiting to happen.
 */
export interface FilesSeam {
  readonly listFiles: (path: string, repo?: string) => Promise<string | void | { readonly value: string }>
  readonly readFile: (path: string, repo?: string) => Promise<string | void | { readonly value: string }>
}

/** The model's copy of a listing stops here (a node_modules has thousands of entries); the card keeps them all. */
const LISTING_VALUE_CAP = 400

/** The model's copy of a directory listing: one entry per line, directories marked, bounded. */
const listingValue = (repo: string, path: string, entries: ReadonlyArray<{ name: string; kind: "file" | "dir" }>): string => {
  if (entries.length === 0) return `${path || "/"} in ${repo} is empty.`
  const shown = entries.slice(0, LISTING_VALUE_CAP).map((entry) => (entry.kind === "dir" ? `${entry.name}/` : entry.name))
  const rest = entries.length - shown.length
  return `${path || "/"} in ${repo}:\n${shown.join("\n")}${rest > 0 ? `\n… and ${rest} more (the card lists them all)` : ""}`
}

/** The model's copy of a file: the same bounded text the card shows, with truncation and binary stated. */
const fileValue = (
  repo: string,
  path: string,
  payload: { readonly content: string; readonly truncated: boolean; readonly binary?: boolean }
): string =>
  payload.binary === true
    ? `${path} in ${repo} is a binary file; its bytes are not shown.`
    : `${path} in ${repo}${payload.truncated ? " (truncated at the card cap; the rest stays in the repository)" : ""}:\n${payload.content}`

type FileListPayload = Extract<Card, { kind: "file-list" }>["payload"]
type FileListEntry = FileListPayload["entries"][number]

/** The card cap (characters): a transcript card states a file, it is not an editor. */
const CARD_CONTENT_CAP = 16 * 1024

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** "" and "/" (and any slash dressing) normalize to the root: the empty path. */
const normalizePath = (path: string): string => path.trim().replace(/^\/+/, "").replace(/\/+$/, "")

const unsafePath = (path: string): boolean => {
  const slashNormalized = path.replace(/\\/g, "/")
  return slashNormalized.split("/").some((segment) => {
    let decoded = segment
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return true
    }
    return decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")
  })
}

/** Per-segment encoding, mirroring multi filesClient.ts encodeRepoPath (:53). */
const encodeRepoPath = (path: string): string => path.split("/").filter(Boolean).map(encodeURIComponent).join("/")

/** The last path segment, for wire entries that answer a path but no name. */
const fileName = (path: string): string => {
  const parts = path.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** One directory row off the wire {name?, path?, type} shape; malformed rows drop. */
const parseEntry = (value: unknown): FileListEntry | null => {
  if (!isRecord(value)) return null
  if (value.type !== "file" && value.type !== "dir") return null
  const name = typeof value.name === "string" && value.name !== ""
    ? value.name
    : typeof value.path === "string" && value.path !== ""
    ? fileName(value.path)
    : null
  if (name === null) return null
  return { name, kind: value.type }
}

/** Directories first, then names in locale order — the multi sort (filesClient.ts :94). */
const sortEntries = (entries: ReadonlyArray<FileListEntry>): FileListEntry[] =>
  [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1
    return a.name.localeCompare(b.name)
  })

/** A body that is nothing but base64 alphabet, long enough not to be a word. */
const LOOKS_BASE64 = /^[A-Za-z0-9+/=\s]{256,}$/

/**
 * Base64 → UTF-8, honest about binary: NUL bytes or an undecodable byte
 * sequence answer `binary` instead of mojibake (multi decodeBase64 :101, made
 * strict — the card refuses binary rather than rendering replacement chars).
 */
const decodeBase64 = (value: string): { readonly text: string; readonly binary: boolean } => {
  try {
    const raw = atob(value.replace(/\s+/g, ""))
    const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0))
    if (bytes.includes(0)) return { text: "", binary: true }
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), binary: false }
  } catch {
    return { text: "", binary: true }
  }
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * The open LOCAL repository a files command means, if any (LOCAL-APP.md): an
 * explicit token that matches an open repository's name (`owner/repo` off its
 * remote, or its folder name), its folder name, or its path; with no token,
 * the repository a bare command means (resolveOpenRepo: the active one, as
 * the chrome shows it). A token that matches nothing open, or a bare call
 * with nothing open, is undefined: the Cloud rule applies, so a Cloud read
 * is still one name away.
 */
const localTarget = (
  store: AppStore,
  explicit: string | undefined
): { readonly repo: Repo } | { readonly error: string } | undefined => {
  const repos = [...store.collections.repos.values()]
  if (explicit !== undefined && explicit !== "") {
    const named = repos.find((repo) =>
      repo.name === explicit || repo.path === explicit || repo.path.split("/").pop() === explicit
    )
    return named === undefined ? undefined : { repo: named }
  }
  if (repos.length === 0) return undefined
  const open = resolveOpenRepo(store)
  return "repo" in open ? { repo: open.repo } : { error: open.error }
}

export const createFilesSeam = (ctx: SeamContext): FilesSeam => {
  const contentsUrl = (repo: string, path: string): string => {
    const [owner = "", name = ""] = repo.split("/")
    const base = `${ctx.baseUrl}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents`
    return path === "" ? base : `${base}/${encodeRepoPath(path)}`
  }

  const upsert = (card: Card): void => {
    ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card })
  }

  /*
   * The 404 split: the platform answers a missing PATH inside an imported
   * repo with "Path not found: {path}" (multi filesClient.test.ts :93); a
   * repository the platform has never imported 404s the whole namespace
   * (code "not_found", "repository not found" — or no useful body at all).
   * A 404 whose message names the path is the honest path answer; any other
   * 404 means the repo itself is unknown, and the fix is the import.
   */
  const explain404 = async (response: Response, repo: string, fallback: string): Promise<string> => {
    const message = await readErrorMessage(response, fallback)
    if (/path not found/i.test(message)) return message
    return `${repo} isn't imported yet — run /repos.import ${repo} first`
  }

  /*
   * The local route (`POST /api/repo/files`, LOCAL-APP.md): one request
   * answers a directory or a file, already bounded and already honest about
   * binary, so the seam only renders. Failures are the same honest strings
   * the Cloud path answers.
   */
  const localRequest = async (
    repo: Repo,
    path: string,
    label: string,
    verb: "list" | "read"
  ): Promise<{ readonly body: RepoFilesResponse } | { readonly error: string }> => {
    let response: Response
    try {
      response = await ctx.http(`${ctx.baseUrl}${REPO_FILES_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoId: repo.id, path })
      })
    } catch (error) {
      return { error: `Could not reach the local app to ${verb} ${label} in ${repo.name}: ${errorText(error)}` }
    }
    if (response.status === 404) return { error: await readErrorMessage(response, `Path not found: ${label} in ${repo.name}`) }
    if (!response.ok) {
      return {
        error: await readErrorMessage(response, `${verb === "list" ? "Listing" : "Reading"} ${label} in ${repo.name} failed (${response.status})`)
      }
    }
    const parsed = RepoFilesResponseSchema.safeParse(await response.json().catch(() => null))
    if (!parsed.success) return { error: `The local app answered ${label} in ${repo.name} with an unreadable payload` }
    return { body: parsed.data }
  }

  const listLocal = async (repo: Repo, path: string): Promise<string | { readonly value: string }> => {
    const normalized = normalizePath(path)
    const label = normalized === "" ? "/" : normalized
    const answer = await localRequest(repo, normalized, label, "list")
    if ("error" in answer) return answer.error
    if (answer.body.kind === "file") return `${normalized} in ${repo.name} is a file — run /files.read ${normalized} instead`
    const entries = sortEntries(answer.body.entries)
    upsert({
      id: `files-${repo.name}-${label}`,
      kind: "file-list",
      title: `Files · ${repo.name} · ${label}`,
      status: "active",
      createdAt: Date.now(),
      ordinal: ctx.nextOrdinal(),
      payload: { repo: repo.name, path: normalized, entries, ...(answer.body.truncated === true ? { truncated: true } : {}) }
    })
    return {
      value: listingValue(repo.name, normalized, entries) +
        (answer.body.truncated === true ? "\n(the directory holds more entries than the listing cap; this is the first page by name)" : "")
    }
  }

  const readLocal = async (repo: Repo, path: string): Promise<string | { readonly value: string }> => {
    const normalized = normalizePath(path)
    if (normalized === "") return "files.read needs a file path"
    const answer = await localRequest(repo, normalized, normalized, "read")
    if ("error" in answer) return answer.error
    if (answer.body.kind === "dir") return `${normalized} in ${repo.name} is a directory — run /files.list ${normalized} instead`
    const { content, binary } = answer.body
    const truncated = !binary && (answer.body.truncated || content.length > CARD_CONTENT_CAP)
    const payload = {
      repo: repo.name,
      path: normalized,
      content: binary ? "" : content.slice(0, CARD_CONTENT_CAP),
      truncated,
      ...(binary ? { binary: true } : {})
    }
    upsert({
      id: `file-${repo.name}-${normalized}`,
      kind: "file",
      title: `File · ${repo.name} · ${normalized}`,
      status: "active",
      createdAt: Date.now(),
      ordinal: ctx.nextOrdinal(),
      payload
    })
    return { value: fileValue(repo.name, normalized, payload) }
  }

  return {
    listFiles: async (path, explicitRepo) => {
      if (unsafePath(path)) return "File paths must stay inside the repository."
      const local = localTarget(ctx.store, explicitRepo)
      if (local !== undefined) return "error" in local ? local.error : listLocal(local.repo, path)
      const target = resolveTargetRepo(ctx.store, explicitRepo)
      if ("error" in target) return target.error
      const { repo } = target
      const normalized = normalizePath(path)
      const label = normalized === "" ? "/" : normalized

      let response: Response
      try {
        response = await ctx.http(contentsUrl(repo, normalized))
      } catch (error) {
        return `Could not reach the backend to list ${label} in ${repo}: ${errorText(error)}`
      }
      if (response.status === 404) {
        return explain404(response, repo, `Path not found: ${label} in ${repo}`)
      }
      if (!response.ok) {
        return readErrorMessage(response, `Listing ${label} in ${repo} failed (${response.status})`)
      }

      const body: unknown = await response.json().catch(() => null)
      if (!Array.isArray(body)) {
        // The contents route answers a record (content/encoding) for a file path.
        if (isRecord(body) && ("content" in body || "encoding" in body)) {
          return `${normalized} in ${repo} is a file — run /files.read ${normalized} instead`
        }
        return `The backend answered ${label} in ${repo} with an unreadable payload`
      }
      const entries = sortEntries(
        body.flatMap((entry) => {
          const parsed = parseEntry(entry)
          return parsed === null ? [] : [parsed]
        })
      )
      upsert({
        id: `files-${repo}-${normalized === "" ? "/" : normalized}`,
        kind: "file-list",
        title: `Files · ${repo} · ${label}`,
        status: "active",
        createdAt: Date.now(),
        ordinal: ctx.nextOrdinal(),
        payload: { repo, path: normalized, entries }
      })
      return { value: listingValue(repo, normalized, entries) }
    },

    readFile: async (path, explicitRepo) => {
      if (unsafePath(path)) return "File paths must stay inside the repository."
      const local = localTarget(ctx.store, explicitRepo)
      if (local !== undefined) return "error" in local ? local.error : readLocal(local.repo, path)
      const target = resolveTargetRepo(ctx.store, explicitRepo)
      if ("error" in target) return target.error
      const { repo } = target
      const normalized = normalizePath(path)
      if (normalized === "") return "files.read needs a file path"

      let response: Response
      try {
        response = await ctx.http(contentsUrl(repo, normalized))
      } catch (error) {
        return `Could not reach the backend to read ${normalized} in ${repo}: ${errorText(error)}`
      }
      if (response.status === 404) {
        return explain404(response, repo, `Path not found: ${normalized} in ${repo}`)
      }
      if (!response.ok) {
        return readErrorMessage(
          response,
          `Reading ${normalized} in ${repo} failed (${response.status})`
        )
      }

      const body: unknown = await response.json().catch(() => null)
      if (Array.isArray(body)) {
        return `${normalized} in ${repo} is a directory — run /files.list ${normalized} instead`
      }
      if (!isRecord(body)) {
        return `The backend answered ${normalized} in ${repo} with an unreadable payload`
      }
      const rawContent = typeof body.content === "string" ? body.content : ""
      /*
       * §8.27: a binary file is STATED, not printed. The card says so rather
       * than laying out 42 000 pixels of base64 the reader can neither use
       * nor reach — and it is a card, because the read succeeded and the
       * answer is about the file.
       *
       * The declared encoding is not trusted on its own: the platform
       * answers `encoding: "utf-8"` for a file whose content is plainly
       * base64-encoded bytes, so a body that is nothing but base64 alphabet
       * is decoded and checked. A real text file never matches — the
       * alphabet excludes every punctuation mark prose and code use.
       */
      const binaryCard = (): { readonly value: string } => {
        upsert({
          id: `file-${repo}-${normalized}`,
          kind: "file",
          title: `File · ${repo} · ${normalized}`,
          status: "active",
          createdAt: Date.now(),
          ordinal: ctx.nextOrdinal(),
          payload: { repo, path: normalized, content: "", truncated: false, binary: true }
        })
        return { value: fileValue(repo, normalized, { content: "", truncated: false, binary: true }) }
      }
      let content: string
      if (body.encoding === "base64") {
        const decoded = decodeBase64(rawContent)
        if (decoded.binary) return binaryCard()
        content = decoded.text
      } else {
        if (rawContent.includes("\u0000")) return binaryCard()
        if (LOOKS_BASE64.test(rawContent) && decodeBase64(rawContent).binary) return binaryCard()
        content = rawContent
      }
      const truncated = content.length > CARD_CONTENT_CAP
      const payload = {
        repo,
        path: normalized,
        content: truncated ? content.slice(0, CARD_CONTENT_CAP) : content,
        truncated
      }
      upsert({
        id: `file-${repo}-${normalized}`,
        kind: "file",
        title: `File · ${repo} · ${normalized}`,
        status: "active",
        createdAt: Date.now(),
        ordinal: ctx.nextOrdinal(),
        payload
      })
      return { value: fileValue(repo, normalized, payload) }
    }
  }
}
