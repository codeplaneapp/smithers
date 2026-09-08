/**
 * Server-to-server GitHub reads authenticate as the GitHub App
 * `smitherspreviewrelease` (app id 4163546, owned by the `smithersai` org),
 * not as a personal access token: an App credential belongs to the
 * organization, its installation token expires in an hour, and it can be
 * rotated without touching anyone's account.
 *
 * The exchange is the one GitHub documents, done with WebCrypto so it runs
 * unchanged in workerd and in Bun's test runner:
 *
 *   1. sign an RS256 JWT with the App's private key (`iss` = the app id,
 *      `iat` = now - 60 s for clock skew, `exp` = now + 9 minutes; GitHub
 *      rejects anything past 10),
 *   2. `GET /app/installations` with that JWT to find the installation on the
 *      `smithersai` organization (live: installation 150824198, every
 *      repository), and
 *   3. `POST /app/installations/{id}/access_tokens` to mint the installation
 *      token the reads carry as a bearer.
 *
 * The token is cached in the isolate and in the Cache API under a private URL
 * for 55 minutes, so a cold isolate does not re-exchange; a 401 on a read
 * drops both copies and buys exactly one new token.
 *
 * Every failure is honest and lands on the anonymous read the catalog has
 * always had: the App is not installed, the key does not import, or GitHub
 * refuses the exchange, and the caller reads GitHub without a bearer while one
 * warning line names the cause. The failure state is remembered for 5 minutes
 * so a broken secret cannot turn every catalog refresh into two more GitHub
 * calls.
 *
 * The private key, the JWT, and the installation token never enter a log line,
 * a response body, or a cache key: only the GitHub request's authorization
 * header, and the token's own cache entry.
 */

/** The App secrets, and the token that overrides them. */
export interface GithubAppEnv {
  /** The GitHub App's numeric id (`wrangler secret put SMITHERS_GITHUB_APP_ID`). */
  readonly SMITHERS_GITHUB_APP_ID?: string
  /**
   * The App's PEM private key. GitHub issues it as PKCS#1
   * (`-----BEGIN RSA PRIVATE KEY-----`), which is how the deployed secret is
   * stored; a PKCS#8 key (`-----BEGIN PRIVATE KEY-----`) is accepted too.
   */
  readonly SMITHERS_GITHUB_APP_PRIVATE_KEY?: string
  /**
   * The optional override. Set, it wins over the App and is sent as the bearer
   * unchanged; it cannot be re-minted, so a 401 under it is not retried.
   */
  readonly GITHUB_TOKEN?: string
}

/** The bearer one GitHub read carries. */
export interface GithubBearer {
  readonly value: string
  /** An App installation token can be exchanged again after a 401; the override cannot. */
  readonly renewable: boolean
}

/** The Cache API surface this module uses; `delete` is optional because a test cache rarely has one. */
type TokenCache = Pick<Cache, "match" | "put"> & Partial<Pick<Cache, "delete">>

export interface GithubAppDeps {
  readonly fetch: (request: Request) => Promise<Response>
  readonly now: () => number
  readonly cache: () => TokenCache | undefined
  /** One line per failure. Defaults to `console.warn`; never receives a secret. */
  readonly log?: (line: string) => void
}

export interface GithubAppAuth {
  /** The bearer for a server-to-server read, or undefined for the anonymous read. */
  readonly token: (env: GithubAppEnv) => Promise<GithubBearer | undefined>
  /** Drops the cached installation token, in the isolate and at the edge, after a 401. */
  readonly forget: () => Promise<void>
}

const GITHUB_API = "https://api.github.com"

/** The organization whose installation this Worker prefers when the App is installed more than once. */
const PREFERRED_ACCOUNT = "smithersai"

/** GitHub installation tokens last an hour; 55 minutes leaves a margin for a slow read. */
const TOKEN_TTL_MS = 55 * 60 * 1000

/** How long a failed exchange is remembered, so a broken secret is not retried on every refresh. */
const FAILURE_TTL_MS = 5 * 60 * 1000

/** GitHub rejects a JWT that lives longer than 10 minutes; 9 leaves room for skew. */
const JWT_BACKDATE_S = 60
const JWT_LIFETIME_S = 9 * 60

/**
 * The Cache API key for the installation token. The hostname is not routed
 * anywhere, so the entry is reachable only by this Worker's own cache lookups.
 */
const TOKEN_CACHE_URL = "https://github-app.smithers.invalid/installation-token"
const EXPIRES_HEADER = "x-installation-expires"

/** Bytes over their own ArrayBuffer: what `crypto.subtle` accepts as a BufferSource. */
type Bytes = Uint8Array<ArrayBuffer>

const encoder = new TextEncoder()

const base64url = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

