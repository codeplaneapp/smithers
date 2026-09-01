import * as NodeHttp from "node:http"
import { describe, expect, it } from "vitest"
import * as Secret from "../src/Secret.ts"
import * as SecretProxy from "../src/SecretProxy.ts"

const listen = async (
  handler: NodeHttp.RequestListener
): Promise<{ readonly origin: string; readonly close: () => Promise<void> }> => {
  const server = NodeHttp.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("no upstream port")
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

interface Answer {
  readonly status: number
  readonly body: string
  readonly headers: NodeHttp.IncomingHttpHeaders
}

const get = (url: string): Promise<Answer> =>
  new Promise<Answer>((resolve, reject) => {
    NodeHttp.get(url, (response) => {
      const chunks: Array<Buffer> = []
      response.on("data", (chunk: Buffer) => chunks.push(chunk))
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
          headers: response.headers
        }))
    }).on("error", reject)
  })

describe("secret destination redaction", () => {
  it("never returns the resolved destination URL to the child, in body or headers", async () => {
    const upstream = await listen((request, response) => {
      const echoed = `${request.headers["host"] ?? ""}${request.url ?? ""}`
      response.writeHead(404, { "x-echo-url": `http://${echoed}` })
      response.end(`called http://${echoed}`)
    })
    const destination = `${upstream.origin}/secret-webhook/abc123?token=zzz`
    const vault = SecretProxy.makeVault({ read: () => destination })
    const proxy = await SecretProxy.startProxy(vault)
    try {
      const capability = proxy.urlFor(Secret.Secret("PROXY_DESTINATION_URL"))
      const answer = await get(capability)
      expect(answer.status).toBe(404)
      expect(answer.body).not.toContain("secret-webhook/abc123")
      expect(answer.body).not.toContain(destination)
      expect(answer.body).toContain(capability)
      const echo = answer.headers["x-echo-url"]
      expect(typeof echo === "string" ? echo : "").not.toContain("secret-webhook/abc123")
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })
})

const throughProxy = (
  proxy: SecretProxy.Proxy,
  absoluteUrl: string,
  headers: Record<string, string>
): Promise<Answer> =>
  new Promise<Answer>((resolve, reject) => {
    const endpoint = new URL(proxy.endpoint)
    const outgoing = NodeHttp.request({
      host: endpoint.hostname,
      port: Number(endpoint.port),
      method: "GET",
      path: absoluteUrl,
      headers
    }, (response) => {
      const chunks: Array<Buffer> = []
      response.on("data", (chunk: Buffer) => chunks.push(chunk))
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
          headers: response.headers
        }))
    })
    outgoing.on("error", reject)
    outgoing.end()
  })

describe("secret values a request target cannot carry verbatim", () => {
  const placeholderIn = (vault: SecretProxy.Vault, origin: string) =>
    vault.mint(Secret.HttpSecret(Secret.Secret("PROXY_TEST_TOKEN"), [origin]))

  it("percent-encodes a space-bearing secret into the path instead of throwing", async () => {
    let seenPath = ""
    const upstream = await listen((request, response) => {
      seenPath = request.url ?? ""
      response.end("ok")
    })
    const vault = SecretProxy.makeVault({ read: () => "value with space" })
    const proxy = await SecretProxy.startProxy(vault)
    try {
      const placeholder = placeholderIn(vault, upstream.origin)
      const answer = await throughProxy(proxy, `${upstream.origin}/x/${placeholder}`, {})
      expect(answer.status).toBe(200)
      expect(answer.body).toBe("ok")
      expect(seenPath).toBe("/x/value%20with%20space")
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  it("percent-encodes a non-Latin-1 secret into the path instead of throwing", async () => {
    let seenPath = ""
    const upstream = await listen((request, response) => {
      seenPath = request.url ?? ""
      response.end("ok")
    })
    const vault = SecretProxy.makeVault({ read: () => "héllo" })
    const proxy = await SecretProxy.startProxy(vault)
    try {
      const placeholder = placeholderIn(vault, upstream.origin)
      const answer = await throughProxy(proxy, `${upstream.origin}/x/${placeholder}`, {})
      expect(answer.status).toBe(200)
      expect(seenPath).toBe(`/x/${encodeURIComponent("héllo")}`)
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  it("answers 502, naming the declaration only, when a secret cannot cross a header boundary", async () => {
    const upstream = await listen((_request, response) => response.end("ok"))
    // U+2192 is above the Latin-1 range every HTTP header value is bounded to,
    // so the client rejects the header the substituted value produced.
    const vault = SecretProxy.makeVault({ read: () => "token→value" })
    const proxy = await SecretProxy.startProxy(vault)
    try {
      const placeholder = placeholderIn(vault, upstream.origin)
      const answer = await throughProxy(proxy, `${upstream.origin}/plain`, {
        authorization: `Bearer ${placeholder}`
      })
      expect(answer.status).toBe(502)
      expect(answer.body).toContain("PROXY_TEST_TOKEN")
      expect(answer.body).not.toContain("token→value")
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })
})
