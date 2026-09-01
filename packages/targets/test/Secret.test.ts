import * as NodeHttp from "node:http"
import * as NodeNet from "node:net"
import { describe, expect, it } from "vitest"
import * as Secret from "../src/Secret.ts"
import * as SecretProxy from "../src/SecretProxy.ts"

describe("Secret declarations", () => {
  it("names the environment variable and nothing else", () => {
    expect(Secret.Secret("SMITHERS_CACHE_TOKEN")).toEqual({
      _tag: "Secret",
      env: "SMITHERS_CACHE_TOKEN"
    })
  })

  it("does not carry the value, even when the variable is set", () => {
    process.env["SECRET_DECLARATION_PROBE"] = "super-secret"
    try {
      const declaration = Secret.Secret("SECRET_DECLARATION_PROBE")
      expect(declaration).toEqual({ _tag: "Secret", env: "SECRET_DECLARATION_PROBE" })
      expect(JSON.stringify(declaration)).not.toContain("super-secret")
    } finally {
      delete process.env["SECRET_DECLARATION_PROBE"]
    }
  })

  it("trims and accepts a portable variable name", () => {
    expect(Secret.Secret("  NPM_TOKEN  ").env).toBe("NPM_TOKEN")
    expect(Secret.Secret("_private").env).toBe("_private")
  })

  it("refuses anything that is not an environment variable name", () => {
    expect(() => Secret.Secret("")).toThrow(/environment variable name/)
    expect(() => Secret.Secret("has-dash")).toThrow(/environment variable name/)
    expect(() => Secret.Secret("1LEADING_DIGIT")).toThrow(/environment variable name/)
    expect(() => Secret.Secret("has space")).toThrow(/environment variable name/)
    expect(() => Secret.Secret("A".repeat(Secret.maximumNameLength + 1))).toThrow(/bounded well-formed/)
    expect(() => Secret.Secret(7 as never)).toThrow(/must be a string/)
  })

  it("recognises its own declarations and nothing else", () => {
    expect(Secret.isSecret(Secret.Secret("NPM_TOKEN"))).toBe(true)
    expect(Secret.isSecret({ _tag: "Secret", env: "NPM_TOKEN" })).toBe(true)
    expect(Secret.isSecret({ _tag: "Secret" })).toBe(false)
    expect(Secret.isSecret(null)).toBe(false)
    expect(Secret.isSecret("NPM_TOKEN")).toBe(false)
  })
})

describe("SecretProxy vault", () => {
  const token = Secret.Secret("VAULT_TEST_TOKEN")

  it("mints an unguessable placeholder and reuses it per declaration", () => {
    const vault = SecretProxy.makeVault({ read: () => "real-value" })
    expect(vault.isEmpty()).toBe(true)
    const first = vault.mint(token)
    const second = vault.mint(token)
    expect(first).toBe(second)
    expect(vault.isEmpty()).toBe(false)
    expect(first.startsWith(Secret.placeholderPrefix)).toBe(true)
    expect(first).toHaveLength(Secret.placeholderPrefix.length + Secret.placeholderBytes * 2)
  })

  it("mints a different placeholder per vault, so one run's token is not another's", () => {
    const left = SecretProxy.makeVault({ read: () => "value" }).mint(token)
    const right = SecretProxy.makeVault({ read: () => "value" }).mint(token)
    expect(left).not.toBe(right)
  })

  it("substitutes lazily, reading the host only when a request needs it", () => {
    let reads = 0
    const vault = SecretProxy.makeVault({
      read: () => {
        reads += 1
        return "real-value"
      }
    })
    const placeholder = vault.mint(token)
    expect(reads).toBe(0)
    expect(vault.substitute(`Bearer ${placeholder}`)).toBe("Bearer real-value")
    expect(reads).toBe(1)
  })

  it("leaves text without a placeholder untouched and reads nothing", () => {
    let reads = 0
    const vault = SecretProxy.makeVault({
      read: () => {
        reads += 1
        return "real-value"
      }
    })
    vault.mint(token)
    expect(vault.substitute("nothing to see")).toBe("nothing to see")
    expect(reads).toBe(0)
  })

  it("substitutes nothing when no placeholder was minted", () => {
    const vault = SecretProxy.makeVault({ read: () => "real-value" })
    const foreign = `${Secret.placeholderPrefix}${"a".repeat(64)}`
    expect(vault.substitute(foreign)).toBe(foreign)
  })

  it("refuses to substitute a placeholder this vault never minted", () => {
    const vault = SecretProxy.makeVault({ read: () => "real-value" })
    vault.mint(token)
    // A well-formed placeholder from somewhere else. Substitution is a
    // capability: holding the exact minted string is what earns the value.
    const forged = `${Secret.placeholderPrefix}${"b".repeat(Secret.placeholderBytes * 2)}`
    expect(vault.substitute(forged)).toBe(forged)
  })

  it("fails when the declared secret has no value on this host", () => {
    for (const read of [() => undefined, () => ""]) {
      const vault = SecretProxy.makeVault({ read })
      const placeholder = vault.mint(token)
      expect(() => vault.substitute(placeholder)).toThrow(SecretProxy.SecretUnavailable)
      expect(() => vault.substitute(placeholder)).toThrow(/VAULT_TEST_TOKEN is not set/)
    }
  })

  it("uses a declared public fallback only at substitution time", () => {
    let reads = 0
    const vault = SecretProxy.makeVault({
      read: () => {
        reads += 1
        return undefined
      }
    })
    const placeholder = vault.mint(Secret.Secret("VAULT_FALLBACK", { fallback: "public-value" }))
    expect(reads).toBe(0)
    expect(vault.substitute(placeholder)).toBe("public-value")
    expect(reads).toBe(1)
  })

  it("substitutes header records, single and repeated", () => {
    const vault = SecretProxy.makeVault({ read: () => "real-value" })
    const placeholder = vault.mint(token)
    expect(vault.substituteHeaders({
      authorization: `Bearer ${placeholder}`,
      "x-repeated": [placeholder, "plain"],
      "x-absent": undefined
    })).toEqual({
      authorization: "Bearer real-value",
      "x-repeated": ["real-value", "plain"]
    })
  })

  it("reads process.env by default", () => {
    const vault = SecretProxy.makeVault()
    const placeholder = vault.mint(Secret.Secret("VAULT_DEFAULT_READ"))
    process.env["VAULT_DEFAULT_READ"] = "from-process"
    try {
      expect(vault.substitute(placeholder)).toBe("from-process")
    } finally {
      delete process.env["VAULT_DEFAULT_READ"]
    }
  })
})

