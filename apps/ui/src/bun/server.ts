/*
 * The local origin (LOCAL-APP.md, "Runtime topology"): one Bun.serve on
 * 127.0.0.1 that serves the built SPA, the chat boundary, the WebSocket bus,
 * and every lane's HTTP API. It imports nothing from Electrobun, so
 * `serve.ts` can run it without a window and Playwright can drive it in plain
 * Chromium.
 */
import type { Server, ServerWebSocket } from "bun"
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, normalize, resolve } from "node:path"
import {
  AUTH_ROUTE_PREFIX,
  AUTH_SESSION_PATH,
  CANCEL_PATH,
  CHAT_CANCEL_PATH,
  CHAT_TURN_PATH,
  HEALTH_PATH,
  IDENTITY_ROUTE_PREFIX,
  TURN_PATH
} from "smithers-shared/AgentApiRoutes"
import { APP_API_VERSION, APP_BOOTSTRAP_PATH } from "smithers-shared/AppBootstrap"
import { AgentRuntimeContextSchema } from "smithers-shared/AgentContext"
import {
  isLocalSessionToken,
  localSessionProtocol,
  LOCAL_SESSION_HEADER,
  LOCAL_SESSION_META
} from "smithers-shared/LocalSession"
import type { AgentTurnFrame, StartAgentTurnRequest } from "smithers-shared/NativeAgent"
import { createChatStub } from "./ChatStub"
import { createCloudAgent } from "./CloudAgent"
import type { CloudAgent } from "./CloudAgent"
import { detectHarnesses } from "./Harnesses"
import { findNode } from "./Node"
import type { NodeSidecar } from "./Node"
import { binDirOf, createPtyManager } from "./Pty"
import type { PtyManager } from "./Pty"
import { createRepositoryAuthority } from "./RepositoryAuthority"
import type { RepositoryAuthority } from "./RepositoryAuthority"
import { json, jsonError, readJson, Router } from "./routes"
import type { RouteHandler } from "./routes"
import { registerRepoTargetRoutes } from "./routes/repoTargets"
import { registerTargetGraphRoutes } from "./routes/targetGraph"
import { registerHarnessRoutes } from "./routes/harnesses"
import type { HarnessDetector } from "./routes/harnesses"
import { registerPtyRoutes } from "./routes/pty"
import { currentSandboxHost, sandboxEnforced } from "./Sandbox"

/** chat.smithers.sh accepts this origin anonymously (verified 2026-08-26). */
export const DEFAULT_CHAT_ORIGIN = "https://canary.smithers.sh"
/** The deployed identity seam the sign-in device flow talks to. */
export const DEFAULT_IDENTITY_UPSTREAM = "https://canary.smithers.sh"
export const APP_VERSION = "0.0.1"
/** Where the SPA posts uncaught errors; the client half is state/ClientErrors.ts. */
export const CLIENT_ERRORS_PATH = "/api/client-errors"
/** Bytes on the wire, the unit the client bounds its report in. */
export const CLIENT_ERROR_MAX_BODY = 16 * 1024

/** Long conversations are replayed on every turn, so the cap is generous, not tight. */
const MAX_BODY_BYTES = 1024 * 1024
const MAX_WS_FRAME_BYTES = 128 * 1024
const MAX_WS_SUBSCRIPTIONS = 64
const MAX_WS_TOPIC_CHARS = 256

