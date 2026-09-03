/*
 * One language server for one (repository, language) (code-intel PLAN.md
 * §3): spawn, `initialize`, documents synced from DISK text, hover,
 * definition, diagnostics, and a clean shutdown. Positions are 1-based on
 * the wire and in flows; this module converts once, in both directions.
 * Every path goes through the files seam's rule (RepoFiles.ts): plain
 * segments under the root, real path inside it, bounded read. The server
 * publishes diagnostics for the files it was asked about; each publication
 * goes out as one `lsp.diagnostics` frame on `lsp:<repoId>`.
 */
import { basename, join, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { LSP_DIAGNOSTICS_CAP, LSP_HOVER_CAP_CHARS, LSP_LOCATIONS_CAP, LSP_REQUEST_TIMEOUT_MS, lspTopic } from "@smthrs/rpc/LocalApp"
import type {
  LspDiagnostic,
  LspDiagnosticsMessage,
  LspDiagnosticsResponse,
  LspHover,
  LspLocation,
  LspRange,
  LspSeverity
} from "@smthrs/rpc/LocalApp"
import { readRepoPath } from "../RepoFiles"
import { createJsonRpc, JsonRpcError } from "./JsonRpc"
import type { JsonRpc } from "./JsonRpc"
import type { LanguageId, ServerSpec } from "./LanguageServers"

export type LspSessionState = "starting" | "ready" | "exited"

/** A 1-based position as the wire carries it. */
export interface WirePosition {
  readonly line: number
  readonly character: number
}

export type LspRequestErrorCode =
  | "invalid_path"
  | "path_outside_repository"
  | "path_not_found"
  | "read_failed"
  | "file_too_large"
  | "language_server_busy"
  | "language_server_timeout"
  | "language_server_failed"

/** A refused request, with the HTTP status the route answers it with. */
export class LspRequestError extends Error {
  constructor(readonly code: LspRequestErrorCode, readonly http: number, message: string) {
    super(message)
    this.name = "LspRequestError"
  }
}

export interface LspSessionOptions {
  readonly repoId: string
  /** The repository's real path; the server's one workspace folder and its cwd. */
  readonly repoRoot: string
  readonly spec: ServerSpec
  /** The full argv, sandbox wrapper included. */
  readonly argv: ReadonlyArray<string>
  readonly env: Record<string, string>
  readonly publish: (topic: string, message: unknown) => void
  readonly requestTimeoutMs?: number
  /** Requests in flight per server; default 8. */
  readonly maxInFlight?: number
  /** Grace between the LSP `exit` and SIGKILL. */
  readonly killGraceMs?: number
  /** Every request passes through here (the host's idle clock). */
  readonly onTouch?: () => void
  readonly onExit?: (code: number | null) => void
  readonly log: (line: string) => void
}

export interface LspSession {
  readonly repoId: string
  readonly language: LanguageId
  readonly state: LspSessionState
  readonly pid: number
  /** Milliseconds since the epoch of the last request. */
  readonly lastUsed: number
  /** Settles when `initialize` answered; rejects when the server left first. */
  readonly ready: Promise<void>
  /** The child's exit code, once it exits. */
  readonly exited: Promise<number | null>
  hover(path: string, position: WirePosition): Promise<LspHover | null>
  definition(path: string, position: WirePosition): Promise<ReadonlyArray<LspLocation>>
  /**
   * The server's publication for the file: the last one when the file is
   * unchanged since it arrived, otherwise the next one within `waitMs`.
   * `items` is null when none arrived in time.
   */
  diagnostics(path: string, waitMs: number): Promise<LspDiagnosticsResponse>
  touch(): void
  /** LSP `shutdown` then `exit`, SIGKILL after the grace; idempotent. */
  shutdown(): Promise<void>
}

/* The server's shapes, as far as this module reads them (LSP 3.17). */
interface LspPositionWire {
  readonly line: number
  readonly character: number
}
interface LspRangeWire {
  readonly start: LspPositionWire
  readonly end: LspPositionWire
}
interface LspDiagnosticWire {
  readonly range: LspRangeWire
  readonly message: string
  readonly severity?: number
  readonly code?: number | string
  readonly source?: string
  readonly relatedInformation?: unknown
}
interface LspLocationWire {
  readonly uri: string
  readonly range: LspRangeWire
}
interface LspLocationLinkWire {
  readonly targetUri: string
  readonly targetRange: LspRangeWire
  readonly targetSelectionRange?: LspRangeWire
}
type MarkedString = string | { readonly language: string; readonly value: string }
type HoverContents = MarkedString | ReadonlyArray<MarkedString> | { readonly kind: string; readonly value: string }
interface HoverWire {
  readonly contents: HoverContents
  readonly range?: LspRangeWire
}

const SEVERITIES: Readonly<Record<number, LspSeverity>> = { 1: "error", 2: "warning", 3: "information", 4: "hint" }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

/** 0-based, end-exclusive → 1-based, end-exclusive. */
export const toWireRange = (range: LspRangeWire): LspRange => ({
  line: range.start.line + 1,
  character: range.start.character + 1,
  endLine: range.end.line + 1,
  endCharacter: range.end.character + 1
})

const markedString = (value: MarkedString): string =>
  typeof value === "string" ? value : `\`\`\`${value.language}\n${value.value}\n\`\`\``

/** The hover's text as one markdown string, cut at the cap. */
export const hoverContents = (contents: HoverContents): string => {
  const text = Array.isArray(contents)
    ? (contents as ReadonlyArray<MarkedString>).map(markedString).join("\n\n")
    : isRecord(contents) && "kind" in contents
    ? String(contents.value)
    : markedString(contents as MarkedString)
  return text.length > LSP_HOVER_CAP_CHARS ? text.slice(0, LSP_HOVER_CAP_CHARS) : text
}

/** One diagnostic as the card and the model see it; related information stays with the server. */
export const toDiagnostic = (item: LspDiagnosticWire): LspDiagnostic => ({
  ...toWireRange(item.range),
  severity: SEVERITIES[item.severity ?? 1] ?? "error",
  message: item.message,
  ...(item.source === undefined ? {} : { source: item.source }),
  ...(item.code === undefined ? {} : { code: String(item.code) })
})

interface OpenDocument {
  readonly relative: string
  readonly uri: string
  version: number
  text: string
  /** The last publication for this document, or null before the first. */
  latest: LspDiagnosticsResponse | null
  /** True from an open or change until the server publishes for it. */
  awaitingPublication: boolean
  waiters: Array<(response: LspDiagnosticsResponse) => void>
}

export const createLspSession = (options: LspSessionOptions): LspSession => {
  const { repoId, repoRoot, spec, publish, log } = options
  const requestTimeoutMs = options.requestTimeoutMs ?? LSP_REQUEST_TIMEOUT_MS
  const killGraceMs = options.killGraceMs ?? 2000
  const documents = new Map<string, OpenDocument>()
  let state: LspSessionState = "starting"
  let lastUsed = Date.now()
  let stderrTail = ""

  const proc = Bun.spawn([...options.argv], {
    cwd: repoRoot,
    env: options.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe"
  })

  void (async () => {
    const decoder = new TextDecoder()
    const reader = proc.stderr.getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      stderrTail = (stderrTail + decoder.decode(value, { stream: true })).slice(-2048)
    }
  })().catch(() => {})

  /** A file URI the server named, as a repository-relative path; null outside the root. */
  const relativeOf = (uri: string): string | null => {
    let path: string
    try {
      path = fileURLToPath(uri)
    } catch {
      return null
    }
    if (!path.startsWith(`${repoRoot}${sep}`)) return null
    return path.slice(repoRoot.length + 1).split(sep).join("/")
  }

  const onPublishDiagnostics = (params: unknown): void => {
    if (!isRecord(params) || typeof params.uri !== "string" || !Array.isArray(params.diagnostics)) return
    const relative = relativeOf(params.uri)
    if (relative === null) return
    const items = (params.diagnostics as ReadonlyArray<LspDiagnosticWire>).slice(0, LSP_DIAGNOSTICS_CAP).map(toDiagnostic)
    const version = typeof params.version === "number" && Number.isInteger(params.version) && params.version >= 0 ? params.version : null
    const response: LspDiagnosticsResponse = { path: relative, version, items }
    const document = documents.get(relative)
    if (document !== undefined) {
      document.latest = response
      document.awaitingPublication = false
      const waiters = document.waiters
      document.waiters = []
      for (const waiter of waiters) waiter(response)
    }
    const frame: LspDiagnosticsMessage = { type: "lsp.diagnostics", repoId, path: relative, version, items }
    publish(lspTopic(repoId), frame)
  }

  const rpc: JsonRpc = createJsonRpc(proc, {
    maxInFlight: options.maxInFlight ?? 8,
    log,
    onNotification: (method, params) => {
      if (method === "textDocument/publishDiagnostics") onPublishDiagnostics(params)
      else if (method === "window/logMessage" && isRecord(params) && params.type === 1) {
        log(`lsp ${repoId}/${spec.id}: ${String(params.message)}`)
      }
    },
    onRequest: (method, params) => {
      // The server asks for settings per document; we have none, and null keeps its defaults.
      if (method === "workspace/configuration" && isRecord(params) && Array.isArray(params.items)) {
        return params.items.map(() => null)
      }
      return null
    }
  })

  const rootUri = pathToFileURL(repoRoot).href
  const ready: Promise<void> = rpc
    .request<unknown>("initialize", {
      processId: process.pid,
      clientInfo: { name: "smithers" },
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: basename(repoRoot) }],
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false, didSave: false },
          hover: { contentFormat: ["markdown", "plaintext"] },
          publishDiagnostics: { relatedInformation: false }
        },
        workspace: { configuration: true, workspaceFolders: true }
      },
      ...(spec.initializationOptions === undefined ? {} : { initializationOptions: spec.initializationOptions })
    }, requestTimeoutMs)
    .then(() => {
      rpc.notify("initialized", {})
      if (state === "starting") state = "ready"
    })
  ready.catch((error: unknown) => {
    log(`lsp ${repoId}/${spec.id}: initialize failed: ${error instanceof Error ? error.message : String(error)}`)
  })

  const exited: Promise<number | null> = proc.exited.then((code) => {
    state = "exited"
    rpc.close()
    const exitCode = typeof code === "number" ? code : null
    for (const document of documents.values()) {
      const waiters = document.waiters
      document.waiters = []
      for (const waiter of waiters) waiter({ path: document.relative, version: null, items: null })
    }
    log(`lsp ${repoId}/${spec.id}: exited ${String(code)}`)
    options.onExit?.(exitCode)
    return exitCode
  })

  const touch = (): void => {
    lastUsed = Date.now()
    options.onTouch?.()
  }

  /** The request's failure as the route's refusal. */
  const refused = (error: unknown): LspRequestError => {
    if (error instanceof LspRequestError) return error
    if (error instanceof JsonRpcError) {
      switch (error.kind) {
        case "timeout":
          return new LspRequestError("language_server_timeout", 504, error.message)
        case "busy":
          return new LspRequestError("language_server_busy", 429, error.message)
        case "closed":
          return new LspRequestError(
            "language_server_failed",
            502,
            stderrTail.trim() === "" ? `The ${spec.displayName} language server exited.` : `The ${spec.displayName} language server exited: ${stderrTail.trim().split("\n").at(-1)}`
          )
        case "response":
          return new LspRequestError("language_server_failed", 502, error.message)
      }
    }
    return new LspRequestError("language_server_failed", 502, error instanceof Error ? error.message : String(error))
  }

  /**
   * The document as the server should see it: opened from disk on first
   * use, re-sent in full when the disk text changed since.
   */
  const sync = async (path: string): Promise<OpenDocument> => {
    const read = await readRepoPath(repoRoot, path)
    if (read.status === "error") throw new LspRequestError(read.code, read.http, read.message)
    if (read.body.kind !== "file") throw new LspRequestError("path_not_found", 404, `${read.body.path === "" ? "/" : read.body.path} is a directory.`)
    if (read.body.binary) throw new LspRequestError("invalid_path", 400, `${read.body.path} is binary.`)
    if (read.body.truncated) {
      throw new LspRequestError("file_too_large", 413, `${read.body.path} is larger than the language server read cap.`)
    }
    const relative = read.body.path
    const existing = documents.get(relative)
    if (existing === undefined) {
      const document: OpenDocument = {
        relative,
        uri: pathToFileURL(join(repoRoot, ...relative.split("/"))).href,
        version: 1,
        text: read.body.content,
        latest: null,
        awaitingPublication: true,
        waiters: []
      }
      documents.set(relative, document)
      rpc.notify("textDocument/didOpen", {
        textDocument: { uri: document.uri, languageId: spec.documentLanguageId(relative), version: 1, text: document.text }
      })
      return document
    }
    if (existing.text !== read.body.content) {
      existing.version += 1
      existing.text = read.body.content
      existing.awaitingPublication = true
      rpc.notify("textDocument/didChange", {
        textDocument: { uri: existing.uri, version: existing.version },
        contentChanges: [{ text: existing.text }]
      })
    }
    return existing
  }

  /* The idle clock counts from the last activity: a request touches on entry and on exit. */
  const positioned = async <T>(path: string, position: WirePosition, method: string): Promise<T> => {
    touch()
    try {
      await ready
      const document = await sync(path)
      return await rpc.request<T>(method, {
        textDocument: { uri: document.uri },
        position: { line: position.line - 1, character: position.character - 1 }
      }, requestTimeoutMs)
    } catch (error) {
      throw refused(error)
    } finally {
      touch()
    }
  }

  const hover: LspSession["hover"] = async (path, position) => {
    const answer = await positioned<HoverWire | null>(path, position, "textDocument/hover")
    if (answer === null || !isRecord(answer) || answer.contents === undefined) return null
    const contents = hoverContents(answer.contents)
    if (contents.trim() === "") return null
    return { contents, ...(answer.range === undefined ? {} : { range: toWireRange(answer.range) }) }
  }

  const definition: LspSession["definition"] = async (path, position) => {
    const answer = await positioned<LspLocationWire | ReadonlyArray<LspLocationWire | LspLocationLinkWire> | null>(path, position, "textDocument/definition")
    if (answer === null) return []
    const list = Array.isArray(answer) ? answer : [answer as LspLocationWire]
    const locations: Array<LspLocation> = []
    for (const entry of list) {
      const uri = "targetUri" in entry ? entry.targetUri : entry.uri
      const range = "targetUri" in entry ? entry.targetSelectionRange ?? entry.targetRange : entry.range
      const relative = relativeOf(uri)
      // A target outside the repository (a linked package, a lib.d.ts) is not a file card the renderer can open.
      if (relative === null) continue
      locations.push({ path: relative, ...toWireRange(range) })
      if (locations.length >= LSP_LOCATIONS_CAP) break
    }
    return locations
  }

  const diagnostics: LspSession["diagnostics"] = async (path, waitMs) => {
    touch()
    let document: OpenDocument
    try {
      await ready
      document = await sync(path)
    } catch (error) {
      throw refused(error)
    }
    if (!document.awaitingPublication && document.latest !== null) return document.latest
    const published = await new Promise<LspDiagnosticsResponse>((resolve) => {
      const timer = setTimeout(() => {
        document.waiters = document.waiters.filter((waiter) => waiter !== settle)
        resolve({ path: document.relative, version: null, items: null })
      }, waitMs)
      const settle = (response: LspDiagnosticsResponse): void => {
        clearTimeout(timer)
        resolve(response)
      }
      document.waiters.push(settle)
    })
    touch()
    return published
  }

  let shutdownPromise: Promise<void> | undefined
  const shutdown: LspSession["shutdown"] = () =>
    shutdownPromise ??= (async () => {
      if (state === "exited") return
      try {
        await rpc.request("shutdown", null, Math.min(requestTimeoutMs, 2000))
      } catch {
        // A server that cannot answer shutdown still gets exit, then the signal.
      }
      rpc.notify("exit", null)
      const left = await Promise.race([exited.then(() => true), Bun.sleep(killGraceMs).then(() => false)])
      if (!left) {
        try {
          proc.kill("SIGKILL")
        } catch {
          // Already gone.
        }
        await Promise.race([exited, Bun.sleep(1000)])
      }
      rpc.close()
    })()

  return {
    repoId,
    language: spec.id,
    get state() {
      return state
    },
    pid: proc.pid,
    get lastUsed() {
      return lastUsed
    },
    ready,
    exited,
    hover,
    definition,
    diagnostics,
    touch,
    shutdown
  }
}