/** Sends one request through the proxy and resolves what the upstream saw. */
const throughProxy = async (
  vault: SecretProxy.Vault,
  request: { readonly method: string; readonly headers: Record<string, string>; readonly body?: string }
): Promise<{
  readonly status: number
  readonly headers: NodeHttp.IncomingHttpHeaders
  readonly body: string
  readonly responseBody: string
}> => {
  let seen: { headers: NodeHttp.IncomingHttpHeaders; body: string } | undefined
  const upstream = NodeHttp.createServer((incoming, response) => {
    const chunks: Array<Buffer> = []
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk))
    incoming.on("end", () => {
      seen = { headers: incoming.headers, body: Buffer.concat(chunks).toString("utf8") }
      response.writeHead(200, { "content-type": "text/plain" }).end("upstream-ok")
    })
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const upstreamAddress = upstream.address()
  if (upstreamAddress === null || typeof upstreamAddress === "string") throw new Error("no upstream port")
  const proxy = await SecretProxy.startProxy(vault)
  try {
    const proxyPort = Number(new URL(proxy.endpoint).port)
    const result = await new Promise<{ status: number; responseBody: string }>((resolve, reject) => {
      const outgoing = NodeHttp.request({
        host: "127.0.0.1",
        port: proxyPort,
        method: request.method,
        path: `http://127.0.0.1:${upstreamAddress.port}/target?q=1`,
        headers: request.headers
      }, (response) => {
        const chunks: Array<Buffer> = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            responseBody: Buffer.concat(chunks).toString("utf8")
          }))
      })
      outgoing.on("error", reject)
      outgoing.end(request.body)
    })
    return {
      status: result.status,
      responseBody: result.responseBody,
      headers: seen?.headers ?? {},
      body: seen?.body ?? ""
    }
  } finally {
    await proxy.close()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
}

