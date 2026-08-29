/*
 * The browser tool's server half (Wave 10, §2d): fetch-and-extract, not a
 * session. One isomorphic handler shared by the deployed product Worker and
 * the vite dev boundary, with the DNS resolver injected (workerd resolves
 * over DNS-over-HTTPS; the dev server uses node:dns). Hard guards: https
 * only, public hosts only (validated AFTER DNS resolution, on every redirect
 * hop), a size cap, a timeout, no cookies/credentials, and a declared
 * user-agent. The readable text, the final URL, the status, and whether the
 * page may be framed come back; the transcript act line stays one line
 * ("Smithers read <host>") — the raw payload never enters the conversation.
 */

export const BROWSER_FETCH_MAX_BYTES = 1024 * 1024
export const BROWSER_FETCH_TIMEOUT_MS = 10_000
export const BROWSER_FETCH_MAX_TEXT = 20_000
const MAX_REDIRECTS = 3

export interface BrowserFetchSuccess {
  readonly ok: true
  readonly status: number
  readonly finalUrl: string
  readonly contentType: string
  readonly text: string
  /** Whether the app may embed the page in an iframe card. */
  readonly frameable: boolean
  /** Why framing is refused, when it is (X-Frame-Options / CSP frame-ancestors). */
  readonly blockReason: string | null
}

export interface BrowserFetchFailure {
  readonly ok: false
  readonly message: string
}

export type BrowserFetchOutcome = BrowserFetchSuccess | BrowserFetchFailure

export type ResolveHost = (hostname: string) => Promise<ReadonlyArray<string>>

const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain"])

const isBlockedHostname = (hostname: string): boolean => {
  const lower = hostname.toLowerCase()
  if (BLOCKED_HOSTNAMES.has(lower)) return true
  return (
    lower.endsWith(".internal") ||
    lower.endsWith(".local") ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".home.arpa") ||
    lower.endsWith(".lan")
  )
}

const parseIpv4 = (ip: string): Array<number> | undefined => {
  const parts = ip.split(".")
  if (parts.length !== 4) return undefined
  const octets = parts.map((part) => Number(part))
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined
  if (parts.some((part) => !/^\d{1,3}$/.test(part))) return undefined
  return octets
}

/*
 * A URL's `hostname` keeps IPv6 literals bracketed (`[::1]`) and may carry a
 * zone id — strip both before judging, or every bracketed form walks straight
 * past the guard.
 */
const normalizeIpLiteral = (raw: string): string => {
  const trimmed = raw.trim()
  const unbracketed = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed
  const zone = unbracketed.indexOf("%")
  return zone === -1 ? unbracketed : unbracketed.slice(0, zone)
}

/** The IPv4 inside an IPv4-mapped IPv6 address, in dotted (`::ffff:127.0.0.1`) or hex (`::ffff:7f00:1`) form. */
const mappedIpv4 = (rest: string): string | undefined => {
  if (parseIpv4(rest) !== undefined) return rest
  const groups = rest.split(":")
  if (groups.length !== 2) return undefined
  const high = groups[0] ?? ""
  const low = groups[1] ?? ""
  if (!/^[0-9a-f]{1,4}$/.test(high) || !/^[0-9a-f]{1,4}$/.test(low)) return undefined
  const a = Number.parseInt(high, 16)
  const b = Number.parseInt(low, 16)
  return `${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`
}

/** Is one IPv4/IPv6 literal a public, routable address a server-side fetch may target? */
export const isPublicAddress = (raw: string): boolean => {
  const ip = normalizeIpLiteral(raw)
  const v4 = parseIpv4(ip)
  if (v4 !== undefined) {
    const [a, b] = v4 as [number, number, number, number]
    if (a === 0 || a === 10 || a === 127) return false
    if (a === 169 && b === 254) return false // link-local, incl. 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 100 && b >= 64 && b <= 127) return false // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return false // benchmark net
    if (a >= 224) return false // multicast + reserved
    return true
  }
  const lower = ip.toLowerCase()
  if (!lower.includes(":")) return false // not an address form this guard understands
  if (lower.startsWith("::ffff:")) {
    // IPv4-mapped IPv6: judge the embedded v4 address, in either notation.
    const embedded = mappedIpv4(lower.slice(7))
    return embedded === undefined ? false : isPublicAddress(embedded)
  }
  /*
   * Every other IPv6 form is judged by default-deny: only global unicast
   * (2000::/3) is public, routable space. That refuses ::, ::1, the
   * IPv4-compatible ::7f00:1 forms, fc00::/7 unique-local, fe80::/10
   * link-local, and ff00::/8 multicast without enumerating them — a form
   * this guard does not recognise is never treated as public.
   */
  const head = lower.split(":")[0] ?? ""
  if (!/^[0-9a-f]{1,4}$/.test(head)) return false // "" for every "::…" form
  const first = Number.parseInt(head, 16)
  return first >= 0x2000 && first <= 0x3fff
}

