/**
 * Placeholder minting and outbound substitution for declared secrets.
 *
 * `Secret.ts` declares which environment variable holds a value. This module
 * is the execution half: it mints the placeholder a target actually receives,
 * and it replaces that placeholder with the real value on the way out.
 *
 * Two substitution seams exist, and they cover different things.
 *
 * 1. **In-process.** {@link Vault.substitute} is applied by every outbound
 *    request smithers build itself makes, which today means the remote-cache client.
 *    This seam is complete: the credential exists only inside the CLI process,
 *    for the duration of one request.
 * 2. **Child processes.** {@link startProxy} runs a local HTTP proxy a spawned
 *    tool is pointed at. Plain-HTTP requests through it are rewritten. HTTPS is
 *    tunnelled with `CONNECT` and is **not** rewritten, because rewriting an
 *    encrypted stream requires terminating TLS with a certificate authority the
 *    child trusts, which this module does not create. A tool that must send a
 *    real credential over HTTPS is therefore not yet covered; see the smithers build
 *    DESIGN.md limitations section rather than assuming the placeholder works.
 *
 * The value is read from the host environment at substitution time, never
 * cached in the vault. A run that plans without executing, or that never
 * reaches the request needing a secret, never reads the variable at all.
 *
 * @since 0.1.0
 */
import { randomBytes } from "node:crypto"
import * as NodeHttp from "node:http"
import * as NodeNet from "node:net"
import type * as Secret from "./Secret.ts"
import { placeholderPattern, placeholderPrefix } from "./Secret.ts"

/**
 * Raised when a declared secret has no value on this host.
 *
 * Failing is the only safe answer. Substituting nothing would send the
 * placeholder itself to a remote service, which reads as a malformed
 * credential at best and is recorded in someone else's logs at worst.
 *
 * @category errors
 * @since 0.1.0
 */
export class SecretUnavailable extends Error {
  /** The environment variable that carries no value. */
  readonly env: string
  constructor(env: string) {
    super(`the declared secret ${env} is not set on this host`)
    this.name = "SecretUnavailable"
    this.env = env
  }
}

/**
 * Parses and validates an HTTP CONNECT authority.
 *
 * @category parsing
 * @since 0.1.0
 */
export const parseConnectAuthority = (
  authority: string
): { readonly host: string; readonly port: number } | undefined => {
  let host: string
  let rawPort: string
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]")
    if (close <= 1 || authority[close + 1] !== ":" || NodeNet.isIP(authority.slice(1, close)) !== 6) {
      return undefined
    }
    host = authority.slice(1, close)
    rawPort = authority.slice(close + 2)
  } else {
    const separator = authority.lastIndexOf(":")
    if (separator <= 0 || authority.indexOf(":") !== separator) return undefined
    host = authority.slice(0, separator)
    rawPort = authority.slice(separator + 1)
  }
  if (/[/\\\s\u0000-\u001f\u007f]/.test(host) || !/^\d+$/.test(rawPort)) return undefined
  const port = Number(rawPort)
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? { host, port } : undefined
}

/**
 * Reads one host environment variable.
 *
 * @category models
 * @since 0.1.0
 */
export type Read = (name: string) => string | undefined

/**
 * Mints placeholders and substitutes them lazily.
 *
 * @category models
 * @since 0.1.0
 */
export interface Vault {
  /**
   * Mints the placeholder that stands in for one declared secret.
   *
   * Minting twice for the same declaration returns the same placeholder within
   * one vault, so a target that declares a secret in two attrs sees one value.
   */
  readonly mint: (secret: Secret.Secret) => string
  /** Replaces every known placeholder in `text` with its real value. */
  readonly substitute: (text: string) => string
  /** Replaces every known placeholder in a header record. */
  readonly substituteHeaders: (
    headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>
  ) => Record<string, string | Array<string>>
  /** Whether any placeholder has been minted. */
  readonly isEmpty: () => boolean
}

/**
 * Creates a vault.
 *
 * `read` exists so tests can supply an environment without mutating the
 * process, and so a future host layer can supply one that is not
 * `process.env`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeVault = (options: { readonly read?: Read | undefined } = {}): Vault => {
  const read: Read = options.read ?? ((name) => process.env[name])
  const byEnv = new Map<string, string>()
  const byPlaceholder = new Map<string, string>()
  const mint = (secret: Secret.Secret): string => {
    const existing = byEnv.get(secret.env)
    if (existing !== undefined) return existing
    const placeholder = `${placeholderPrefix}${randomBytes(32).toString("hex")}`
    byEnv.set(secret.env, placeholder)
    byPlaceholder.set(placeholder, secret.env)
    return placeholder
  }
  const substitute = (text: string): string => {
    if (byPlaceholder.size === 0 || !text.includes(placeholderPrefix)) return text
    return text.replace(placeholderPattern, (match) => {
      const env = byPlaceholder.get(match)
      // An unminted placeholder is not ours. Leaving it untouched is what
      // keeps substitution a capability: a target cannot obtain a value by
      // spelling a placeholder it was never given.
      if (env === undefined) return match
      const value = read(env)
      if (value === undefined || value === "") throw new SecretUnavailable(env)
      return value
    })
  }
  return {
    mint,
    substitute,
    substituteHeaders: (headers) => {
      const output: Record<string, string | Array<string>> = {}
      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) continue
        output[name] = typeof value === "string" ? substitute(value) : value.map(substitute)
      }
      return output
    },
    isEmpty: () => byPlaceholder.size === 0
  }
}

/**
 * A running substitution proxy.
 *
 * @category models
 * @since 0.1.0
 */