export interface LocalServerOptions {
  /** 0 (the default) picks a free port. */
  readonly port?: number
  /** The built SPA: index.html plus assets/. */
  readonly distDir: string
  /** SMITHERS_CHAT_STUB=1: the deterministic stub instead of chat.smithers.sh. */
  readonly chatStub?: boolean
  /** Offline has no network egress; hybrid explicitly enables Smithers Cloud. */
  readonly cloudMode?: "offline" | "hybrid"
  readonly chat?: { readonly chatUrl?: string; readonly origin?: string }
  /**
   * Where `/api/auth/*` and `/api/identity/*` are forwarded so the sign-in
   * device flow reaches a real identity seam. `null` disables the proxy; the
   * stub mode never proxies.
   */
  readonly identityUpstream?: string | null
  readonly version?: string
  readonly buildSha?: string
  /** Headless/dev-only escape hatch. Native production accepts picker grants only. */
  readonly allowManualRepositoryPaths?: boolean
  /** A pre-resolved Node sidecar; the default probes once at startup. */
  readonly node?: NodeSidecar | null
  /** The smthrs build-cli entry for the targets lane; the default resolves it from the checkout (or SMITHERS_BUILD_CLI). */
  readonly buildCli?: string
  /** The home directory used for PTYs without a repoId and reported by `/api/health`. */
  readonly home?: string
  /** The harness table behind `GET /api/harnesses` and harness tabs; default `detectHarnesses`. */
  readonly harnesses?: HarnessDetector
  /** The PTY manager behind `/api/pty*`; the default spawns real sessions. */
  readonly pty?: (deps: { readonly publish: LocalServer["publish"]; readonly harnesses: HarnessDetector; readonly home: string; readonly pathPrepend: () => Promise<ReadonlyArray<string>>; readonly log: (line: string) => void }) => PtyManager
  readonly log?: (line: string) => void
  /** Test/replay override; production generates 256 fresh random bits. */
  readonly sessionToken?: string
}

export interface WsSocketData {
  readonly topics: Set<string>
}

export type WsSocket = ServerWebSocket<WsSocketData>

/** A client frame other than subscribe/unsubscribe, dispatched by its `type`. */
export type WsMessageHandler = (message: Readonly<Record<string, unknown>>, socket: WsSocket) => void

export interface LocalServer {
  readonly origin: string
  readonly port: number
  readonly sessionToken: string
  readonly websocketProtocol: string
  readonly router: Router
  readonly server: Server<WsSocketData>
  /** Sends one JSON frame to every socket subscribed to the topic. */
  readonly publish: (topic: string, message: unknown) => void
  /** Registers the handler for one client frame type (e.g. "pty.input"). Returns the unregister. */
  readonly onMessage: (type: string, handler: WsMessageHandler) => () => void
  /** Native-only door: inspect a picked path and mint a one-shot HTTP grant. */
  readonly authorizeRepository: RepositoryAuthority["authorize"]
  readonly stop: () => Promise<void>
}

/**
 * The SPA directory for a caller in `fromDir`. SMITHERS_DIST_DIR wins; a
 * packaged app finds the copied views next to its main bundle; a source
 * checkout falls back to apps/ui/dist.
 */
export const defaultDistDir = (fromDir: string, env: Readonly<Record<string, string | undefined>> = Bun.env): string => {
  const explicit = env.SMITHERS_DIST_DIR?.trim()
  if (explicit !== undefined && explicit !== "") return resolve(explicit)
  const candidates = [
    resolve(fromDir, "..", "views", "mainview"),
    resolve(fromDir, "..", "..", "dist")
  ]
  return candidates.find((dir) => existsSync(join(dir, "index.html"))) ?? candidates[candidates.length - 1]!
}

const isStartTurnRequest = (value: unknown): value is StartAgentTurnRequest =>
  typeof value === "object" &&
  value !== null &&
  "runId" in value &&
  typeof value.runId === "string" &&
  value.runId !== "" &&
  "messages" in value &&
  Array.isArray(value.messages) &&
  "instructions" in value &&
  typeof value.instructions === "string" &&
  (!("tools" in value) || value.tools === undefined || Array.isArray(value.tools)) &&
  (!("context" in value) ||
    value.context === undefined ||
    AgentRuntimeContextSchema.safeParse(value.context).success)

/** A live turn's open NDJSON response. `end` is idempotent so a disconnect, a cancel and a `done` can race. */
interface TurnWriter {
  readonly write: (frame: AgentTurnFrame) => void
  readonly end: () => void
}

const encoder = new TextEncoder()

/** The stub's stand-in for the identity seam: signed out, nothing else configured. */
const stubIdentity = (pathname: string): Response =>
  pathname === AUTH_SESSION_PATH
    ? json({ status: "signed-out" })
    : jsonError(501, "not_implemented", "The identity seam is stubbed in this build.")

/**
 * Forwards an identity request to the deployed seam. The upstream refuses
 * cross-origin writes, so the Origin header follows the upstream (the same
 * rewrite the old Vite dev proxy did), and a session cookie it sets is
 * re-scoped to this origin by dropping its Domain attribute.
 */