const fromBase64 = (value: string): Bytes => {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

const concat = (parts: ReadonlyArray<Uint8Array>): Bytes => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** A DER definite length: one byte under 128, otherwise a count byte and the big-endian length. */
const derLength = (length: number): Bytes => {
  if (length < 0x80) return Uint8Array.of(length)
  const bytes: Array<number> = []
  for (let value = length; value > 0; value = Math.floor(value / 256)) bytes.unshift(value % 256)
  return Uint8Array.of(0x80 | bytes.length, ...bytes)
}

/** One DER element: tag, definite length, payload. */
const der = (tag: number, payload: Uint8Array): Bytes => concat([Uint8Array.of(tag), derLength(payload.length), payload])

const DER_INTEGER = 0x02
const DER_OCTET_STRING = 0x04
const DER_NULL = Uint8Array.of(0x05, 0x00)
const DER_SEQUENCE = 0x30
/** OID 1.2.840.113549.1.1.1, rsaEncryption. */
const RSA_ENCRYPTION_OID = Uint8Array.of(0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01)

/**
 * WebCrypto imports PKCS#8 only, and GitHub issues PKCS#1, so the RSAPrivateKey
 * is wrapped in a PrivateKeyInfo:
 *
 *   SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING <pkcs1> }
 */
export const pkcs8FromPkcs1 = (pkcs1: Uint8Array): Bytes =>
  der(DER_SEQUENCE, concat([
    der(DER_INTEGER, Uint8Array.of(0x00)),
    der(DER_SEQUENCE, concat([RSA_ENCRYPTION_OID, DER_NULL])),
    der(DER_OCTET_STRING, pkcs1)
  ]))

/**
 * The base64 body between one PEM armor pair, or undefined when the PEM does
 * not carry that armor. Only whitespace is dropped, so an invalid body still
 * fails the decode instead of silently becoming other bytes.
 */
const armoredBody = (pem: string, armor: string): Bytes | undefined => {
  const begin = `-----BEGIN ${armor}-----`
  const end = `-----END ${armor}-----`
  const start = pem.indexOf(begin)
  const stop = pem.indexOf(end)
  if (start < 0 || stop <= start) return undefined
  const body = pem.slice(start + begin.length, stop).replace(/\s+/g, "")
  if (body === "") return undefined
  return fromBase64(body)
}

/**
 * The PKCS#8 DER for either armor GitHub or `openssl` produces. A secret stored
 * with escaped newlines (a key pasted through a shell that kept the backslashes)
 * reads like one stored with real ones.
 */
const privateKeyDer = (rawPem: string): Bytes => {
  const pem = rawPem.includes("\\n") ? rawPem.replaceAll("\\n", "\n") : rawPem
  const pkcs1 = armoredBody(pem, "RSA PRIVATE KEY")
  if (pkcs1 !== undefined) return pkcs8FromPkcs1(pkcs1)
  const pkcs8 = armoredBody(pem, "PRIVATE KEY")
  if (pkcs8 !== undefined) return pkcs8
  throw new Error("the private key carries no PKCS#1 or PKCS#8 PEM armor")
}

/**
 * The App JWT GitHub accepts on `/app/*`. Exported so a test can verify the
 * signature against the matching public key instead of trusting the shape.
 */
export const createAppJwt = async (appId: string, privateKeyPem: string, nowMs: number): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyDer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const seconds = Math.floor(nowMs / 1000)
  const header = base64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })))
  const claims = base64url(encoder.encode(JSON.stringify({
    iat: seconds - JWT_BACKDATE_S,
    exp: seconds + JWT_LIFETIME_S,
    iss: appId
  })))
  const signingInput = `${header}.${claims}`
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(signingInput))
  return `${signingInput}.${base64url(new Uint8Array(signature))}`
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** The login the installation belongs to, lowercased, or undefined when GitHub sent something else. */
const accountLogin = (entry: unknown): string | undefined => {
  const account = record(record(entry)?.account)
  return typeof account?.login === "string" ? account.login.toLowerCase() : undefined
}

const installationId = (entry: unknown): number | undefined => {
  const id = record(entry)?.id
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : undefined
}