const guardTarget = async (
  url: URL,
  resolveHost: ResolveHost
): Promise<BrowserFetchFailure | { readonly addresses: ReadonlyArray<string> }> => {
  if (url.protocol !== "https:") {
    return { ok: false, message: "Only https:// pages can be read." }
  }
  const hostname = url.hostname
  if (hostname === "" || isBlockedHostname(hostname)) {
    return { ok: false, message: "That address points at a private host, which the browser tool never reads." }
  }
  if (parseIpv4(hostname) !== undefined || hostname.includes(":")) {
    if (!isPublicAddress(hostname)) {
      return { ok: false, message: "That address points at a private host, which the browser tool never reads." }
    }
    return { addresses: [normalizeIpLiteral(hostname)] }
  }
  let addresses: ReadonlyArray<string>
  try {
    addresses = await resolveHost(hostname)
  } catch {
    return { ok: false, message: `The host ${hostname} could not be resolved.` }
  }
  if (addresses.length === 0) {
    return { ok: false, message: `The host ${hostname} could not be resolved.` }
  }
  for (const address of addresses) {
    if (!isPublicAddress(address)) {
      return { ok: false, message: "That address resolves to a private host, which the browser tool never reads." }
    }
  }
  return { addresses }
}

/** Pull the readable text out of an HTML page: no scripts, no styles, no tags. */
export const extractReadableText = (html: string): string => {
  const withoutBlocks = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
  const withoutTags = withoutBlocks.replace(/<[^>]*>/g, " ")
  const decoded = withoutTags
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
  return decoded.replace(/\s+/g, " ").trim().slice(0, BROWSER_FETCH_MAX_TEXT)
}

/** May this response's page be framed by the app? XFO and CSP frame-ancestors answer. */
const frameability = (headers: Headers): { frameable: boolean; blockReason: string | null } => {
  const xfo = headers.get("x-frame-options")
  if (xfo !== null) {
    const value = xfo.toLowerCase()
    if (value.includes("deny") || value.includes("sameorigin")) {
      return { frameable: false, blockReason: `The site refuses embedding (X-Frame-Options: ${xfo.trim()}).` }
    }
  }
  const csp = headers.get("content-security-policy")
  if (csp !== null) {
    const ancestors = /frame-ancestors\s+([^;]+)/i.exec(csp)?.[1]?.trim()
    if (ancestors !== undefined) {
      /*
       * frame-ancestors is an allowlist of parents. Unless it admits ANY
       * origin, this app is not on it and the iframe would render blank —
       * so the card says what happened instead (§2d′: never a silent
       * blank). A named-origin list is reported as refusing embedding.
       */
      const tokens = ancestors.split(/\s+/).filter((token) => token !== "")
      const admitsAnyOrigin = tokens.some(
        (token) => token === "*" || token === "*:*" || token === "https:" || token === "http:" || token === "https://*"
      )
      if (!admitsAnyOrigin) {
        return {
          frameable: false,
          blockReason: `The site refuses embedding (Content-Security-Policy frame-ancestors ${ancestors}).`
        }
      }
    }
  }
  return { frameable: true, blockReason: null }
}

const readCapped = async (body: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = body.getReader()
  const chunks: Array<Uint8Array> = []
  let received = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    received += value.byteLength
    chunks.push(value)
    if (received >= BROWSER_FETCH_MAX_BYTES) {
      await reader.cancel("size cap").catch(() => {})
      break
    }
  }
  const merged = new Uint8Array(Math.min(received, BROWSER_FETCH_MAX_BYTES))
  let offset = 0
  for (const chunk of chunks) {
    const slice = chunk.subarray(0, Math.min(chunk.byteLength, merged.byteLength - offset))
    merged.set(slice, offset)
    offset += slice.byteLength
    if (offset >= merged.byteLength) break
  }
  return new TextDecoder().decode(merged)
}

