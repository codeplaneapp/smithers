import { describe, expect, test } from "bun:test"
import { browserFetch, extractReadableText, isPublicAddress } from "./BrowserFetch"

/*
 * The browser tool's hard guards (§2d): https only, public hosts only AFTER
 * DNS resolution (and on every redirect hop), size cap, timeout, no
 * credentials. The resolver and the fetch are honest doubles here.
 */

describe("isPublicAddress", () => {
  test("private, loopback, link-local, and metadata addresses are refused", () => {
    for (
      const ip of [
        "127.0.0.1",
        "127.1.2.3",
        "10.0.0.8",
        "10.255.255.255",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.1.1",
        "169.254.169.254", // the cloud metadata endpoint
        "169.254.0.1",
        "0.0.0.0",
        "100.64.0.1", // CGNAT
        "224.0.0.1", // multicast
        "::1",
        "::",
        "fe80::1",
        "fc00::1",
        "fd12::8",
        "::ffff:127.0.0.1",
        "::ffff:10.0.0.1"
      ]
    ) {
      expect(isPublicAddress(ip)).toBe(false)
    }
  })

  test("public addresses pass", () => {
    for (
      const ip of ["8.8.8.8", "1.1.1.1", "140.82.112.3", "2606:4700::1111", "172.15.0.1", "172.32.0.1", "11.0.0.1"]
    ) {
      expect(isPublicAddress(ip)).toBe(true)
    }
  })
})

const okPage = (body: string, headers: Record<string, string> = {}): Response =>
  new Response(body, { status: 200, headers: { "content-type": "text/html", ...headers } })