const proxyIdentity = async (request: Request, url: URL, upstream: string): Promise<Response> => {
  const target = new URL(url.pathname + url.search, upstream)
  const headers = new Headers(request.headers)
  headers.set("host", target.host)
  headers.set("origin", new URL(upstream).origin)
  headers.delete("content-length")
  let response: Response
  try {
    response = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
      redirect: "manual"
    })
  } catch (error) {
    return jsonError(502, "identity_unreachable", error instanceof Error ? error.message : "identity upstream unreachable")
  }
  const out = new Headers(response.headers)
  out.delete("content-encoding")
  out.delete("content-length")
  const cookies = response.headers.getSetCookie()
  if (cookies.length > 0) {
    out.delete("set-cookie")
    for (const cookie of cookies) out.append("set-cookie", cookie.replace(/;\s*domain=[^;]*/i, ""))
  }
  return new Response(response.body, { status: response.status, headers: out })
}

export const startLocalServer = async (options: LocalServerOptions): Promise<LocalServer> => {
  const log = options.log ?? ((line: string) => console.log(line))
  const distDir = resolve(options.distDir)
  const version = options.version ?? APP_VERSION
  const sandboxHost = currentSandboxHost()
  const nodeProbe: Promise<NodeSidecar | null> = options.node === undefined ? findNode() : Promise.resolve(options.node)
  const remoteEnabled = options.cloudMode === "hybrid"
  const identityUpstream = options.chatStub === true || !remoteEnabled
    ? null
    : options.identityUpstream === undefined
    ? DEFAULT_IDENTITY_UPSTREAM
    : options.identityUpstream
  const home = options.home ?? homedir()
  const harnesses: HarnessDetector = options.harnesses ?? (() => detectHarnesses())
  const sessionToken = options.sessionToken ?? randomBytes(32).toString("base64url")
  if (!isLocalSessionToken(sessionToken)) throw new Error("Local server session token must be 256-bit base64url.")
  const websocketProtocol = localSessionProtocol(sessionToken)
  const repositoryAuthority = createRepositoryAuthority()

  const writers = new Map<string, TurnWriter>()
  const publishFrame = (frame: AgentTurnFrame): void => writers.get(frame.runId)?.write(frame)
  const agent: CloudAgent | undefined = options.chatStub === true
    ? createChatStub(publishFrame)
    : remoteEnabled
    ? createCloudAgent(publishFrame, {
      chatUrl: options.chat?.chatUrl ?? Bun.env.SMITHERS_CHAT_URL,
      origin: options.chat?.origin ?? Bun.env.SMITHERS_CHAT_ORIGIN ?? DEFAULT_CHAT_ORIGIN
    })
    : undefined
  const finish = (runId: string, writer: TurnWriter): void => {
    if (writers.get(runId) === writer) writers.delete(runId)
    writer.end()
  }

  const router = new Router()

  router.add("GET", APP_BOOTSTRAP_PATH, () => {
    const enforced = sandboxEnforced(sandboxHost)
    return json({
      apiVersion: APP_API_VERSION,
      host: "local",
      version,
      buildSha: options.buildSha ?? Bun.env.SMITHERS_BUILD_SHA ?? "unknown",
      capabilities: [
        ...(agent === undefined ? [] : ["agent"]),
        ...(identityUpstream === null ? [] : ["identity"]),
        "local.repositories",
        ...(options.allowManualRepositoryPaths === true ? ["local.repository-path-entry"] : []),
        "local.targets",
        "local.terminal",
        "local.harnesses"
      ],
      authFlow: identityUpstream === null ? "none" : "both",
      sandbox: {
        platform: process.platform,
        mode: enforced ? "enforced" : sandboxHost.disabled ? "unavailable" : "trusted-only"
      }
    })
  })

  router.add("GET", HEALTH_PATH, async () =>
    json({
      ok: true,
      version,
      pid: process.pid,
      home,
      node: await nodeProbe,
      sandbox: { platform: process.platform, enforced: sandboxEnforced(sandboxHost) }
    }))

  const handleChatTurn: RouteHandler = async ({ request }) => {
    if (agent === undefined) return jsonError(503, "agent_unavailable", "No agent provider is configured in local-only mode.")
    const length = Number(request.headers.get("content-length") ?? "0")
    if (length > MAX_BODY_BYTES) return jsonError(413, "body_too_large", "Request body is too large.")
    const parsed = await readJson(request)
    if ("error" in parsed) return parsed.error
    if (!isStartTurnRequest(parsed.body)) {
      return jsonError(400, "invalid_request", "Body must be { runId, messages, instructions } with optional tools and context.")
    }
    const body = parsed.body
    const runId = body.runId
    // The writer exists before the agent starts, so a frame published before
    // the response stream opens is queued, never lost.
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const queue: Array<Uint8Array> = []
    let ended = false
    const writer: TurnWriter = {
      write: (frame) => {
        if (ended) return
        const chunk = encoder.encode(`${JSON.stringify(frame)}\n`)
        if (controller === undefined) queue.push(chunk)
        else controller.enqueue(chunk)
        if (frame.type === "done") finish(runId, writer)
      },
      end: () => {
        if (ended) return
        ended = true
        try {
          controller?.close()
        } catch {
          // Already closed by the client.
        }
      }
    }
    writers.set(runId, writer)
    const started = agent.start(body)
    if (started.status === "error") {
      writers.delete(runId)
      return jsonError(409, "turn_running", started.message)
    }
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController
        for (const chunk of queue) streamController.enqueue(chunk)
        queue.length = 0
        if (ended) {
          try {
            streamController.close()
          } catch {
            // Nothing to close twice.
          }
        }
      },
      cancel() {
        // Only this response's own writer may cancel: a later turn reusing
        // the runId must survive this one's teardown.
        if (writers.get(runId) !== writer) return
        writers.delete(runId)
        ended = true
        agent.cancel(runId)
      }
    })
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" }
    })
  }
  router.add("POST", TURN_PATH, handleChatTurn)
  router.add("POST", CHAT_TURN_PATH, handleChatTurn)

  const handleChatCancel: RouteHandler = async ({ request }) => {
    if (agent === undefined) return jsonError(503, "agent_unavailable", "No agent provider is configured in local-only mode.")
    const parsed = await readJson(request)
    if ("error" in parsed) return parsed.error
    const runId = typeof parsed.body === "object" && parsed.body !== null && "runId" in parsed.body ? parsed.body.runId : undefined
    if (typeof runId !== "string" || runId === "") return jsonError(400, "invalid_request", "runId is required.")
    const result = agent.cancel(runId)
    // Cancelling aborts upstream without a frame, so the stream closes here
    // or the SPA would keep reading a response that can never complete.
    const writer = writers.get(runId)
    if (writer !== undefined) finish(runId, writer)
    return json({ ok: true, status: result.status })
  }
  router.add("POST", CANCEL_PATH, handleChatCancel)
  router.add("POST", CHAT_CANCEL_PATH, handleChatCancel)

  // The runtime error ingest the SPA posts to (state/ClientErrors.ts holds
  // the client half of this contract): logged, never persisted.
  router.add("POST", CLIENT_ERRORS_PATH, async ({ request }) => {
    const body = new Uint8Array(await request.arrayBuffer())
    if (body.byteLength > CLIENT_ERROR_MAX_BODY) {
      return jsonError(413, "body_too_large", `Client error reports are capped at ${CLIENT_ERROR_MAX_BODY} bytes.`)
    }
    log(`client-error: ${new TextDecoder().decode(body)}`)
    return json({ status: "accepted" }, 202)
  })

  const messageHandlers = new Map<string, Set<WsMessageHandler>>()
  const onMessage: LocalServer["onMessage"] = (type, handler) => {
    const set = messageHandlers.get(type) ?? new Set<WsMessageHandler>()
    set.add(handler)
    messageHandlers.set(type, set)
    return () => {
      set.delete(handler)
    }
  }

  const serveStatic = async (pathname: string): Promise<Response> => {
    const index = join(distDir, "index.html")
    const relative = normalize(decodeURIComponent(pathname)).replace(/^\/+/, "")
    const candidate = resolve(distDir, relative)
    if (relative !== "" && candidate.startsWith(distDir + "/") && existsSync(candidate)) {
      const file = Bun.file(candidate)
      if ((await file.exists()) && file.size > 0 || relative.includes(".")) {
        return new Response(file, {
          headers: relative.startsWith("assets/")
            ? { "cache-control": "public, max-age=31536000, immutable" }
            : { "cache-control": "no-store" }
        })
      }
    }
    if (!existsSync(index)) {
      return jsonError(503, "spa_missing", `No built SPA at ${distDir}. Run \`vite build\` first.`)
    }
    // SPA fallback: every route the page owns renders index.html. Only this
    // response receives the per-launch capability; static assets never do.
    const html = await Bun.file(index).text()
    const sessionMeta = `<meta name="${LOCAL_SESSION_META}" content="${sessionToken}">`
    const injected = /<head(?:\s[^>]*)?>/i.test(html)
      ? html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${sessionMeta}`)
      : `${sessionMeta}${html}`
    return new Response(injected, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
    })
  }

  /* Filled immediately after Bun chooses the port, before callers can reach it. */
  let origin = ""
  let expectedHost = ""
  const server = Bun.serve<WsSocketData>({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    idleTimeout: 255,
    fetch: async (request, bunServer) => {
      const url = new URL(request.url)
      const { pathname } = url
      if (request.headers.get("host") !== expectedHost) {
        return jsonError(421, "invalid_host", "This local server accepts only its loopback origin.")
      }
      if (pathname === "/" || pathname.startsWith("/api/")) log(`${request.method} ${pathname}`)
      if (pathname === "/ws") {
        const requestOrigin = request.headers.get("origin")
        if (requestOrigin !== null && requestOrigin !== origin) {
          return jsonError(403, "invalid_origin", "WebSocket origin does not match the local app.")
        }
        const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
          .split(",")
          .map((value) => value.trim())
        if (!protocols.includes(websocketProtocol)) {
          return jsonError(401, "local_session_required", "The local session capability is required.")
        }
        const upgraded = bunServer.upgrade(request, {
          data: { topics: new Set<string>() },
          headers: { "sec-websocket-protocol": websocketProtocol }
        })
        return upgraded ? undefined : jsonError(400, "upgrade_failed", "Expected a WebSocket upgrade.")
      }
      if (pathname.startsWith("/api/")) {
        /* Health remains public for process-supervisor readiness probes. */
        if (pathname !== HEALTH_PATH) {
          if (request.headers.get(LOCAL_SESSION_HEADER) !== sessionToken) {
            return jsonError(401, "local_session_required", "The local session capability is required.")
          }
          const requestOrigin = request.headers.get("origin")
          if (requestOrigin !== null && requestOrigin !== origin) {
            return jsonError(403, "invalid_origin", "Request origin does not match the local app.")
          }
        }
        const matched = router.match(request.method, pathname)
        if (matched !== undefined) {
          try {
            return await matched.handler({ request, url, params: matched.params })
          } catch (error) {
            log(`${request.method} ${pathname} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
            return jsonError(500, "internal", error instanceof Error ? error.message : "Request failed.")
          }
        }
        if (router.knows(pathname)) return jsonError(405, "method_not_allowed", `${request.method} is not allowed on ${pathname}.`)
        if (pathname.startsWith(AUTH_ROUTE_PREFIX) || pathname.startsWith(IDENTITY_ROUTE_PREFIX)) {
          return identityUpstream === null ? stubIdentity(pathname) : proxyIdentity(request, url, identityUpstream)
        }
        return jsonError(404, "not_found", `No route for ${request.method} ${pathname}.`)
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return jsonError(405, "method_not_allowed", `${request.method} is not allowed on ${pathname}.`)
      }
      return serveStatic(pathname)
    },
    websocket: {
      maxPayloadLength: MAX_WS_FRAME_BYTES,
      backpressureLimit: 1024 * 1024,
      closeOnBackpressureLimit: true,
      open: () => {},
      message: (socket, raw) => {
        let parsed: unknown
        try {
          parsed = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw))
        } catch {
          socket.send(JSON.stringify({ type: "error", message: "Frames must be JSON." }))
          return
        }
        if (typeof parsed !== "object" || parsed === null || typeof (parsed as { type?: unknown }).type !== "string") {
          socket.send(JSON.stringify({ type: "error", message: "Frames must carry a string `type`." }))
          return
        }
        const message = parsed as Record<string, unknown> & { readonly type: string }
        if (message.type === "subscribe" || message.type === "unsubscribe") {
          const topic = message.topic
          if (typeof topic !== "string" || topic === "" || topic.length > MAX_WS_TOPIC_CHARS) {
            socket.send(JSON.stringify({ type: "error", message: "subscribe needs a topic." }))
            return
          }
          if (message.type === "subscribe") {
            if (!socket.data.topics.has(topic) && socket.data.topics.size >= MAX_WS_SUBSCRIPTIONS) {
              socket.send(JSON.stringify({ type: "error", message: `At most ${MAX_WS_SUBSCRIPTIONS} topics may be subscribed.` }))
              return
            }
            socket.subscribe(topic)
            socket.data.topics.add(topic)
          } else {
            socket.unsubscribe(topic)
            socket.data.topics.delete(topic)
          }
          socket.send(JSON.stringify({ type: `${message.type}d`, topic }))
          return
        }
        const handlers = messageHandlers.get(message.type)
        if (handlers === undefined || handlers.size === 0) {
          socket.send(JSON.stringify({ type: "error", message: `No handler for ${message.type}.` }))
          return
        }
        for (const handler of handlers) {
          try {
            handler(message, socket)
          } catch (error) {
            log(`WebSocket ${message.type} handler failed: ${error instanceof Error ? error.message : String(error)}`)
            socket.send(JSON.stringify({ type: "error", message: "The WebSocket request failed." }))
          }
        }
      },
      close: (socket) => {
        for (const topic of socket.data.topics) socket.unsubscribe(topic)
        socket.data.topics.clear()
      }
    }
  })

  const port = server.port ?? 0
  origin = `http://127.0.0.1:${port}`
  expectedHost = `127.0.0.1:${port}`
  log(`SMITHERS_LOCAL_ORIGIN=${origin}`)

  const publish: LocalServer["publish"] = (topic, message) => {
    server.publish(topic, JSON.stringify(message))
  }

  // L3: one repository authority feeds targets and every child-process cwd.
  const routeHost = { router, publish, onMessage }
  const repoTargets = registerRepoTargetRoutes(routeHost, {
    node: nodeProbe,
    authority: repositoryAuthority,
    allowManualRepositoryPaths: options.allowManualRepositoryPaths,
    log,
    ...(options.buildCli === undefined ? {} : { cli: options.buildCli })
  })

  // L4: the harness table and PTY sessions. Browser input carries a repo id,
  // never a filesystem path; the server resolves the authorized cwd here.
  registerHarnessRoutes(router, harnesses)
  const ptyDeps = { publish, harnesses, home, pathPrepend: async () => binDirOf((await nodeProbe)?.path), log }
  const pty = options.pty === undefined ? createPtyManager(ptyDeps) : options.pty(ptyDeps)
  registerPtyRoutes(routeHost, pty, {
    resolveRepo: (repoId) => repoTargets.resolveRepo(repoId, "read-write")
  })

  const local: LocalServer = {
    origin,
    port,
    sessionToken,
    websocketProtocol,
    router,
    server,
    publish,
    onMessage,
    authorizeRepository: repositoryAuthority.authorize,
    stop: async () => {
      for (const [runId, writer] of writers) {
        agent?.cancel(runId)
        writer.end()
      }
      writers.clear()
      // Every child dies with the server; nothing keeps a shell alive past the app.
      await pty.killAll()
      repositoryAuthority.clear()
      server.stop(true)
    }
  }
  const targetGraph = registerTargetGraphRoutes(local, { repos: repoTargets.repos, history: repoTargets.history, node: nodeProbe, ...(options.buildCli === undefined ? {} : { cli: options.buildCli }) })
  let stopPromise: Promise<void> | undefined
  return {
    ...local,
    stop: () => stopPromise ??= (async () => {
      targetGraph.stop()
      repoTargets.stop()
      await local.stop()
    })()
  }
}