export const createGithubAppAuth = (deps: GithubAppDeps): GithubAppAuth => {
  const log = deps.log ?? ((line: string) => console.warn(line))
  let held: { readonly value: string; readonly expiresAt: number } | undefined
  let failedUntil = 0
  let pending: Promise<GithubBearer | undefined> | undefined

  const cacheKey = () => new Request(TOKEN_CACHE_URL)

  const githubRequest = (url: string, jwt: string, method: "GET" | "POST") =>
    new Request(url, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "user-agent": "Smithers-github-app",
        "x-github-api-version": "2022-11-28"
      },
      // workerd throws on redirect: "error" before the request is sent, so a
      // redirect is asked for manually and read as the non-answer it is.
      redirect: "manual",
      signal: AbortSignal.timeout(10_000)
    })

  const readEdgeToken = async (): Promise<GithubBearer | undefined> => {
    const stored = await deps.cache()?.match(cacheKey()).catch(() => undefined)
    if (stored === undefined) return undefined
    const expiresAt = Number(stored.headers.get(EXPIRES_HEADER))
    const value = (await stored.text().catch(() => "")).trim()
    if (value === "" || !Number.isFinite(expiresAt) || expiresAt <= deps.now()) return undefined
    held = { value, expiresAt }
    return { value, renewable: true }
  }

  const writeEdgeToken = async (value: string, expiresAt: number): Promise<void> => {
    const maxAge = Math.max(1, Math.floor((expiresAt - deps.now()) / 1000))
    await deps.cache()?.put(
      cacheKey(),
      new Response(value, { headers: { "cache-control": `max-age=${maxAge}`, [EXPIRES_HEADER]: String(expiresAt) } })
    ).catch(() => undefined)
  }

  /** The installation to mint a token on: the `smithersai` one, else the first GitHub returned. */
  const chooseInstallation = async (jwt: string): Promise<number | undefined> => {
    let response: Response
    try {
      response = await deps.fetch(githubRequest(`${GITHUB_API}/app/installations`, jwt, "GET"))
    } catch {
      log("the GitHub App installation lookup could not reach GitHub")
      return undefined
    }
    if (!response.ok) {
      log(`the GitHub App installation lookup answered ${response.status}`)
      return undefined
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      log("the GitHub App installation lookup answered an unreadable body")
      return undefined
    }
    const installations: ReadonlyArray<unknown> = Array.isArray(body) ? body : []
    const preferred = installations.find((entry) => accountLogin(entry) === PREFERRED_ACCOUNT)
    const id = installationId(preferred ?? installations[0])
    if (id === undefined) {
      log("the GitHub App is not installed on any organization")
      return undefined
    }
    return id
  }

  const exchange = async (id: number, jwt: string): Promise<GithubBearer | undefined> => {
    let response: Response
    try {
      response = await deps.fetch(githubRequest(`${GITHUB_API}/app/installations/${id}/access_tokens`, jwt, "POST"))
    } catch {
      log("the GitHub App installation token exchange could not reach GitHub")
      return undefined
    }
    if (!response.ok) {
      log(`the GitHub App installation token exchange answered ${response.status}`)
      return undefined
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      log("the GitHub App installation token exchange answered an unreadable body")
      return undefined
    }
    const value = record(body)?.token
    if (typeof value !== "string" || value === "") {
      log("the GitHub App installation token exchange answered no token")
      return undefined
    }
    const expiresAt = record(body)?.expires_at
    const stated = typeof expiresAt === "string" ? Date.parse(expiresAt) - 60_000 - deps.now() : Number.NaN
    const lifetime = Number.isFinite(stated) ? Math.min(TOKEN_TTL_MS, stated) : TOKEN_TTL_MS
    if (lifetime > 0) {
      held = { value, expiresAt: deps.now() + lifetime }
      await writeEdgeToken(value, held.expiresAt)
    }
    return { value, renewable: true }
  }

  const mint = async (appId: string, privateKey: string): Promise<GithubBearer | undefined> => {
    const edge = await readEdgeToken()
    if (edge !== undefined) return edge
    let jwt: string
    try {
      jwt = await createAppJwt(appId, privateKey, deps.now())
    } catch {
      // The message could quote the key, so only the cause is named.
      log("the GitHub App private key could not be imported")
      return undefined
    }
    const id = await chooseInstallation(jwt)
    if (id === undefined) return undefined
    return exchange(id, jwt)
  }

  const token = async (env: GithubAppEnv): Promise<GithubBearer | undefined> => {
    const override = env.GITHUB_TOKEN?.trim()
    if (override !== undefined && override !== "") return { value: override, renewable: false }
    const appId = env.SMITHERS_GITHUB_APP_ID?.trim()
    const privateKey = env.SMITHERS_GITHUB_APP_PRIVATE_KEY?.trim()
    if (appId === undefined || appId === "" || privateKey === undefined || privateKey === "") return undefined
    if (held !== undefined && held.expiresAt > deps.now()) return { value: held.value, renewable: true }
    if (deps.now() < failedUntil) return undefined
    pending ??= mint(appId, privateKey)
      .then((bearer) => {
        if (bearer === undefined) failedUntil = deps.now() + FAILURE_TTL_MS
        return bearer
      })
      .finally(() => {
        pending = undefined
      })
    return pending
  }

  const forget = async (): Promise<void> => {
    held = undefined
    failedUntil = 0
    await deps.cache()?.delete?.(cacheKey()).catch(() => undefined)
  }

  return { token, forget }
}
