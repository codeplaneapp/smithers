/*
 * The jjhub Cloud sign-in on the local origin (ADR 0001 "Settled with the
 * backend"): the CLI's browser login, not an env token. `start` listens on
 * 127.0.0.1:<random> with `/callback` and answers the URL the renderer opens
 * in the system browser (`${API}/api/auth/github/cli?callback_port=<port>`);
 * the callback receives `{ token, username, email, expiresAt }` (a
 * `smithers_` PAT), which is stored in the macOS keychain under
 * `smithers-cloud` and kept in Bun memory. The token NEVER leaves this
 * process: `session()` answers `{ state, username, expiresAt, scopes? }` and
 * the `/api/cloud/*` proxy attaches the bearer itself.
 *
 * `SMITHERS_CLOUD_TOKEN` is a dev/CI override, read first — a set override
 * means signed-in with no login round-trip and nothing to store.
 *
 * Scopes degrade honestly (ADR 0001): today the CLI login mints the legacy
 * set and workspace/agent/approval calls 403 "insufficient token scope", so
 * the probe (GET /api/user/workspaces) runs once, before the session reports
 * signed-in; a 403 whose body says insufficient scope marks the session
 * `scopes: "degraded"`. The session never reports signed-in without its scope
 * verdict, so a reader that polls for the state gets one consistent answer.
 */
import type { Server } from "bun"
import type { CloudSession } from "smithers-shared/LocalApp"

/** What the login callback posts; the keychain entry serializes exactly this. */
export interface CloudCredentials {
  readonly token: string
  readonly username: string
  readonly email: string | null
  readonly expiresAt: string | null
}

/** The OS keychain behind the token at rest; injectable so tests never touch the real one. */
export interface CloudKeychain {
  readonly read: (service: string, account: string) => Promise<string | null>
  readonly write: (service: string, account: string, secret: string) => Promise<void>
  readonly remove: (service: string, account: string) => Promise<void>
}

export interface CloudAuthOptions {
  /** The cloud API origin the login URL and the scope probe target. */
  readonly api: string
  /** SMITHERS_CLOUD_TOKEN: the dev/CI override, read before any stored credential. */
  readonly envToken?: string | undefined
  readonly keychain?: CloudKeychain
  readonly fetchImpl?: typeof fetch
  /** The callback wait; production is five minutes. */
  readonly waitTimeoutMs?: number
  readonly log?: (line: string) => void
}

export interface CloudAuth {
  /** The bearer the `/api/cloud/*` proxy attaches; undefined when signed out. */
  readonly token: () => string | undefined
  /** The renderer-safe session answer: never the token. */
  readonly session: () => CloudSession
  /** Begin the browser login: answers the URL to open, or the honest error. */
  readonly start: () => Promise<{ readonly url: string } | { readonly error: string }>
  /** Forget the stored credential (the env override is not sign-out-able). */
  readonly signOut: () => Promise<void>
  /** Close a pending callback listener; the server calls this on shutdown. */
  readonly stop: () => Promise<void>
}

export const CLOUD_KEYCHAIN_SERVICE = "smithers-cloud"
export const CLOUD_AUTH_WAIT_TIMEOUT_MS = 5 * 60 * 1000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** The callback body's contract; anything else is refused, never partially stored. */
export const parseCloudCredentials = (value: unknown): CloudCredentials | null => {
  if (!isRecord(value)) return null
  if (typeof value.token !== "string" || value.token === "") return null
  if (typeof value.username !== "string" || value.username === "") return null
  return {
    token: value.token,
    username: value.username,
    email: typeof value.email === "string" ? value.email : null,
    expiresAt: typeof value.expiresAt === "string" ? value.expiresAt : null
  }
}

const run = async (argv: ReadonlyArray<string>): Promise<{ readonly code: number; readonly stdout: string }> => {
  const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "ignore" })
  const stdout = (await new Response(proc.stdout).text()).trim()
  const code = await proc.exited
  return { code, stdout }
}

/*
 * macOS `security`: one generic-password entry per API host. The secret is
 * the serialized CloudCredentials, so a restart restores the whole session,
 * not just the token. Every operation is best-effort: a keychain refusal
 * loses persistence, never the in-memory session.
 */
const darwinKeychain = (): CloudKeychain => ({
  read: async (service, account) => {
    try {
      const { code, stdout } = await run(["security", "find-generic-password", "-s", service, "-a", account, "-w"])
      return code === 0 && stdout !== "" ? stdout : null
    } catch {
      return null
    }
  },
  write: async (service, account, secret) => {
    try {
      await run(["security", "add-generic-password", "-U", "-s", service, "-a", account, "-w", secret])
    } catch {
      // Best-effort: the in-memory session still holds the token.
    }
  },
  remove: async (service, account) => {
    try {
      await run(["security", "delete-generic-password", "-s", service, "-a", account])
    } catch {
      // Already gone is the same end state.
    }
  }
})

/** Off macOS there is no keychain contract; reads answer empty and writes are dropped. */
const inertKeychain = (): CloudKeychain => ({
  read: async () => null,
  write: async () => {},
  remove: async () => {}
})