export interface Proxy {
  /** The loopback endpoint a child is pointed at. */
  readonly endpoint: string
  /** Stops the proxy and drops every in-flight connection. */
  readonly close: () => Promise<void>
}

/** Hop-by-hop headers a proxy must not forward. */
const hopByHop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
])

/**
 * Starts a loopback HTTP proxy that substitutes placeholders on the way out.
 *
 * The proxy binds `127.0.0.1` on an ephemeral port so nothing outside the host
 * can reach it. Requests arrive in absolute form, as an HTTP proxy requires.
 * Request headers and request bodies are substituted; responses are forwarded
 * unchanged.
 *
 * `CONNECT` is tunnelled byte for byte. The bytes are already encrypted by the
 * time they arrive, so no substitution is possible without terminating TLS.
 *
 * @category constructors
 * @since 0.1.0
 */
export const startProxy = (vault: Vault): Promise<Proxy> =>
  new Promise((resolve, reject) => {
    const server = NodeHttp.createServer((request, response) => {
      let target: URL
      try {
        target = new URL(request.url ?? "")
      } catch {
        response.writeHead(400).end("proxy requires an absolute request URL")
        return
      }
      if (target.protocol !== "http:") {
        response.writeHead(400).end("proxy forwards http requests only")
        return
      }
      const chunks: Array<Buffer> = []
      request.on("data", (chunk: Buffer) => chunks.push(chunk))
      request.on("end", () => {
        let headers: Record<string, string | Array<string>>
        let body: Buffer
        try {
          const forwarded: Record<string, string | Array<string> | undefined> = {}
          for (const [name, value] of Object.entries(request.headers)) {
            if (!hopByHop.has(name.toLowerCase())) forwarded[name] = value
          }
          headers = vault.substituteHeaders(forwarded)
          const raw = Buffer.concat(chunks)
          const text = raw.toString("utf8")
          // Substituting a body only makes sense when it is text that survives
          // a round trip. Binary bodies are forwarded untouched.
          const substituted = Buffer.byteLength(text, "utf8") === raw.byteLength
            ? Buffer.from(vault.substitute(text), "utf8")
            : raw
          body = substituted
          if (body.byteLength !== raw.byteLength) headers["content-length"] = String(body.byteLength)
        } catch (cause) {
          const message = cause instanceof SecretUnavailable ? cause.message : "secret substitution failed"
          response.writeHead(502).end(message)
          return
        }
        const upstream = NodeHttp.request(
          {
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port === "" ? 80 : target.port,
            method: request.method,
            path: `${target.pathname}${target.search}`,
            headers
          },
          (upstreamResponse) => {
            response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
            upstreamResponse.pipe(response)
          }
        )
        upstream.on("error", () => {
          if (!response.headersSent) response.writeHead(502)
          response.end("upstream request failed")
        })
        upstream.end(body)
      })
    })
    server.on("connect", (request, socket: NodeNet.Socket, head: Buffer) => {
      const authority = parseConnectAuthority(request.url ?? "")
      if (authority === undefined) {
        socket.end("HTTP/1.1 400 Bad Request\r\n\r\n")
        return
      }
      let upstream: NodeNet.Socket
      let connected = false
      try {
        upstream = NodeNet.connect(authority, () => {
          connected = true
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
          if (head.byteLength > 0) upstream.write(head)
          socket.pipe(upstream)
          upstream.pipe(socket)
        })
      } catch {
        socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n")
        return
      }
      const drop = () => {
        if (!connected && !socket.destroyed) socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n")
        else socket.destroy()
        upstream.destroy()
      }
      upstream.once("error", drop)
      socket.once("error", drop)
      socket.once("close", () => upstream.destroy())
      upstream.once("close", () => socket.destroy())
    })
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close()
        reject(new Error("secret proxy did not bind a loopback port"))
        return
      }
      resolve({
        endpoint: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections()
            server.close(() => done())
          })
      })
    })
  })