export interface BrowserFetchDeps {
  readonly resolveHost: ResolveHost
  /**
   * Connects to `address` while preserving the URL hostname for Host and TLS
   * certificate/SNI verification. An ordinary hostname-based fetch is not a
   * valid implementation because it would perform a second DNS lookup.
   */
  readonly fetchImpl?: (input: string, init: RequestInit, address: string) => Promise<Response>
  readonly timeoutMs?: number
}

/** Fetch-and-extract one page under the browser tool's hard guards. */
export const browserFetch = async (
  rawUrl: string,
  deps: BrowserFetchDeps
): Promise<BrowserFetchOutcome> => {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, message: "That is not a URL I can read." }
  }
  const timeoutMs = deps.timeoutMs ?? BROWSER_FETCH_TIMEOUT_MS

  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const guarded = await guardTarget(current, deps.resolveHost)
    if ("ok" in guarded) return guarded
    if (deps.fetchImpl === undefined) {
      return { ok: false, message: "Secure pinned egress is unavailable for the browser tool." }
    }
    const address = guarded.addresses[0]!
    const timeout = AbortSignal.timeout(timeoutMs)
    let response: Response
    try {
      response = await deps.fetchImpl(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal: timeout,
        headers: {
          "user-agent": "smithers-browser",
          accept: "text/html,application/xhtml+xml,text/plain,text/markdown;q=0.8,*/*;q=0.5"
        }
      }, address)
    } catch (error) {
      const timedOut = timeout.aborted
      return {
        ok: false,
        message: timedOut
          ? `Reading ${current.host} took too long and was stopped.`
          : `Reading ${current.host} failed: ${error instanceof Error ? error.message : "unknown error"}`
      }
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location")
      await response.body?.cancel()
      if (location === null) {
        return { ok: false, message: `The page answered HTTP ${response.status} with nowhere to go.` }
      }
      if (hop === MAX_REDIRECTS) return { ok: false, message: "The page redirected too many times." }
      try {
        current = new URL(location, current)
      } catch {
        return { ok: false, message: "The page redirected somewhere unreadable." }
      }
      continue
    }
    const contentType = response.headers.get("content-type") ?? ""
    const { frameable, blockReason } = frameability(response.headers)
    if (response.body === null) {
      return {
        ok: true,
        status: response.status,
        finalUrl: current.toString(),
        contentType,
        text: "",
        frameable,
        blockReason
      }
    }
    const raw = await readCapped(response.body)
    const text = contentType.includes("html") || contentType.includes("xhtml")
      ? extractReadableText(raw)
      : raw.slice(0, BROWSER_FETCH_MAX_TEXT)
    return {
      ok: true,
      status: response.status,
      finalUrl: current.toString(),
      contentType,
      text,
      frameable,
      blockReason
    }
  }
  return { ok: false, message: "The page redirected too many times." }
}

/** The workerd DNS resolver: DNS-over-HTTPS, since workerd exposes no dns module. */
export const resolveHostOverHttps: ResolveHost = async (hostname) => {
  const query = async (type: string): Promise<Array<string>> => {
    const response = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
      { headers: { accept: "application/dns-json" } }
    )
    if (!response.ok) {
      await response.body?.cancel()
      return []
    }
    const body = (await response.json().catch(() => undefined)) as
      | { Answer?: Array<{ type?: unknown; data?: unknown }> }
      | undefined
    const wanted = type === "A" ? 1 : 28
    return (body?.Answer ?? [])
      .filter((answer) => answer.type === wanted && typeof answer.data === "string")
      .map((answer) => answer.data as string)
  }
  const [a, aaaa] = await Promise.all([query("A"), query("AAAA")])
  return [...a, ...aaaa]
}

/** The JSON body the /api/tools/browser-fetch route answers with. */
export const browserFetchResponseBody = (
  outcome: BrowserFetchOutcome
): Record<string, unknown> =>
  outcome.ok
    ? {
      status: outcome.status,
      finalUrl: outcome.finalUrl,
      contentType: outcome.contentType,
      text: outcome.text,
      frameable: outcome.frameable,
      blockReason: outcome.blockReason
    }
    : { status: "error", message: outcome.message }