interface PendingLogin {
  readonly url: string
  readonly server: Server<undefined>
  readonly timeout: ReturnType<typeof setTimeout>
  readonly done: Promise<void>
}

export const createCloudAuth = async (options: CloudAuthOptions): Promise<CloudAuth> => {
  const api = options.api.replace(/\/+$/, "")
  const account = new URL(api).host
  const keychain = options.keychain ?? (process.platform === "darwin" ? darwinKeychain() : inertKeychain())
  const fetchImpl = options.fetchImpl ?? fetch
  const waitTimeoutMs = options.waitTimeoutMs ?? CLOUD_AUTH_WAIT_TIMEOUT_MS
  const log = options.log ?? (() => {})

  let credentials: CloudCredentials | null = null
  let degraded = false
  let pending: PendingLogin | null = null

  // A previous launch's login restores from the keychain; the env override still wins.
  if (options.envToken === undefined || options.envToken === "") {
    const stored = await keychain.read(CLOUD_KEYCHAIN_SERVICE, account)
    if (stored !== null) {
      try {
        credentials = parseCloudCredentials(JSON.parse(stored))
      } catch {
        credentials = null
      }
    }
  }

  const token = (): string | undefined =>
    options.envToken !== undefined && options.envToken !== "" ? options.envToken : credentials?.token

  /*
   * The one probe (ADR 0001): a 403 that says insufficient scope means the
   * legacy token set — workspace/agent/approval acts degrade to "sign in
   * again to enable" instead of failing silently.
   */
  const probeScopes = async (bearer: string): Promise<boolean> => {
    try {
      const response = await fetchImpl(`${api}/api/user/workspaces`, {
        headers: { authorization: `Bearer ${bearer}` }
      })
      if (response.status !== 403) return false
      const text = await response.text().catch(() => "")
      return /insufficient/i.test(text) && /scope/i.test(text)
    } catch {
      // A failed probe says nothing about scope; the session stays undegraded.
      return false
    }
  }

  const clearPending = (): void => {
    if (pending === null) return
    clearTimeout(pending.timeout)
    pending.server.stop(true)
    pending = null
  }

  const accept = async (value: unknown): Promise<void> => {
    const parsed = parseCloudCredentials(value)
    if (parsed === null) return
    // The probe answers before the credentials are published: `session()`
    // reads signed-in off the stored credentials, so publishing first would
    // let a reader see signed-in with no scope verdict and then watch it
    // degrade a moment later.
    const scopesDegraded = await probeScopes(parsed.token)
    credentials = parsed
    degraded = scopesDegraded
    try {
      await keychain.write(CLOUD_KEYCHAIN_SERVICE, account, JSON.stringify(parsed))
    } catch {
      // Best-effort persistence; memory still holds the session.
    }
    log(`cloud-auth: signed in as ${parsed.username}`)
  }

  return {
    token,
    session: (): CloudSession => ({
      state: token() !== undefined ? "signed-in" : pending === null ? "signed-out" : "signing-in",
      username: credentials?.username ?? null,
      expiresAt: credentials?.expiresAt ?? null,
      ...(degraded ? { scopes: "degraded" as const } : {})
    }),
    start: async () => {
      if (token() !== undefined) return { error: "Already signed in to Smithers Cloud." }
      if (pending !== null) return { url: pending.url }
      let settle: () => void = () => {}
      const done = new Promise<void>((resolve) => {
        settle = resolve
      })
      let claimed = false
      let server: Server<undefined>
      try {
        server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: async (request) => {
            const { pathname } = new URL(request.url)
            if (pathname !== "/callback") return new Response("not found", { status: 404 })
            if (request.method !== "POST") return new Response("method not allowed", { status: 405 })
            const body: unknown = await request.json().catch(() => null)
            if (parseCloudCredentials(body) === null) {
              return Response.json({ error: "expected { token, username, email, expiresAt }" }, { status: 400 })
            }
            // The first well-formed callback settles the attempt; a later one
            // (a replay, or a local process racing the real callback) can no
            // longer substitute the token.
            if (claimed) return Response.json({ error: "this sign-in attempt already received its callback" }, { status: 409 })
            claimed = true
            void accept(body).finally(settle)
            return Response.json({ ok: true })
          }
        })
      } catch (error) {
        return { error: `Could not listen for the sign-in callback: ${error instanceof Error ? error.message : String(error)}` }
      }
      const url = `${api}/api/auth/github/cli?callback_port=${server.port}`
      const timeout = setTimeout(() => {
        log("cloud-auth: the sign-in callback never arrived; the attempt expired")
        settle()
      }, waitTimeoutMs)
      pending = { url, server, timeout, done }
      void done.finally(clearPending)
      return { url }
    },
    signOut: async () => {
      clearPending()
      credentials = null
      degraded = false
      await keychain.remove(CLOUD_KEYCHAIN_SERVICE, account)
    },
    stop: async () => {
      clearPending()
    }
  }
}