describe("SecretProxy server", () => {
  const token = Secret.Secret("PROXY_TEST_TOKEN")

  it("binds loopback only", async () => {
    const vault = SecretProxy.makeVault({ read: () => "real-value" })
    const proxy = await SecretProxy.startProxy(vault)
    try {
      expect(proxy.endpoint.startsWith("http://127.0.0.1:")).toBe(true)
    } finally {
      await proxy.close()
    }
  })

  it("turns a secret destination into a loopback capability and resolves it lazily", async () => {
    let requests = 0
    const upstream = NodeHttp.createServer((_request, response) => {
      requests += 1
      response.end("destination-ok")
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const address = upstream.address()
    if (address === null || typeof address === "string") throw new Error("no upstream port")
    let reads = 0
    const destination = `http://127.0.0.1:${address.port}/rpc?network=test`
    const vault = SecretProxy.makeVault({
      read: () => {
        reads += 1
        return destination
      }
    })
    const proxy = await SecretProxy.startProxy(vault)
    try {
      const capability = proxy.urlFor(Secret.Secret("PROXY_DESTINATION_URL"))
      expect(capability).not.toContain(destination)
      expect(new URL(capability).hostname).toBe("127.0.0.1")
      expect(reads).toBe(0)
      const body = await new Promise<string>((resolve, reject) => {
        NodeHttp.get(capability, (response) => {
          const chunks: Array<Buffer> = []
          response.on("data", (chunk: Buffer) => chunks.push(chunk))
          response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
        }).on("error", reject)
      })
      expect(body).toBe("destination-ok")
      expect(requests).toBe(1)
      expect(reads).toBe(1)
    } finally {
      await proxy.close()
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })

  it("replaces the placeholder in request headers on the way out", async () => {
    const vault = SecretProxy.makeVault({ read: () => "real-value" })
    const placeholder = vault.mint(token)
    const result = await throughProxy(vault, {
      method: "GET",
      headers: { authorization: `Bearer ${placeholder}` }
    })
    expect(result.status).toBe(200)
    expect(result.headers["authorization"]).toBe("Bearer real-value")
    expect(result.responseBody).toBe("upstream-ok")
  })

  it("replaces the placeholder in a text request body", async () => {
    const vault = SecretProxy.makeVault({ read: () => "real-value" })
    const placeholder = vault.mint(token)
    const result = await throughProxy(vault, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: placeholder })
    })
    expect(JSON.parse(result.body)).toEqual({ token: "real-value" })
    expect(result.headers["content-length"]).toBe(String(result.body.length))
  })

  it("answers 502 when the declared secret is missing rather than sending a placeholder", async () => {
    const vault = SecretProxy.makeVault({ read: () => undefined })
    const placeholder = vault.mint(token)
    const result = await throughProxy(vault, {
      method: "GET",
      headers: { authorization: `Bearer ${placeholder}` }
    })
    expect(result.status).toBe(502)
    expect(result.responseBody).toMatch(/PROXY_TEST_TOKEN is not set/)
    expect(result.headers["authorization"]).toBeUndefined()
  })

  it("refuses a request that is not in absolute proxy form", async () => {
    const vault = SecretProxy.makeVault({ read: () => "real-value" })
    const proxy = await SecretProxy.startProxy(vault)
    try {
      const port = Number(new URL(proxy.endpoint).port)
      const status = await new Promise<number>((resolve, reject) => {
        const outgoing = NodeHttp.request({ host: "127.0.0.1", port, path: "/relative" }, (response) => {
          response.resume()
          resolve(response.statusCode ?? 0)
        })
        outgoing.on("error", reject)
        outgoing.end()
      })
      expect(status).toBe(400)
    } finally {
      await proxy.close()
    }
  })

  it("answers 502 when the upstream is unreachable", async () => {
    const vault = SecretProxy.makeVault({ read: () => "real-value" })
    const proxy = await SecretProxy.startProxy(vault)
    try {
      const port = Number(new URL(proxy.endpoint).port)
      const status = await new Promise<number>((resolve, reject) => {
        const outgoing = NodeHttp.request({
          host: "127.0.0.1",
          port,
          path: "http://127.0.0.1:1/unreachable"
        }, (response) => {
          response.resume()
          resolve(response.statusCode ?? 0)
        })
        outgoing.on("error", reject)
        outgoing.end()
      })
      expect(status).toBe(502)
    } finally {
      await proxy.close()
    }
  })

  it("rejects an oversized body before buffering or contacting an upstream", async () => {
    const proxy = await SecretProxy.startProxy(SecretProxy.makeVault())
    try {
      const port = Number(new URL(proxy.endpoint).port)
      const status = await new Promise<number>((resolve, reject) => {
        const outgoing = NodeHttp.request({
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "http://127.0.0.1:1/never-contacted",
          headers: { "content-length": String(SecretProxy.maximumRequestBodyBytes + 1) }
        }, (response) => {
          response.resume()
          resolve(response.statusCode ?? 0)
        })
        outgoing.on("error", reject)
        outgoing.end()
      })
      expect(status).toBe(413)
    } finally {
      await proxy.close()
    }
  })

  it("rejects malformed CONNECT authorities and parses bracketed IPv6", async () => {
    expect(SecretProxy.parseConnectAuthority("example.com:443")).toEqual({ host: "example.com", port: 443 })
    expect(SecretProxy.parseConnectAuthority("[::1]:8443")).toEqual({ host: "::1", port: 8443 })
    for (const authority of ["example.com", "example.com:nope", "example.com:0", "example.com:65536", "::1:443"]) {
      expect(SecretProxy.parseConnectAuthority(authority)).toBeUndefined()
    }

    const proxy = await SecretProxy.startProxy(SecretProxy.makeVault())
    try {
      const port = Number(new URL(proxy.endpoint).port)
      const response = await new Promise<string>((resolve, reject) => {
        const socket = NodeNet.connect({ host: "127.0.0.1", port }, () => {
          socket.write("CONNECT example.com:not-a-port HTTP/1.1\r\nHost: example.com\r\n\r\n")
        })
        socket.setEncoding("utf8")
        socket.once("data", resolve)
        socket.once("error", reject)
      })
      expect(response.startsWith("HTTP/1.1 400 Bad Request")).toBe(true)
    } finally {
      await proxy.close()
    }
  })
})