describe("browserFetch guards", () => {
  const publicResolver = async () => ["140.82.112.3"]

  test("http is refused outright", async () => {
    const outcome = await browserFetch("http://example.com/", { resolveHost: publicResolver })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain("https")
  })

  test("internal hostnames are refused without resolving", async () => {
    for (const host of ["localhost", "db.internal", "nas.local", "home.lan"]) {
      let resolved = 0
      const outcome = await browserFetch(`https://${host}/`, {
        resolveHost: async () => {
          resolved += 1
          return ["140.82.112.3"]
        }
      })
      expect(outcome.ok).toBe(false)
      expect(resolved).toBe(0)
    }
  })

  test("a public hostname resolving to a private address is refused (the DNS check is after resolution)", async () => {
    const outcome = await browserFetch("https://sneaky.example.com/", {
      resolveHost: async () => ["169.254.169.254"]
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain("private")
  })

  test("a private IP literal target is refused", async () => {
    const outcome = await browserFetch("https://127.0.0.1/admin", { resolveHost: publicResolver })
    expect(outcome.ok).toBe(false)
  })

  /*
   * A URL's hostname keeps IPv6 literals BRACKETED (`[::1]`), and the
   * WHATWG serializer writes IPv4-mapped addresses in hex (`[::ffff:7f00:1]`)
   * — both forms have to reach the guard already normalised, or the loopback
   * and unique-local space is reachable through the tool.
   */
  test("bracketed IPv6 literals are refused, in every notation, and never fetched", async () => {
    for (
      const target of [
        "https://[::1]/",
        "https://[fd00::1]/",
        "https://[fe80::1]/",
        "https://[::ffff:127.0.0.1]/",
        "https://[::ffff:7f00:1]/",
        "https://[::ffff:10.0.0.1]/",
        "https://[::]/"
      ]
    ) {
      let fetched = 0
      const outcome = await browserFetch(target, {
        resolveHost: publicResolver,
        fetchImpl: async () => {
          fetched += 1
          return okPage("<p>x</p>")
        }
      })
      expect({ target, ok: outcome.ok, fetched }).toEqual({ target, ok: false, fetched: 0 })
    }
  })

  test("a public IPv6 literal target is allowed", async () => {
    const outcome = await browserFetch("https://[2606:4700::1111]/", {
      resolveHost: publicResolver,
      fetchImpl: async () => okPage("<p>ok</p>")
    })
    expect(outcome.ok).toBe(true)
  })

  test("a hostname resolving to a bracket-free private IPv6 address is refused", async () => {
    const outcome = await browserFetch("https://sneaky.example.com/", {
      resolveHost: async () => ["fd00::1"]
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain("private")
  })

  test("a redirect into a private host is refused on the hop", async () => {
    const outcome = await browserFetch("https://example.com/", {
      resolveHost: async (hostname) => (hostname === "example.com" ? ["140.82.112.3"] : ["10.0.0.8"]),
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://internal.example.com/" } })
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain("private")
  })

  test("pins each request to the address approved for that redirect hop", async () => {
    const connected: Array<string> = []
    const outcome = await browserFetch("https://example.com/", {
      resolveHost: async (hostname) => hostname === "example.com" ? ["203.0.113.10"] : ["203.0.113.11"],
      fetchImpl: async (_url, _init, address) => {
        connected.push(address)
        return connected.length === 1
          ? new Response(null, { status: 302, headers: { location: "https://next.example.com/" } })
          : okPage("<p>ok</p>")
      }
    })
    expect(outcome.ok).toBe(true)
    expect(connected).toEqual(["203.0.113.10", "203.0.113.11"])
  })

  test("fails closed instead of falling back to a second hostname lookup", async () => {
    const outcome = await browserFetch("https://example.com/", { resolveHost: publicResolver })
    expect(outcome).toEqual({ ok: false, message: "Secure pinned egress is unavailable for the browser tool." })
  })

  test("a readable page returns text, the final URL, the status — and frameability", async () => {
    const outcome = await browserFetch("https://example.com/", {
      resolveHost: publicResolver,
      fetchImpl: async () =>
        okPage(
          "<html><head><style>body{color:red}</style></head><body><h1>Hello</h1><script>evil()</script> there</body></html>"
        )
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.status).toBe(200)
      expect(outcome.finalUrl).toBe("https://example.com/")
      expect(outcome.text).toBe("Hello there")
      expect(outcome.frameable).toBe(true)
    }
  })

  test("X-Frame-Options and CSP frame-ancestors mark the page unframeable, honestly", async () => {
    const xfo = await browserFetch("https://example.com/", {
      resolveHost: publicResolver,
      fetchImpl: async () => okPage("<p>x</p>", { "x-frame-options": "DENY" })
    })
    expect(xfo.ok).toBe(true)
    if (xfo.ok) {
      expect(xfo.frameable).toBe(false)
      expect(xfo.blockReason).toContain("X-Frame-Options")
    }
    const csp = await browserFetch("https://example.com/", {
      resolveHost: publicResolver,
      fetchImpl: async () =>
        okPage("<p>x</p>", { "content-security-policy": "default-src 'self'; frame-ancestors 'none'" })
    })
    expect(csp.ok).toBe(true)
    if (csp.ok) expect(csp.frameable).toBe(false)
    // frame-ancestors is an ALLOWLIST: a list of named origins does not
    // include this app, so the card must say so rather than frame a blank.
    const named = await browserFetch("https://example.com/", {
      resolveHost: publicResolver,
      fetchImpl: async () =>
        okPage("<p>x</p>", { "content-security-policy": "frame-ancestors https://partner.example.com" })
    })
    expect(named.ok).toBe(true)
    if (named.ok) {
      expect(named.frameable).toBe(false)
      expect(named.blockReason).toContain("frame-ancestors")
    }
    // A directive that admits any origin still frames.
    const wildcard = await browserFetch("https://example.com/", {
      resolveHost: publicResolver,
      fetchImpl: async () => okPage("<p>x</p>", { "content-security-policy": "frame-ancestors *" })
    })
    expect(wildcard.ok).toBe(true)
    if (wildcard.ok) expect(wildcard.frameable).toBe(true)
  })

  test("the request carries no credentials and the declared user-agent", async () => {
    let seen: RequestInit | undefined
    await browserFetch("https://example.com/", {
      resolveHost: publicResolver,
      fetchImpl: async (_input, init) => {
        seen = init
        return okPage("<p>x</p>")
      }
    })
    const headers = new Headers(seen?.headers)
    expect(headers.get("user-agent")).toBe("smithers-browser")
    expect(headers.get("cookie")).toBeNull()
    expect(headers.get("authorization")).toBeNull()
  })

  test("the size cap truncates an oversized page", async () => {
    const big = `<p>${"x".repeat(2 * 1024 * 1024)}</p>`
    const outcome = await browserFetch("https://example.com/", {
      resolveHost: publicResolver,
      fetchImpl: async () => okPage(big)
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.text.length).toBeLessThanOrEqual(20_000)
  })

  test("an unreachable host is an honest failure, never a throw", async () => {
    const outcome = await browserFetch("https://example.com/", {
      resolveHost: publicResolver,
      fetchImpl: async () => {
        throw new Error("connection refused")
      }
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok === false) expect(outcome.message).toContain("connection refused")
  })
})

describe("extractReadableText", () => {
  test("strips scripts, styles, and tags; decodes entities; collapses whitespace", () => {
    expect(extractReadableText("<style>a{}</style><script>b()</script><h1>Hi &amp; bye</h1>  <p>there</p>")).toBe(
      "Hi & bye there"
    )
  })
})
