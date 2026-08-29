import { describe, expect, test } from "bun:test"
import { AppBootstrapSchema } from "smithers-shared/AppBootstrap"
import worker, { TurnCancelRegistry } from "./index"
import type { TurnCancelNamespace, TurnCancelStorage, WorkerEnv } from "./index"

const assetsEnv = (html = "<html><body>smithers</body></html>"): WorkerEnv => ({
  ASSETS: { fetch: async () => new Response(html, { status: 200 }) }
})

const turnBody = {
  runId: "run-1",
  messages: [{ role: "user", content: "Hello who are you" }],
  instructions: "Be brief."
}

const ndjsonUpstream = (lines: ReadonlyArray<unknown>): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        for (const line of lines) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`))
        controller.close()
      }
    }),
    { status: 200, headers: { "content-type": "application/x-ndjson" } }
  )

const post = (path: string, body: unknown): Request =>
  new Request(`https://mvp.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  })

describe("smithers mvp worker", () => {
  test("serves the SPA with the cross-origin isolation headers OPFS needs", async () => {
    const response = await worker.fetch(new Request("https://mvp.test/"), assetsEnv())
    expect(response.status).toBe(200)
    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin")
    expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp")
    expect(await response.text()).toContain("smithers")
  })

  test("describes the cloud runtime before the SPA selects adapters", async () => {
    const response = await worker.fetch(
      new Request("https://mvp.test/api/bootstrap"),
      {
        ...assetsEnv(),
        SMITHERS_BUILD_SHA: "build-abc",
        SMITHERS_CHAT_AUTH_TOKEN: "chat-token",
        IDENTITY_UPSTREAM_URL: "https://identity.test",
        SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test",
        BILLING_CHECKOUT_ENABLED: "1"
      }
    )

    expect(response.status).toBe(200)
    expect(AppBootstrapSchema.parse(await response.json())).toEqual({
      apiVersion: 1,
      host: "cloud",
      version: "1.0.0",
      buildSha: "build-abc",
      capabilities: ["agent", "identity", "jjhub", "billing.checkout"],
      authFlow: "redirect",
      sandbox: null
    })
  })

  test("rejects a turn body over the 1 MB cap with 413", async () => {
    const response = await worker.fetch(
      post("/api/agent/turn", { ...turnBody, instructions: "x".repeat(1100 * 1024) }),
      assetsEnv()
    )
    expect(response.status).toBe(413)
  })

  test("stops reading a chunked turn body as soon as it crosses the cap", async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(700 * 1024))
        controller.enqueue(new Uint8Array(700 * 1024))
      },
      cancel() {
        cancelled = true
      }
    })
    const response = await worker.fetch(
      new Request("https://mvp.test/api/agent/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body
      }),
      assetsEnv()
    )
    expect(response.status).toBe(413)
    expect(cancelled).toBe(true)
  })

  /**
   * The cap is a byte cap: a body of multi-byte characters encodes to up to 4x its
   * string length, so a UTF-16 `.length` check would wave a 2 MB body through.
   */
  /*
   * Repro apps/ui/canary-repros/chat/4.13: every model call replays the whole
   * transcript, so an over-cap body is a fact about the CONVERSATION. The turn
   * seam said so; the relay — which carries every turn now that the browser
   * chain is the only backend — answered the bare "Request body is too large."
   * Both doors say the same sentence, and it names the way out.
   */
  test("both model doors answer an over-cap transcript with the same actionable 413", async () => {
    const oversize = { role: "user", content: "x".repeat(1100 * 1024) }
    for (
      const request of [
        post("/api/agent/turn", { ...turnBody, messages: [oversize] }),
        post("/api/model/stream", { messages: [oversize] })
      ]
    ) {
      const response = await worker.fetch(request, assetsEnv())
      expect(response.status).toBe(413)
      const body = (await response.json()) as { message: string }
      expect(body.message).toContain("This conversation has grown too long")
      expect(body.message).toContain("Start a new conversation")
      expect(body.message).not.toBe("Request body is too large.")
    }
  })

  test("measures the 1 MB cap in bytes, not UTF-16 code units", async () => {
    // 768k x U+00E9 = 768k code units but 1.5 MB of UTF-8.
    const instructions = "é".repeat(768 * 1024)
    expect(instructions.length).toBeLessThan(1024 * 1024)
    expect(new TextEncoder().encode(instructions).byteLength).toBeGreaterThan(1024 * 1024)
    const response = await worker.fetch(
      post("/api/agent/turn", { ...turnBody, instructions }),
      assetsEnv()
    )
    expect(response.status).toBe(413)
  })

  /*
   * Repro apps/ui/canary-repros/chat/4.13: every turn replays the whole
   * transcript, so at the old 64 KB cap seven long answers wedged the seam
   * permanently — and `/clear`, which runs a model turn of its own to decide
   * what to keep, hit the same refusal, so the conversation had no in-app
   * escape. The measured wedge was ~64 KB of rendered transcript.
   */
  test("accepts a transcript the size that wedged the seam at the old cap", async () => {
    const upstream: Array<string> = []
    const env: WorkerEnv = { ...assetsEnv(), SMITHERS_CHAT_URL: "https://upstream.test/chat" }
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown) => {
      upstream.push(String(input))
      return new Response("{\"type\":\"done\"}\n", { headers: { "content-type": "application/x-ndjson" } })
    }) as typeof fetch
    try {
      const messages = Array.from({ length: 14 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: "x".repeat(6 * 1024)
      }))
      const response = await worker.fetch(
        post("/api/agent/turn", { ...turnBody, runId: "run-4-13-wedge", messages }),
        env
      )
      expect(response.status).toBe(200)
      // Drain so the per-isolate active-turn entry settles for later tests.
      await response.text()
      expect(upstream).toEqual(["https://upstream.test/chat"])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  /* A refusal a reader can act on: which thing is too long, and the way out. */
  test("the oversize refusal names the conversation and the way out", async () => {
    const response = await worker.fetch(
      post("/api/agent/turn", { ...turnBody, instructions: "x".repeat(1100 * 1024) }),
      assetsEnv()
    )
    const body = (await response.json()) as { message: string }
    expect(body.message).toContain("conversation")
    expect(body.message).toContain("Start a new conversation")
    expect(body.message).not.toBe("Request body is too large.")
  })

  /*
   * Repro apps/ui/canary-repros/honesty/24.3: the seam pasted the upstream's
   * body onto a fixed prefix, so a provider's rate-limit envelope arrived in
   * the transcript as raw JSON. The status is classified here rather than
   * trusting every upstream to write prose for a human.
   */
  test("a rate-limited upstream becomes a rate-limit sentence, not raw provider JSON", async () => {
    const env: WorkerEnv = { ...assetsEnv(), SMITHERS_CHAT_URL: "https://upstream.test/chat" }
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "rate_limit_error",
            message: "Number of request tokens has exceeded your per-minute rate limit"
          }
        }),
        { status: 429, headers: { "content-type": "application/json", "retry-after": "45" } }
      )) as unknown as typeof fetch
    try {
      const response = await worker.fetch(post("/api/agent/turn", { ...turnBody, runId: "run-429" }), env)
      expect(response.status).toBe(429)
      const body = (await response.json()) as { message: string }
      expect(body.message).toContain("rate-limiting")
      expect(body.message).toContain("Nothing was charged")
      expect(body.message).toContain("45 seconds")
      expect(body.message).not.toContain("rate_limit_error")
      expect(body.message).not.toContain("{")
    } finally {
      globalThis.fetch = original
    }
  })

  /*
   * The §24.4 shape from the same repro: a Worker 500 whose body is a
   * Cloudflare HTML page rendered as markup in the transcript.
   */
  test("an upstream HTML error page never reaches the message", async () => {
    const env: WorkerEnv = { ...assetsEnv(), SMITHERS_CHAT_URL: "https://upstream.test/chat" }
    const original = globalThis.fetch
    globalThis.fetch =
      (async () =>
        new Response("<!DOCTYPE html><html><body>Error 1101 Worker threw exception</body></html>", {
          status: 500,
          headers: { "content-type": "text/html" }
        })) as unknown as typeof fetch
    try {
      const response = await worker.fetch(post("/api/agent/turn", { ...turnBody, runId: "run-500" }), env)
      expect(response.status).toBe(500)
      const body = (await response.json()) as { message: string }
      expect(body.message).not.toContain("<")
      expect(body.message).toContain("having trouble")
    } finally {
      globalThis.fetch = original
    }
  })

  /* An upstream that DOES write prose keeps it — our own limiter is the case. */
  test("an upstream message written for a reader survives", async () => {
    const env: WorkerEnv = { ...assetsEnv(), SMITHERS_CHAT_URL: "https://upstream.test/chat" }
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ status: "error", message: "The canary chat queue is draining; try again shortly." }),
        {
          status: 503,
          headers: { "content-type": "application/json" }
        }
      )) as unknown as typeof fetch
    try {
      const response = await worker.fetch(post("/api/agent/turn", { ...turnBody, runId: "run-503" }), env)
      const body = (await response.json()) as { message: string }
      expect(body.message).toContain("The canary chat queue is draining")
    } finally {
      globalThis.fetch = original
    }
  })

  /*
   * An unreachable sibling used to end the fetch handler with an uncaught
   * rejection, and workerd answers that with its own HTML error page — which
   * the product then renders to the user.
   */
  test("an unreachable proxy upstream answers honest JSON, never a thrown exception", async () => {
    const env: WorkerEnv = {
      ...assetsEnv(),
      IDENTITY_UPSTREAM_URL: "https://identity.test",
      BILLING_UPSTREAM_URL: "https://billing.test"
    }
    const original = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new TypeError("Network connection lost.")
    }) as unknown as typeof fetch
    try {
      for (const path of ["/api/identity/whoami", "/api/billing/balance"]) {
        const response = await worker.fetch(new Request(`https://mvp.test${path}`), env)
        expect(`${path} → ${response.status}`).toBe(`${path} → 502`)
        const body = (await response.json()) as { status: string; message: string }
        expect(body.status).toBe("error")
        expect(body.message).toContain("unreachable")
      }
    } finally {
      globalThis.fetch = original
    }
  })

  test("streams one upstream turn through /api/agent/turn as NDJSON", async () => {
    let upstreamCall: { origin: string | null; runId: string | null; body: unknown } | undefined
    const env: WorkerEnv = {
      ...assetsEnv(),
      SMITHERS_CHAT_URL: "https://upstream.test/chat"
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (String(input) === "https://upstream.test/chat") {
        upstreamCall = {
          origin: new Headers(init?.headers).get("origin"),
          runId: new Headers(init?.headers).get("x-smithers-run-id"),
          body: JSON.parse(String(init?.body))
        }
        return ndjsonUpstream([
          { type: "delta", kind: "text", text: "Hi, I'm Smithers." },
          { type: "done" }
        ])
      }
      return originalFetch(input as Request, init)
    }) as typeof fetch
    try {
      const response = await worker.fetch(post("/api/agent/turn", turnBody), env)
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("application/x-ndjson")
      const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line))
      // The Worker stamps the turn's runId onto every upstream frame — the
      // client's stream reader drops frames that don't name their turn.
      expect(lines).toEqual([
        { runId: "run-1", type: "delta", kind: "text", text: "Hi, I'm Smithers." },
        { runId: "run-1", type: "done" }
      ])
      expect(upstreamCall?.origin).toBe("https://smithers.sh")
      expect(upstreamCall?.runId).toBe("run-1")
      expect(upstreamCall?.body).toEqual({
        messages: turnBody.messages,
        instructions: turnBody.instructions
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("attaches the configured deployment credential to the chat upstream, never a client one", async () => {
    let authorization: string | null | undefined
    const env: WorkerEnv = {
      ...assetsEnv(),
      SMITHERS_CHAT_URL: "https://upstream.test/chat",
      SMITHERS_CHAT_AUTH_TOKEN: "deployment-chat-token"
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (String(input) === "https://upstream.test/chat") {
        authorization = new Headers(init?.headers).get("authorization")
        return ndjsonUpstream([{ type: "done" }])
      }
      return originalFetch(input as Request, init)
    }) as typeof fetch
    try {
      const withClientBearer = new Request("http://localhost/api/agent/turn", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer client-picked-token" },
        body: JSON.stringify(turnBody)
      })
      const response = await worker.fetch(withClientBearer, env)
      expect(response.status).toBe(200)
      await response.text()
      // The upstream authenticates the deployment, never the browser.
      expect(authorization).toBe("Bearer deployment-chat-token")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("cancel reports not-found for an unknown run", async () => {
    const response = await worker.fetch(post("/api/agent/turn/cancel", { runId: "nope" }), assetsEnv())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "not-found" })
  })

  test("gateway seam 501s honestly when no upstream is configured", async () => {
    for (const path of ["/v1/rpc/getRun", "/v1/api/runs", "/workflows/demo"]) {
      const response = await worker.fetch(new Request(`https://mvp.test${path}`), assetsEnv())
      expect(response.status).toBe(501)
      const body = (await response.json()) as { message: string }
      expect(body.message).toContain("GATEWAY_UPSTREAM_URL")
    }
  })

  test("gateway seam strips client identity headers and re-injects the session's", async () => {
    let seen: Headers | undefined
    const env: WorkerEnv = {
      ...assetsEnv(),
      GATEWAY_UPSTREAM_URL: "https://gateway.test",
      GATEWAY_SESSION_USER_ID: "user-123",
      GATEWAY_SESSION_USER_ROLE: "member",
      GATEWAY_SESSION_USER_SCOPES: "run:read run:write"
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown) => {
      const request = input as Request
      if (new URL(request.url).hostname === "gateway.test") {
        seen = request.headers
        return new Response("{}", { status: 200 })
      }
      return originalFetch(request)
    }) as typeof fetch
    try {
      const request = new Request("https://mvp.test/v1/rpc/getRun", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-user-id": "evil",
          "x-user-scopes": "admin:*",
          "x-user-role": "admin",
          "x-smithers-token-id": "forged",
          authorization: "Bearer stolen"
        },
        body: "{}"
      })
      const response = await worker.fetch(request, env)
      expect(response.status).toBe(200)
      expect(seen?.get("x-user-id")).toBe("user-123")
      expect(seen?.get("x-user-role")).toBe("member")
      expect(seen?.get("x-user-scopes")).toBe("run:read run:write")
      expect(seen?.get("x-smithers-token-id")).toBeNull()
      expect(seen?.get("authorization")).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

const withMockedFetch = async (
  handler: (request: Request) => Response | Promise<Response> | undefined,
  run: () => Promise<void>
): Promise<void> => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const request = typeof input === "string"
      ? new Request(input, init)
      : input instanceof URL
      ? new Request(input.toString(), init)
      : (input as Request)
    const mocked = handler(request)
    if (mocked !== undefined) return mocked
    return originalFetch(request)
  }) as typeof fetch
  try {
    await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

describe("identity seam", () => {
  test("auth and identity routes 501 honestly when no upstream is configured", async () => {
    for (const path of ["/api/auth/session", "/api/auth/scopes", "/api/identity/request-access"]) {
      const response = await worker.fetch(new Request(`https://mvp.test${path}`), assetsEnv())
      expect(response.status).toBe(501)
      const body = (await response.json()) as { message: string }
      expect(body.message).toContain("IDENTITY_UPSTREAM_URL")
    }
  })

  test("proxies to the identity upstream, stripping client identity headers but keeping cookies", async () => {
    let seen: { url: string; headers: Headers } | undefined
    const env: WorkerEnv = { ...assetsEnv(), IDENTITY_UPSTREAM_URL: "https://identity.test" }
    await withMockedFetch(
      (request) => {
        if (new URL(request.url).hostname !== "identity.test") return undefined
        seen = { url: request.url, headers: request.headers }
        return new Response(JSON.stringify({ login: "will", allowlisted: true, admin: false }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      },
      async () => {
        const response = await worker.fetch(
          new Request("https://mvp.test/api/auth/session", {
            headers: { cookie: "smithers_session=abc", "x-user-id": "evil", authorization: "Bearer forged" }
          }),
          env
        )
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ login: "will", allowlisted: true, admin: false })
        expect(seen?.url).toBe("https://identity.test/api/auth/session")
        expect(seen?.headers.get("cookie")).toBe("smithers_session=abc")
        expect(seen?.headers.get("x-user-id")).toBeNull()
        expect(seen?.headers.get("authorization")).toBeNull()
        // A same-origin GET carries no Origin of its own, and both sibling
        // workers gate on one, so the proxy states the origin it serves.
        expect(seen?.headers.get("origin")).toBe("https://mvp.test")
      }
    )
  })
})

/**
 * Wave 8 — no dead ends on the OAuth navigation routes: a browser that clicks
 * "Sign in with GitHub" must never land on raw JSON, and a machine caller
 * keeps the machine answer. Plus the signed-out session probe: the expected
 * 401 is restated as a resolved 200 so the browser logs no console error.
 */
describe("auth navigation seam (wave 8)", () => {
  const env: WorkerEnv = { ...assetsEnv(), IDENTITY_UPSTREAM_URL: "https://identity.test" }
  const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"

  const withIdentity = (
    answer: (request: Request) => Response,
    run: () => Promise<void>
  ): Promise<void> =>
    withMockedFetch(
      (request) => (new URL(request.url).hostname === "identity.test" ? answer(request) : undefined),
      run
    )

  test("a 503 from the OAuth start route renders the branded honest page, status preserved", async () => {
    await withIdentity(
      () =>
        new Response(JSON.stringify({ error: "not configured", code: "oauth_not_configured" }), {
          status: 503,
          headers: { "content-type": "application/json" }
        }),
      async () => {
        const response = await worker.fetch(
          new Request("https://mvp.test/api/auth/github/start", { headers: { accept: BROWSER_ACCEPT } }),
          env
        )
        expect(response.status).toBe(503)
        expect(response.headers.get("content-type")).toContain("text/html")
        const html = await response.text()
        expect(html).toContain("GitHub sign-in isn't switched on yet for this preview.")
        expect(html).toContain("href=\"/\"")
        // Self-contained: no external asset references.
        expect(html).not.toContain("<script")
        expect(html).not.toContain("http://")
        expect(html).not.toContain("https://")
      }
    )
  })

  test("Accept: application/json keeps the machine-readable upstream answer verbatim", async () => {
    await withIdentity(
      () =>
        new Response(JSON.stringify({ error: "not configured", code: "oauth_not_configured" }), {
          status: 503,
          headers: { "content-type": "application/json" }
        }),
      async () => {
        const response = await worker.fetch(
          new Request("https://mvp.test/api/auth/github/start", {
            headers: { accept: "application/json" }
          }),
          env
        )
        expect(response.status).toBe(503)
        expect(await response.json()).toEqual({ error: "not configured", code: "oauth_not_configured" })
      }
    )
  })

  test("a failed callback never strands a user on JSON either", async () => {
    await withIdentity(
      () => new Response(JSON.stringify({ error: "upstream broke" }), { status: 500 }),
      async () => {
        const response = await worker.fetch(
          new Request("https://mvp.test/api/auth/github/callback?code=x&state=y", {
            headers: { accept: BROWSER_ACCEPT }
          }),
          env
        )
        expect(response.status).toBe(500)
        expect(response.headers.get("content-type")).toContain("text/html")
        const html = await response.text()
        expect(html).toContain("GitHub sign-in didn't finish.")
        expect(html).toContain("HTTP 500")
        expect(html).toContain("href=\"/\"")
      }
    )
  })

  /*
   * Repro apps/ui/canary-repros/access/2.3: pressing Cancel on GitHub's
   * consent screen returns `?error=access_denied` with no `code`. That was
   * forwarded to identity, which read it as a malformed callback, and the page
   * told the user "the sign-in service answered HTTP 400" — blaming a service
   * for a button they pressed. The cause is in the query string, so it is read
   * here, named here, and never spends an upstream call.
   */
  test("a cancelled consent screen is named as a cancellation, not an upstream failure", async () => {
    let upstreamCalls = 0
    await withIdentity(
      () => {
        upstreamCalls += 1
        return new Response(JSON.stringify({ message: "code and state are required" }), { status: 400 })
      },
      async () => {
        const response = await worker.fetch(
          new Request(
            "https://mvp.test/api/auth/github/callback?error=access_denied&error_description=The+user+has+denied+your+application+access.&state=zzz",
            { headers: { accept: BROWSER_ACCEPT } }
          ),
          env
        )
        // Nothing failed: the user declined and the app did as it was told.
        expect(response.status).toBe(200)
        expect(response.headers.get("content-type")).toContain("text/html")
        const html = await response.text()
        expect(html).toContain("You cancelled the GitHub sign-in.")
        expect(html).toContain("Nothing was signed in")
        expect(html).not.toContain("sign-in service answered")
        expect(html).not.toContain("HTTP 400")
        expect(html).toContain("href=\"/\"")
        expect(upstreamCalls).toBe(0)
      }
    )
  })

  test("any other OAuth error names what GitHub called it, and keeps a 400", async () => {
    await withIdentity(
      () => new Response("{}", { status: 400 }),
      async () => {
        const response = await worker.fetch(
          new Request(
            "https://mvp.test/api/auth/github/callback?error=redirect_uri_mismatch&error_description=The+redirect_uri+is+not+associated.&state=zzz",
            { headers: { accept: BROWSER_ACCEPT } }
          ),
          env
        )
        expect(response.status).toBe(400)
        const html = await response.text()
        expect(html).toContain("redirect_uri_mismatch")
        expect(html).toContain("The redirect_uri is not associated.")
        expect(html).toContain("href=\"/\"")
      }
    )
  })

  test("a cancelled callback answers JSON callers a cancellation too", async () => {
    await withIdentity(
      () => new Response("{}", { status: 400 }),
      async () => {
        const response = await worker.fetch(
          new Request("https://mvp.test/api/auth/github/callback?error=access_denied&state=zzz", {
            headers: { accept: "application/json" }
          }),
          env
        )
        expect(response.status).toBe(200)
        const body = (await response.json()) as { status: string; message: string }
        expect(body.status).toBe("cancelled")
        expect(body.message).toContain("Nothing was signed in")
      }
    )
  })

  test("the redirect happy path passes through untouched", async () => {
    await withIdentity(
      () => new Response(null, { status: 302, headers: { location: "https://github.com/login/oauth" } }),
      async () => {
        const response = await worker.fetch(
          new Request("https://mvp.test/api/auth/github/start", { headers: { accept: BROWSER_ACCEPT } }),
          env
        )
        expect(response.status).toBe(302)
        expect(response.headers.get("location")).toBe("https://github.com/login/oauth")
      }
    )
  })

  test("an unreachable identity upstream renders the honest page (502), never a thrown 500", async () => {
    await withIdentity(
      () => {
        throw new Error("connection refused")
      },
      async () => {
        const response = await worker.fetch(
          new Request("https://mvp.test/api/auth/github/start", { headers: { accept: BROWSER_ACCEPT } }),
          env
        )
        expect(response.status).toBe(502)
        expect(response.headers.get("content-type")).toContain("text/html")
        expect(await response.text()).toContain("href=\"/\"")
      }
    )
  })

  test("with no identity seam at all a browser still gets the honest page, a machine the JSON 501", async () => {
    const browser = await worker.fetch(
      new Request("https://mvp.test/api/auth/github/start", { headers: { accept: BROWSER_ACCEPT } }),
      assetsEnv()
    )
    expect(browser.status).toBe(501)
    expect(browser.headers.get("content-type")).toContain("text/html")
    expect(await browser.text()).toContain("GitHub sign-in isn't switched on yet for this preview.")
    const machine = await worker.fetch(
      new Request("https://mvp.test/api/auth/github/start", { headers: { accept: "application/json" } }),
      assetsEnv()
    )
    expect(machine.status).toBe(501)
    expect((await machine.json()) as { message: string }).toBeTruthy()
  })

  test("the signed-out session probe resolves 200, never the console-error 401", async () => {
    await withIdentity(
      () => new Response(JSON.stringify({ status: "error", message: "signed out" }), { status: 401 }),
      async () => {
        const response = await worker.fetch(new Request("https://mvp.test/api/auth/session"), env)
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ status: "signed-out" })
      }
    )
  })

  // The identity worker spends 403 on "Forbidden origin" only — a deployment
  // whose ALLOWED_ORIGINS omits this Worker, where nobody could sign in. That
  // is a real failure, not the signed-out state, so it must still surface.
  test("a forbidden-origin 403 is NOT restated as signed-out", async () => {
    await withIdentity(
      () => new Response(JSON.stringify({ error: "Forbidden origin" }), { status: 403 }),
      async () => {
        const response = await worker.fetch(new Request("https://mvp.test/api/auth/session"), env)
        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({ error: "Forbidden origin" })
      }
    )
  })

  test("real session-probe failures (5xx) pass through untouched", async () => {
    await withIdentity(
      () => new Response(JSON.stringify({ status: "error" }), { status: 500 }),
      async () => {
        const response = await worker.fetch(new Request("https://mvp.test/api/auth/session"), env)
        expect(response.status).toBe(500)
      }
    )
  })

  test("a signed-in session answer passes through untouched", async () => {
    await withIdentity(
      () =>
        new Response(JSON.stringify({ login: "will", allowlisted: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        }),
      async () => {
        const response = await worker.fetch(new Request("https://mvp.test/api/auth/session"), env)
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ login: "will", allowlisted: true })
      }
    )
  })
})

/**
 * Wave 7 published this Worker at canary.smithers.sh, where `/api/agent/turn`
 * spends the deployment's model credential and meters real dollars. The
 * same-origin guard is not a gate against that: it only fires for a request
 * that sends an `Origin`, so a plain curl walked straight into a live turn.
 * Once an identity seam exists, the turn routes require a session.
 */
describe("turn seam session gate", () => {
  const identityEnv: WorkerEnv = {
    ...assetsEnv(),
    IDENTITY_UPSTREAM_URL: "https://identity.test",
    SMITHERS_CHAT_URL: "https://upstream.test/chat"
  }

  test("refuses an anonymous turn with 401 before any credential is spent", async () => {
    let upstreamCalls = 0
    await withMockedFetch(
      (request) => {
        if (new URL(request.url).hostname === "identity.test") {
          return new Response("{}", { status: 401 })
        }
        upstreamCalls += 1
        return ndjsonUpstream([{ type: "done" }])
      },
      async () => {
        for (const path of ["/api/agent/turn", "/api/agent/turn/cancel"]) {
          const response = await worker.fetch(post(path, turnBody), identityEnv)
          expect(response.status).toBe(401)
        }
      }
    )
    expect(upstreamCalls).toBe(0)
  })

  test("maps an identity outage to 502 instead of a false sign-in 401", async () => {
    await withMockedFetch(
      (request) => {
        if (new URL(request.url).hostname === "identity.test") throw new Error("connection reset")
        return undefined
      },
      async () => {
        const response = await worker.fetch(post("/api/agent/turn", turnBody), identityEnv)
        expect(response.status).toBe(502)
        expect(((await response.json()) as { message: string }).message).toContain("unreachable")
      }
    )
  })

  test("maps an identity deadline to 504 instead of a false sign-in 401", async () => {
    await withMockedFetch(
      (request) => {
        if (new URL(request.url).hostname !== "identity.test") return undefined
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })
        })
      },
      async () => {
        const response = await worker.fetch(post("/api/agent/turn", turnBody), {
          ...identityEnv,
          UPSTREAM_TIMEOUT_MS: "1"
        })
        expect(response.status).toBe(504)
      }
    )
  })

  test("refuses a signed-in but non-allowlisted account with 403", async () => {
    let upstreamCalls = 0
    await withMockedFetch(
      (request) => {
        if (new URL(request.url).hostname === "identity.test") {
          return new Response(JSON.stringify({ login: "stranger", allowlisted: false }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        }
        upstreamCalls += 1
        return ndjsonUpstream([{ type: "done" }])
      },
      async () => {
        const response = await worker.fetch(post("/api/agent/turn", turnBody), identityEnv)
        expect(response.status).toBe(403)
      }
    )
    expect(upstreamCalls).toBe(0)
  })

  test("lets a validated allowlisted session through to the live turn", async () => {
    await withMockedFetch(
      (request) =>
        new URL(request.url).hostname === "identity.test"
          ? new Response(JSON.stringify({ login: "will", allowlisted: true }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
          : ndjsonUpstream([
            { type: "delta", kind: "text", text: "ok" },
            { type: "done" }
          ]),
      async () => {
        const response = await worker.fetch(
          new Request("https://mvp.test/api/agent/turn", {
            method: "POST",
            headers: { "content-type": "application/json", cookie: "smithers_session=abc" },
            body: JSON.stringify({ ...turnBody, runId: "run-gated" })
          }),
          identityEnv
        )
        expect(response.status).toBe(200)
        expect(await response.text()).toContain("\"type\":\"done\"")
      }
    )
  })

  /**
   * Wave 13 (D-2): a session-gated turn vouches the validated login to the
   * chat worker with the trusted-caller pair, so the turn's metered charge
   * lands on the user's OWN account. A client-supplied pair is never
   * forwarded — the upstream headers are built here.
   */
  test("a session-gated turn attaches the trusted-caller pair; an unseamed turn attaches nothing", async () => {
    let seen: Headers | undefined
    const env: WorkerEnv = {
      ...identityEnv,
      CHAT_PRODUCT_SERVICE_TOKEN: "chat-product-token-123",
      SMITHERS_CHAT_AUTH_TOKEN: "chat-bearer-123"
    }
    await withMockedFetch(
      (request) => {
        if (new URL(request.url).hostname === "identity.test") {
          return new Response(JSON.stringify({ login: "will", allowlisted: true }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        }
        seen = request.headers
        return ndjsonUpstream([{ type: "done" }])
      },
      async () => {
        const response = await worker.fetch(
          new Request("https://mvp.test/api/agent/turn", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              cookie: "smithers_session=abc",
              // A client trying to attribute its turn to someone else.
              "x-user-login": "someone-else",
              "x-smithers-service-token": "forged"
            },
            body: JSON.stringify({ ...turnBody, runId: "run-vouched" })
          }),
          env
        )
        expect(response.status).toBe(200)
        await response.text()
      }
    )
    expect(seen?.get("x-user-login")).toBe("will")
    expect(seen?.get("x-smithers-service-token")).toBe("chat-product-token-123")
    expect(seen?.get("authorization")).toBe("Bearer chat-bearer-123")

    let unseamed: Headers | undefined
    await withMockedFetch(
      (request) => {
        unseamed = request.headers
        return ndjsonUpstream([{ type: "done" }])
      },
      async () => {
        const response = await worker.fetch(
          post("/api/agent/turn", { ...turnBody, runId: "run-unvouched" }),
          { ...assetsEnv(), SMITHERS_CHAT_URL: "https://upstream.test/chat" }
        )
        expect(response.status).toBe(200)
        await response.text()
      }
    )
    expect(unseamed?.get("x-user-login")).toBeNull()
    expect(unseamed?.get("x-smithers-service-token")).toBeNull()
  })

  /**
   * The local dev / stub stack has no identity seam at all, so there is nothing
   * that could authenticate anyone — the gate must not brick it.
   */
  test("stays out of the way when no identity seam is configured", async () => {
    await withMockedFetch(
      () => ndjsonUpstream([{ type: "done" }]),
      async () => {
        const response = await worker.fetch(
          post("/api/agent/turn", { ...turnBody, runId: "run-ungated" }),
          { ...assetsEnv(), SMITHERS_CHAT_URL: "https://upstream.test/chat" }
        )
        expect(response.status).toBe(200)
      }
    )
  })
})

/**
 * The API spends this deployment's own credentials, and a `text/plain` POST from
 * another site is not preflighted — so without a same-origin guard any page
 * anywhere could submit an approval decision under the seam's injected identity.
 */
describe("same-origin guard", () => {
  const crossOrigin = (path: string): Request =>
    new Request(`https://mvp.test${path}`, {
      method: "POST",
      headers: { "content-type": "text/plain", origin: "https://evil.example" },
      body: "{}"
    })

  test("refuses cross-origin API requests before any credential is spent", async () => {
    let upstreamCalls = 0
    const env: WorkerEnv = {
      ...assetsEnv(),
      GATEWAY_UPSTREAM_URL: "https://gateway.test",
      GATEWAY_SESSION_USER_ID: "user-123",
      IDENTITY_UPSTREAM_URL: "https://identity.test",
      BILLING_UPSTREAM_URL: "https://billing.test",
      BILLING_AUTH_TOKEN: "cloud-bearer-123",
      SMITHERS_CHAT_URL: "https://upstream.test/chat"
    }
    await withMockedFetch(
      () => {
        upstreamCalls += 1
        return new Response("{}", { status: 200 })
      },
      async () => {
        for (
          const path of [
            "/api/approvals/decision",
            "/api/agent/turn",
            "/api/auth/session",
            "/api/identity/request-access",
            "/api/billing/balance",
            "/v1/rpc/getRun"
          ]
        ) {
          const response = await worker.fetch(crossOrigin(path), env)
          expect(response.status).toBe(403)
        }
      }
    )
    expect(upstreamCalls).toBe(0)
  })

  test("same-origin requests, and requests with no Origin at all, still pass", async () => {
    const env: WorkerEnv = { ...assetsEnv(), IDENTITY_UPSTREAM_URL: "https://identity.test" }
    await withMockedFetch(
      (request) =>
        new URL(request.url).hostname === "identity.test"
          ? new Response("{}", { status: 200 })
          : undefined,
      async () => {
        const sameOrigin = await worker.fetch(
          new Request("https://mvp.test/api/auth/session", { headers: { origin: "https://mvp.test" } }),
          env
        )
        expect(sameOrigin.status).toBe(200)
        const noOrigin = await worker.fetch(new Request("https://mvp.test/api/auth/session"), env)
        expect(noOrigin.status).toBe(200)
      }
    )
  })
})

describe("billing seam", () => {
  test("billing routes 501 honestly when no upstream is configured", async () => {
    const response = await worker.fetch(new Request("https://mvp.test/api/billing/balance"), assetsEnv())
    expect(response.status).toBe(501)
    const body = (await response.json()) as { message: string }
    expect(body.message).toContain("BILLING_UPSTREAM_URL")
  })

  /**
   * `workers/billing` authenticates the account with a Smithers Cloud user
   * bearer and reads no `x-user-*` claim, so forwarding without one could only
   * ever come back 401 — the seam says so instead of pretending.
   */
  test("501s honestly when billing has an upstream but no account bearer", async () => {
    const response = await worker.fetch(new Request("https://mvp.test/api/billing/balance"), {
      ...assetsEnv(),
      BILLING_UPSTREAM_URL: "https://billing.test"
    })
    expect(response.status).toBe(501)
    const body = (await response.json()) as { message: string }
    expect(body.message).toContain("BILLING_AUTH_TOKEN")
  })

  test("validates the session and bills AS THE USER through the trusted-caller path", async () => {
    const calls: Array<{ host: string; path: string; headers: Headers }> = []
    const env: WorkerEnv = {
      ...assetsEnv(),
      BILLING_UPSTREAM_URL: "https://billing.test",
      BILLING_AUTH_TOKEN: "cloud-bearer-123",
      BILLING_PRODUCT_SERVICE_TOKEN: "product-service-token-123",
      IDENTITY_UPSTREAM_URL: "https://identity.test",
      IDENTITY_SERVICE_TOKEN: "service-token-123"
    }
    await withMockedFetch(
      (request) => {
        const url = new URL(request.url)
        if (url.hostname === "identity.test") {
          calls.push({ host: "identity", path: url.pathname, headers: request.headers })
          return new Response(
            JSON.stringify({ login: "will", allowlisted: true, admin: false, scopes: ["billing:read"] }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        }
        if (url.hostname === "billing.test") {
          calls.push({ host: "billing", path: url.pathname, headers: request.headers })
          return new Response(JSON.stringify({ state: "ok", allowedToStartWork: true }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        }
        return undefined
      },
      async () => {
        const response = await worker.fetch(
          new Request("https://mvp.test/api/billing/balance", {
            headers: {
              cookie: "smithers_session=abc",
              "x-user-id": "evil",
              "x-user-login": "evil",
              "x-smithers-service-token": "evil"
            }
          }),
          env
        )
        expect(response.status).toBe(200)
        const validate = calls.find((call) => call.host === "identity")
        expect(validate?.path).toBe("/api/identity/validate")
        expect(validate?.headers.get("x-smithers-service-token")).toBe("service-token-123")
        expect(validate?.headers.get("cookie")).toBe("smithers_session=abc")
        const balance = calls.find((call) => call.host === "billing")
        expect(balance?.path).toBe("/api/billing/balance")
        // The trusted-caller contract: the product service token plus the
        // identity-validated login — billing keys the account by that login.
        expect(balance?.headers.get("x-smithers-service-token")).toBe("product-service-token-123")
        expect(balance?.headers.get("x-user-login")).toBe("will")
        expect(balance?.headers.get("x-user-scopes")).toBe("billing:read")
        // The deployment bearer must NOT ride along: billing's bearer-wins
        // rule would re-key the read to the shared account (the wave-13 D-1
        // defect). And no client-supplied claim survives the strip.
        expect(balance?.headers.get("authorization")).toBeNull()
        expect(balance?.headers.get("origin")).toBe("https://mvp.test")
      }
    )
  })

  test("a signed-in request with no product service token 501s honestly — never silently bills the shared account", async () => {
    const env: WorkerEnv = {
      ...assetsEnv(),
      BILLING_UPSTREAM_URL: "https://billing.test",
      BILLING_AUTH_TOKEN: "cloud-bearer-123",
      IDENTITY_UPSTREAM_URL: "https://identity.test"
    }
    let billingCalls = 0
    await withMockedFetch(
      (request) => {
        const url = new URL(request.url)
        if (url.hostname === "identity.test") {
          return new Response(JSON.stringify({ login: "will", allowlisted: true }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        }
        if (url.hostname === "billing.test") {
          billingCalls += 1
          return new Response("{}", { status: 200 })
        }
        return undefined
      },
      async () => {
        const response = await worker.fetch(
          new Request("https://mvp.test/api/billing/balance", { headers: { cookie: "smithers_session=abc" } }),
          env
        )
        expect(response.status).toBe(501)
        const body = (await response.json()) as { message: string }
        expect(body.message).toContain("BILLING_PRODUCT_SERVICE_TOKEN")
      }
    )
    expect(billingCalls).toBe(0)
  })

  test("a client-supplied bearer never reaches billing — only the deployment's does", async () => {
    let seen: Headers | undefined
    const env: WorkerEnv = {
      ...assetsEnv(),
      BILLING_UPSTREAM_URL: "https://billing.test",
      BILLING_AUTH_TOKEN: "cloud-bearer-123"
    }
    await withMockedFetch(
      (request) => {
        if (new URL(request.url).hostname !== "billing.test") return undefined
        seen = request.headers
        return new Response("{}", { status: 200 })
      },
      async () => {
        const response = await worker.fetch(
          new Request("https://mvp.test/api/billing/balance", {
            headers: {
              authorization: "Bearer someone-elses-account",
              "x-user-id": "evil",
              "x-user-login": "evil",
              "x-smithers-service-token": "evil"
            }
          }),
          env
        )
        expect(response.status).toBe(200)
        expect(seen?.get("authorization")).toBe("Bearer cloud-bearer-123")
        expect(seen?.get("x-user-id")).toBeNull()
        expect(seen?.get("x-user-login")).toBeNull()
        expect(seen?.get("x-smithers-service-token")).toBeNull()
      }
    )
  })

  test("401s honestly when the identity seam validates no session", async () => {
    const env: WorkerEnv = {
      ...assetsEnv(),
      BILLING_UPSTREAM_URL: "https://billing.test",
      BILLING_AUTH_TOKEN: "cloud-bearer-123",
      IDENTITY_UPSTREAM_URL: "https://identity.test"
    }
    await withMockedFetch(
      (request) => {
        if (new URL(request.url).hostname === "identity.test") {
          return new Response(JSON.stringify({ status: "error" }), { status: 401 })
        }
        return undefined
      },
      async () => {
        const response = await worker.fetch(new Request("https://mvp.test/api/billing/balance"), env)
        expect(response.status).toBe(401)
        const body = (await response.json()) as { message: string }
        expect(body.message).toContain("Sign in")
      }
    )
  })
})

describe("approval decision round trip", () => {
  const decisionBody = {
    runId: "run_01",
    nodeId: "approve",
    iteration: 0,
    decision: { approved: true, note: "ship it" }
  }

  test("501s honestly when no gateway upstream is configured", async () => {
    const response = await worker.fetch(post("/api/approvals/decision", decisionBody), assetsEnv())
    expect(response.status).toBe(501)
    const body = (await response.json()) as { message: string }
    expect(body.message).toContain("GATEWAY_UPSTREAM_URL")
  })

  test("rejects a malformed decision body with 400", async () => {
    const response = await worker.fetch(
      post("/api/approvals/decision", { runId: "run_01", nodeId: "approve" }),
      assetsEnv()
    )
    expect(response.status).toBe(400)
  })

  test("forwards to submitApproval with injected identity and returns the echo", async () => {
    let seen: { url: string; headers: Headers; body: unknown } | undefined
    const env: WorkerEnv = {
      ...assetsEnv(),
      GATEWAY_UPSTREAM_URL: "https://gateway.test",
      GATEWAY_SESSION_USER_ID: "user-123"
    }
    await withMockedFetch(
      (request) => {
        const url = new URL(request.url)
        if (url.hostname !== "gateway.test") return undefined
        seen = { url: request.url, headers: request.headers, body: undefined }
        return new Response(
          JSON.stringify({ runId: "run_01", nodeId: "approve", iteration: 0, approved: true }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      },
      async () => {
        const response = await worker.fetch(post("/api/approvals/decision", decisionBody), env)
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
          runId: "run_01",
          nodeId: "approve",
          iteration: 0,
          approved: true
        })
      }
    )
    expect(seen?.url).toBe("https://gateway.test/v1/rpc/submitApproval")
    expect(seen?.headers.get("x-user-id")).toBe("user-123")
    expect(seen?.headers.get("authorization")).toBeNull()
  })

  test("passes an upstream failure through honestly", async () => {
    const env: WorkerEnv = {
      ...assetsEnv(),
      GATEWAY_UPSTREAM_URL: "https://gateway.test",
      GATEWAY_SESSION_USER_ID: "user-123"
    }
    await withMockedFetch(
      (request) => {
        if (new URL(request.url).hostname !== "gateway.test") return undefined
        return new Response(JSON.stringify({ error: "AlreadyDecided" }), { status: 409 })
      },
      async () => {
        const response = await worker.fetch(post("/api/approvals/decision", decisionBody), env)
        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({ error: "AlreadyDecided" })
      }
    )
  })
})

describe("the deleted recommendations seam", () => {
  test("every /api/reco/* route is the canonical unknown-route 404 now", async () => {
    for (const path of ["/api/reco/first-run", "/api/reco/feedback", "/api/reco/repos", "/api/reco/watched"]) {
      const response = await worker.fetch(new Request(`https://mvp.test${path}`), assetsEnv())
      expect(`${path} → ${response.status}`).toBe(`${path} → 404`)
      expect(await response.json()).toEqual({ status: "error", message: "Not found." })
    }
  })
})

describe("the admin surface (non-enumerable)", () => {
  const adminEnv = (): WorkerEnv => ({
    ...assetsEnv(),
    IDENTITY_UPSTREAM_URL: "https://identity.test",
    IDENTITY_SERVICE_TOKEN: "service-token-123",
    IDENTITY_ADMIN_TOKEN: "identity-admin-123",
    BILLING_UPSTREAM_URL: "https://billing.test",
    BILLING_ADMIN_TOKEN: "billing-admin-123"
  })

  /** Identity double whose /validate answer is scriptable per test. */
  const identityDouble =
    (validate: Response, recorded?: Array<{ path: string; headers: Headers; body: unknown }>) =>
    (request: Request): Response | undefined => {
      const url = new URL(request.url)
      if (url.hostname !== "identity.test") return undefined
      if (url.pathname === "/api/identity/validate") return validate.clone()
      recorded?.push({ path: url.pathname, headers: request.headers, body: undefined })
      return new Response(JSON.stringify({ requests: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    }

  const adminValidate = new Response(
    JSON.stringify({ login: "will", allowlisted: true, admin: true, scopes: [] }),
    { status: 200, headers: { "content-type": "application/json" } }
  )
  const memberValidate = new Response(
    JSON.stringify({ login: "will", allowlisted: true, admin: false, scopes: [] }),
    { status: 200, headers: { "content-type": "application/json" } }
  )
  const noSession = new Response(JSON.stringify({ status: "error" }), { status: 401 })

  test("a signed-out probe gets byte-identical 404s for admin and unknown routes", async () => {
    await withMockedFetch(identityDouble(noSession), async () => {
      const unknown = await worker.fetch(new Request("https://mvp.test/api/definitely-not-a-route"), adminEnv())
      for (
        const path of [
          "/api/admin/allowlist",
          "/api/admin/grant",
          "/api/admin/requests",
          "/api/admin/feedback",
          "/api/admin/health"
        ]
      ) {
        const probe = await worker.fetch(new Request(`https://mvp.test${path}`), adminEnv())
        expect(probe.status).toBe(404)
        // Byte-identical: no enumeration signal in the body, status, or content type.
        expect(await probe.text()).toBe(await unknown.clone().text())
        expect(probe.headers.get("content-type")).toBe(unknown.headers.get("content-type"))
      }
      expect(unknown.status).toBe(404)
    })
  })

  test("a validated NON-admin session is equally undetectable", async () => {
    await withMockedFetch(identityDouble(memberValidate), async () => {
      const unknown = await worker.fetch(new Request("https://mvp.test/api/nope"), adminEnv())
      const probe = await worker.fetch(new Request("https://mvp.test/api/admin/requests"), adminEnv())
      expect(probe.status).toBe(404)
      expect(await probe.text()).toBe(await unknown.text())
    })
  })

  /*
   * Repro apps/ui/canary-repros/access/1.5: `admin` comes from identity's
   * ADMIN_LOGINS var, so removing a login from the closed-alpha allowlist left
   * the whole admin surface open to it — including POST /api/admin/allowlist,
   * the door that edits the allowlist itself. Identity now withholds the claim
   * from a non-allowlisted login; this Worker refuses on its own evidence too,
   * so one upstream field cannot re-open the surface on its own.
   */
  test("a de-allowlisted admin is as undetectable as a stranger", async () => {
    const deAllowlistedAdmin = new Response(
      JSON.stringify({ login: "will", allowlisted: false, admin: true, scopes: [] }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
    await withMockedFetch(identityDouble(deAllowlistedAdmin), async () => {
      const unknown = await worker.fetch(new Request("https://mvp.test/api/nope"), adminEnv())
      const unknownBody = await unknown.text()
      for (
        const path of [
          "/api/admin/requests",
          "/api/admin/health",
          "/api/admin/feedback",
          "/api/admin/errors"
        ]
      ) {
        const probe = await worker.fetch(new Request(`https://mvp.test${path}`), adminEnv())
        expect(probe.status).toBe(404)
        expect(await probe.text()).toBe(unknownBody)
      }
      // The write door too: a revoked admin cannot re-add itself.
      const write = await worker.fetch(
        post("/api/admin/allowlist", { login: "will", action: "add" }),
        adminEnv()
      )
      expect(write.status).toBe(404)
      expect(await write.text()).toBe(unknownBody)
    })
  })

  test("admin allowlist writes carry the admin's login as requester and a fresh timestamp", async () => {
    let seen: { headers: Headers; body: unknown } | undefined
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const request = typeof input === "string" ? new Request(input, init) : (input as Request)
      const url = new URL(request.url)
      if (url.hostname === "identity.test" && url.pathname === "/api/identity/validate") {
        return adminValidate.clone()
      }
      if (url.hostname === "identity.test" && url.pathname === "/api/identity/admin/allowlist") {
        seen = { headers: request.headers, body: await request.json() }
        return new Response(
          JSON.stringify({ applied: true, action: "add", login: "octocat", requester: "will" }),
          { status: 201, headers: { "content-type": "application/json" } }
        )
      }
      return originalFetch(request)
    }) as typeof fetch
    try {
      const response = await worker.fetch(
        post("/api/admin/allowlist", { login: "octocat", action: "add" }),
        adminEnv()
      )
      expect(response.status).toBe(201)
    } finally {
      globalThis.fetch = originalFetch
    }
    const body = seen?.body as { login: string; action: string; requester: string; timestamp: string }
    expect(seen?.headers.get("x-smithers-admin-token")).toBe("identity-admin-123")
    expect(body.login).toBe("octocat")
    expect(body.action).toBe("add")
    expect(body.requester).toBe("will")
    expect(Number.isFinite(Date.parse(body.timestamp))).toBe(true)
  })

  test("admin grants forward to billing with attribution and a fresh admin: grant id", async () => {
    let seen: { headers: Headers; body: unknown } | undefined
    await withMockedFetch(
      (request) => {
        const url = new URL(request.url)
        if (url.hostname === "identity.test") return adminValidate.clone()
        if (url.hostname === "billing.test" && url.pathname === "/api/billing/admin/grants") {
          return new Response("{}", { status: 201 })
        }
        return undefined
      },
      async () => {
        // Capture the grant body with a second pass that reads it.
        const originalFetch = globalThis.fetch
        globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
          const request = typeof input === "string" ? new Request(input, init) : (input as Request)
          const url = new URL(request.url)
          if (url.hostname === "billing.test" && url.pathname === "/api/billing/admin/grants") {
            seen = { headers: request.headers, body: await request.json() }
            return new Response(JSON.stringify({ granted: true, grantId: "x" }), {
              status: 201,
              headers: { "content-type": "application/json" }
            })
          }
          return originalFetch(request)
        }) as typeof fetch
        try {
          const response = await worker.fetch(
            post("/api/admin/grant", { login: "octocat", amountUsd: 25 }),
            adminEnv()
          )
          expect(response.status).toBe(201)
        } finally {
          globalThis.fetch = originalFetch
        }
      }
    )
    expect(seen?.headers.get("x-smithers-admin-token")).toBe("billing-admin-123")
    const body = seen?.body as {
      userId: string
      grantId: string
      amountUsd: number
      kind: string
      requester: string
      timestamp: string
    }
    expect(body.userId).toBe("octocat")
    expect(body.amountUsd).toBe(25)
    expect(body.requester).toBe("will")
    expect(body.grantId).toMatch(/^admin:[A-Za-z0-9._:-]{3,190}$/)
    expect(Number.isFinite(Date.parse(body.timestamp))).toBe(true)
  })

  test("admin reads proxy: the request queue", async () => {
    const seen: Array<{ host: string; path: string; token: string | null }> = []
    await withMockedFetch(
      (request) => {
        const url = new URL(request.url)
        if (url.hostname === "identity.test" && url.pathname === "/api/identity/validate") {
          return adminValidate.clone()
        }
        if (url.hostname === "identity.test") {
          seen.push({ host: "identity", path: url.pathname, token: request.headers.get("x-smithers-admin-token") })
          return new Response(
            JSON.stringify({
              requests: [{
                login: "octocat",
                note: null,
                createdAt: "2026-08-08T00:00:00.000Z",
                updatedAt: "2026-08-08T00:00:00.000Z"
              }]
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          )
        }
        return undefined
      },
      async () => {
        const queue = await worker.fetch(new Request("https://mvp.test/api/admin/requests"), adminEnv())
        expect(queue.status).toBe(200)
        // The deleted recommendations admin surface is just another unknown route now.
        const feedback = await worker.fetch(new Request("https://mvp.test/api/admin/feedback"), adminEnv())
        expect(feedback.status).toBe(404)
      }
    )
    expect(seen.find((c) => c.host === "identity")?.path).toBe("/api/identity/admin/requests")
    expect(seen.find((c) => c.host === "identity")?.token).toBe("identity-admin-123")
  })

  test("admin.health composes real reads with an honest unconfigured line", async () => {
    await withMockedFetch(
      (request) => {
        const url = new URL(request.url)
        if (url.hostname === "identity.test" && url.pathname === "/api/identity/validate") {
          return adminValidate.clone()
        }
        if (url.hostname === "identity.test" && url.pathname === "/healthz") {
          return new Response(JSON.stringify({ ok: true, admin: true }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        }
        if (url.hostname === "identity.test" && url.pathname === "/api/identity/admin/requests") {
          return new Response(JSON.stringify({ requests: [{}, {}] }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        }
        if (url.hostname === "billing.test" && url.pathname === "/healthz") {
          return new Response(JSON.stringify({ ok: true, rateCardVersion: "2026-08-08" }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        }
        return undefined
      },
      async () => {
        const env: WorkerEnv = {
          ...assetsEnv(),
          IDENTITY_UPSTREAM_URL: "https://identity.test",
          IDENTITY_SERVICE_TOKEN: "service-token-123",
          IDENTITY_ADMIN_TOKEN: "identity-admin-123",
          BILLING_UPSTREAM_URL: "https://billing.test",
          BILLING_ADMIN_TOKEN: "billing-admin-123"
        }
        const response = await worker.fetch(new Request("https://mvp.test/api/admin/health"), env)
        expect(response.status).toBe(200)
        const body = (await response.json()) as {
          services: Array<{ name: string; status: string }>
          queueDepth: number | null
          charges: unknown
        }
        expect(body.services.map((s) => `${s.name}:${s.status}`)).toEqual([
          "billing:ok",
          "identity:ok"
        ])
        expect(body.queueDepth).toBe(2)
        // No BILLING_AUTH_TOKEN in this env: charges is honestly absent, not zero.
        expect(body.charges).toBeNull()
      }
    )
  })

  test("an admin route without its admin token 501s honestly (never a silent forward)", async () => {
    await withMockedFetch(identityDouble(adminValidate), async () => {
      const env: WorkerEnv = {
        ...assetsEnv(),
        IDENTITY_UPSTREAM_URL: "https://identity.test",
        IDENTITY_SERVICE_TOKEN: "service-token-123"
      }
      const response = await worker.fetch(new Request("https://mvp.test/api/admin/requests"), env)
      expect(response.status).toBe(501)
      const body = (await response.json()) as { message: string }
      expect(body.message).toContain("IDENTITY_ADMIN_TOKEN")
    })
  })
})

describe("the tool-loop forwarding", () => {
  test("the turn's tools reach the chat upstream untouched", async () => {
    let seenBody: unknown
    const env: WorkerEnv = { ...assetsEnv(), SMITHERS_CHAT_URL: "https://upstream.test/chat" }
    const tools = [
      {
        type: "function",
        name: "commands",
        description: "the one tool",
        parameters: { type: "object", properties: {} }
      }
    ]
    await withMockedFetch(
      (request) => {
        if (new URL(request.url).hostname !== "upstream.test") return undefined
        return new Response("{}", { status: 200 })
      },
      async () => {
        const originalFetch = globalThis.fetch
        globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
          const request = typeof input === "string" ? new Request(input, init) : (input as Request)
          if (new URL(request.url).hostname === "upstream.test") {
            seenBody = await request.json()
            return ndjsonUpstream([{ type: "done", reason: "stop" }])
          }
          return originalFetch(request)
        }) as typeof fetch
        try {
          const response = await worker.fetch(
            post("/api/agent/turn", { ...turnBody, runId: "run-tools", tools }),
            env
          )
          expect(response.status).toBe(200)
          // Drain the stream so the turn's cancel handle releases for later tests.
          await response.text()
        } finally {
          globalThis.fetch = originalFetch
        }
      }
    )
    expect(seenBody).toEqual({
      messages: turnBody.messages,
      instructions: turnBody.instructions,
      tools
    })
  })

  test("tool continuation messages (function_call / function_call_output) pass validation", async () => {
    const env: WorkerEnv = { ...assetsEnv(), SMITHERS_CHAT_URL: "https://upstream.test/chat" }
    await withMockedFetch(
      (request) => {
        if (new URL(request.url).hostname !== "upstream.test") return undefined
        return ndjsonUpstream([{ type: "done" }])
      },
      async () => {
        const response = await worker.fetch(
          post("/api/agent/turn", {
            ...turnBody,
            runId: "run-tool-items",
            messages: [
              { role: "user", content: "make a note" },
              { type: "function_call", call_id: "c1", name: "commands", arguments: "{}" },
              { type: "function_call_output", call_id: "c1", output: "executed /world.new-note" }
            ]
          }),
          env
        )
        expect(response.status).toBe(200)
        await response.text()
      }
    )
  })
})

/*
 * Wave 6c (launch checklist B-3): the server-side kill. workerd forbids
 * touching another request's AbortController, so the kill state lives in the
 * TurnCancelRegistry Durable Object; the cancel route flips it and the
 * streaming turn handler observes it between chunks. These tests run the
 * registry against in-memory storage and the routes against a memory
 * namespace implementing the same binding surface.
 */
const memoryStorage = (seed?: Record<string, unknown>): TurnCancelStorage => {
  const data = new Map<string, unknown>(Object.entries(seed ?? {}))
  return {
    get: async (key) => data.get(key) as never,
    put: async (key, value) => void data.set(key, value)
  }
}

const memoryCancels = (): TurnCancelNamespace => {
  const registries = new Map<string, TurnCancelRegistry>()
  return {
    idFromName: (name) => name,
    get: (id) => {
      const name = String(id)
      let registry = registries.get(name)
      if (registry === undefined) {
        registry = new TurnCancelRegistry({ storage: memoryStorage() })
        registries.set(name, registry)
      }
      return { fetch: (request) => registry.fetch(request) }
    }
  }
}

const doPost = (registry: TurnCancelRegistry, path: string): Promise<Response> =>
  registry.fetch(new Request(`https://turn-cancel.internal${path}`, { method: "POST" }))

describe("the turn-cancel registry (Durable Object state)", () => {
  test("register starts a turn, a duplicate register is refused, cancel kills it", async () => {
    const registry = new TurnCancelRegistry({ storage: memoryStorage() })
    expect(await (await doPost(registry, "/register")).json()).toEqual({ status: "started" })
    expect(await (await doPost(registry, "/register")).json()).toEqual({ status: "already-running" })
    expect(await (await doPost(registry, "/cancel")).json()).toEqual({ status: "cancelled" })
    // The kill is terminal: a second cancel, and the state read, agree.
    expect(await (await doPost(registry, "/cancel")).json()).toEqual({ status: "not-found" })
    expect(await (await registry.fetch(new Request("https://turn-cancel.internal/state"))).json()).toEqual({
      state: "cancelled"
    })
  })

  test("a settled turn answers cancel with an honest not-found and may re-register", async () => {
    const registry = new TurnCancelRegistry({ storage: memoryStorage() })
    await doPost(registry, "/register")
    await doPost(registry, "/settle")
    expect(await (await doPost(registry, "/cancel")).json()).toEqual({ status: "not-found" })
    // Tool-loop legs reuse the runId: a settled turn registers again.
    expect(await (await doPost(registry, "/register")).json()).toEqual({ status: "started" })
  })

  test("cancel on a never-registered run is not-found", async () => {
    const registry = new TurnCancelRegistry({ storage: memoryStorage() })
    expect(await (await doPost(registry, "/cancel")).json()).toEqual({ status: "not-found" })
  })

  test("a stale active registration no longer holds the runId hostage", async () => {
    const stale = Date.now() - 11 * 60 * 1000
    const registry = new TurnCancelRegistry({
      storage: memoryStorage({ state: { state: "active", at: stale } })
    })
    expect(await (await doPost(registry, "/cancel")).json()).toEqual({ status: "not-found" })
    expect(await (await doPost(registry, "/register")).json()).toEqual({ status: "started" })
  })
})

describe("the server-side kill route (B-3)", () => {
  /** An upstream that emits one delta and then streams nothing until cancelled. */
  const hangingUpstream = (): { response: () => Response; wasCancelled: () => boolean } => {
    let cancelled = false
    return {
      wasCancelled: () => cancelled,
      response: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `${JSON.stringify({ type: "delta", kind: "text", text: "working" })}\n`
                )
              )
            },
            cancel: () => {
              cancelled = true
            }
          }),
          { status: 200, headers: { "content-type": "application/x-ndjson" } }
        )
    }
  }

  const kill = (runId: string, env: WorkerEnv): Promise<Response> =>
    worker.fetch(post("/api/agent/turn/cancel", { runId }), env)

  test("a mid-stream kill ends the turn with an honest cancelled frame, then not-found", async () => {
    const upstream = hangingUpstream()
    const env: WorkerEnv = {
      ...assetsEnv(),
      SMITHERS_CHAT_URL: "https://upstream.test/chat",
      TURN_CANCELS: memoryCancels()
    }
    await withMockedFetch(
      (request) => {
        if (new URL(request.url).hostname !== "upstream.test") return undefined
        return upstream.response()
      },
      async () => {
        const turn = await worker.fetch(post("/api/agent/turn", { ...turnBody, runId: "run-kill" }), env)
        expect(turn.status).toBe(200)
        const reader = turn.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        const nextFrame = async (): Promise<Record<string, unknown>> => {
          for (;;) {
            const line = buffer.split("\n")[0]
            if (buffer.includes("\n")) {
              buffer = buffer.slice(buffer.indexOf("\n") + 1)
              if (line.trim() !== "") return JSON.parse(line) as Record<string, unknown>
              continue
            }
            const { value, done } = await reader.read()
            if (done) throw new Error("stream ended before the next frame")
            buffer += decoder.decode(value, { stream: true })
          }
        }
        const first = await nextFrame()
        expect(first).toEqual({ runId: "run-kill", type: "delta", kind: "text", text: "working" })

        // The kill lands mid-flight: never a 500, always the honest status.
        const cancelled = await kill("run-kill", env)
        expect(cancelled.status).toBe(200)
        expect(await cancelled.json()).toEqual({ status: "cancelled" })

        // The turn's own pump observes the kill between chunks (here: on the
        // poll tick, the upstream being silent), aborts its upstream fetch,
        // and closes with the honest terminal frame — never a silent stop.
        const terminal = await nextFrame()
        expect(terminal).toEqual({ runId: "run-kill", type: "done", reason: "cancelled" })
        expect((await reader.read()).done).toBe(true)
        expect(upstream.wasCancelled()).toBe(true)

        // The turn settled: killing it again is an honest not-found, and the
        // runId is free to register again (tool-loop discipline).
        const again = await kill("run-kill", env)
        expect(again.status).toBe(200)
        expect(await again.json()).toEqual({ status: "not-found" })
      }
    )
  })

  test("killing a turn that already completed is not-found, never an error", async () => {
    const env: WorkerEnv = {
      ...assetsEnv(),
      SMITHERS_CHAT_URL: "https://upstream.test/chat",
      TURN_CANCELS: memoryCancels()
    }
    await withMockedFetch(
      (request) => {
        if (new URL(request.url).hostname !== "upstream.test") return undefined
        return ndjsonUpstream([
          { type: "delta", kind: "text", text: "done already" },
          { type: "done", reason: "stop" }
        ])
      },
      async () => {
        const turn = await worker.fetch(post("/api/agent/turn", { ...turnBody, runId: "run-settled" }), env)
        expect(turn.status).toBe(200)
        await turn.text()
        const late = await kill("run-settled", env)
        expect(late.status).toBe(200)
        expect(await late.json()).toEqual({ status: "not-found" })
      }
    )
  })

  test("a long stream does not spend one Durable Object subrequest per chunk", async () => {
    // A Worker request may make ~1000 subrequests, and every kill check is
    // one: a token-streamed turn delivers far more chunks than that, so an
    // unthrottled per-chunk poll would end long turns with "Too many
    // subrequests". The poll is rate-limited instead.
    const namespace = memoryCancels()
    let stateReads = 0
    const counted: TurnCancelNamespace = {
      idFromName: (name) => namespace.idFromName(name),
      get: (id) => {
        const stub = namespace.get(id)
        return {
          fetch: (request) => {
            if (new URL(request.url).pathname === "/state") stateReads += 1
            return stub.fetch(request)
          }
        }
      }
    }
    const env: WorkerEnv = {
      ...assetsEnv(),
      SMITHERS_CHAT_URL: "https://upstream.test/chat",
      TURN_CANCELS: counted
    }
    const chunks = 400
    await withMockedFetch(
      (request) => {
        if (new URL(request.url).hostname !== "upstream.test") return undefined
        return ndjsonUpstream([
          ...Array.from({ length: chunks }, (_, index) => ({
            type: "delta",
            kind: "text",
            text: `t${index}`
          })),
          { type: "done", reason: "stop" }
        ])
      },
      async () => {
        const turn = await worker.fetch(post("/api/agent/turn", { ...turnBody, runId: "run-long" }), env)
        expect(turn.status).toBe(200)
        const body = await turn.text()
        expect(body.trim().split("\n")).toHaveLength(chunks + 1)
        // One poll per CANCEL_POLL_CHUNKS (64) chunks, not one per chunk.
        expect(stateReads).toBeGreaterThan(0)
        expect(stateReads).toBeLessThan(chunks / 8)
      }
    )
  })

  test("the kill route with the registry bound never 500s on an unknown run", async () => {
    const env: WorkerEnv = { ...assetsEnv(), TURN_CANCELS: memoryCancels() }
    const response = await kill("ghost", env)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "not-found" })
  })

  test("a duplicate turn registration 409s through the registry", async () => {
    const upstream = hangingUpstream()
    const env: WorkerEnv = {
      ...assetsEnv(),
      SMITHERS_CHAT_URL: "https://upstream.test/chat",
      TURN_CANCELS: memoryCancels()
    }
    await withMockedFetch(
      (request) => {
        if (new URL(request.url).hostname !== "upstream.test") return undefined
        return upstream.response()
      },
      async () => {
        const first = await worker.fetch(post("/api/agent/turn", { ...turnBody, runId: "run-dupe" }), env)
        expect(first.status).toBe(200)
        const second = await worker.fetch(post("/api/agent/turn", { ...turnBody, runId: "run-dupe" }), env)
        expect(second.status).toBe(409)
        // Clean up: kill the hanging turn and drain it.
        await kill("run-dupe", env)
        await first.text()
      }
    )
  })
})

describe("the browser tool route (§2d)", () => {
  test("a malformed body is a 400, a non-https URL a guarded 422 — no fetch happens", async () => {
    const bad = await worker.fetch(post("/api/tools/browser-fetch", { nope: true }), assetsEnv())
    expect(bad.status).toBe(400)
    const http = await worker.fetch(post("/api/tools/browser-fetch", { url: "http://example.com/" }), assetsEnv())
    expect(http.status).toBe(422)
    expect(((await http.json()) as { message: string }).message).toContain("https")
    const privateIp = await worker.fetch(
      post("/api/tools/browser-fetch", { url: "https://127.0.0.1/" }),
      assetsEnv()
    )
    expect(privateIp.status).toBe(422)
    const internal = await worker.fetch(
      post("/api/tools/browser-fetch", { url: "https://db.internal/" }),
      assetsEnv()
    )
    expect(internal.status).toBe(422)
  })

  test("with an identity seam configured, an anonymous caller gets the session gate's 401", async () => {
    const env: WorkerEnv = { ...assetsEnv(), IDENTITY_UPSTREAM_URL: "https://identity.test" }
    const original = globalThis.fetch
    globalThis.fetch =
      (async () => new Response(JSON.stringify({ status: "error" }), { status: 401 })) as unknown as typeof fetch
    try {
      const response = await worker.fetch(post("/api/tools/browser-fetch", { url: "https://example.com/" }), env)
      expect(response.status).toBe(401)
    } finally {
      globalThis.fetch = original
    }
  })

  /*
   * The native sign-in handoff's callback answers a 200 HTML success page
   * (the session travels via the claim endpoint, not the tab). The Wave-8
   * no-dead-ends wrapper must pass that page through — live, it replaced it
   * with a 502 "nothing was signed in" surface for a user who WAS signed in.
   */
  test("a 200 HTML answer from the OAuth callback passes through as the success page it is", async () => {
    const env: WorkerEnv = { ...assetsEnv(), IDENTITY_UPSTREAM_URL: "https://identity.test" }
    const original = globalThis.fetch
    globalThis.fetch =
      (async () =>
        new Response("<!doctype html><title>Signed in</title>You're signed in — return to the Smithers app.", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" }
        })) as unknown as typeof fetch
    try {
      const response = await worker.fetch(
        new Request("https://mvp.test/api/auth/github/callback?code=x&state=y", {
          headers: { accept: "text/html" }
        }),
        env
      )
      expect(response.status).toBe(200)
      expect(await response.text()).toContain("return to the Smithers app")
    } finally {
      globalThis.fetch = original
    }
  })

  /*
   * The curated platform proxy (MULTI-ACTIONS-GAP.md): allowlisted paths are
   * CLAIMED by the worker even when the deployment cannot serve them — the
   * honest 503, never the canonical 404 — and anything off the allowlist
   * stays the canonical 404.
   */
  test("platform-proxy paths answer the honest no-identity 503, never the canonical 404", async () => {
    const paths: ReadonlyArray<readonly [string, string]> = [
      ["GET", "/api/repos/will/flows/issues?state=open"],
      ["POST", "/api/github/import"],
      ["GET", "/api/user/byok-keys"],
      ["GET", "/api/notifications/list"],
      ["POST", "/api/billing/checkout"],
      ["POST", "/api/billing/portal"]
    ]
    for (const [method, path] of paths) {
      const response = await worker.fetch(new Request(`https://mvp.test${path}`, { method }), assetsEnv())
      expect(`${method} ${path} → ${response.status}`).toBe(`${method} ${path} → 503`)
    }
  })

  test("methods outside the platform-proxy allowlist stay the canonical 404", async () => {
    // GET /api/billing/checkout is NOT here: off the proxy allowlist it falls
    // through to the /api/billing/ prefix, which the product billing worker owns.
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["DELETE", "/api/notifications/list"],
      ["PATCH", "/api/user/byok-keys"]
    ]
    for (const [method, path] of cases) {
      const response = await worker.fetch(new Request(`https://mvp.test${path}`, { method }), assetsEnv())
      expect(`${method} ${path} → ${response.status}`).toBe(`${method} ${path} → 404`)
    }
  })

  /*
   * Repro apps/ui/canary-repros/admin/28.5 and cards/8.21: the proxy forwarded
   * every allowlisted path, and the jjhub Go router's plain-text
   * `404 page not found` came back through it and was rendered verbatim into
   * the user's toast. A body written for a router is never a message for a
   * reader.
   */
  test("a platform failure is restated in the seam's envelope, never forwarded raw", async () => {
    const env: WorkerEnv = {
      ...assetsEnv(),
      IDENTITY_UPSTREAM_URL: "https://identity.test",
      IDENTITY_SERVICE_TOKEN: "svc",
      SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test"
    }
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes("/api/identity/validate")) {
        return new Response(JSON.stringify({ login: "will", allowlisted: true, admin: false, scopes: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      }
      if (url.includes("/api/identity/cloud-token")) {
        return new Response(JSON.stringify({ found: true, token: "cloud-token-1" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      }
      return new Response("404 page not found\n", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" }
      })
    }) as unknown as typeof fetch
    try {
      const response = await worker.fetch(
        new Request("https://mvp.test/api/repos/will/flows/issues?state=open"),
        env
      )
      expect(response.status).toBe(404)
      expect(response.headers.get("content-type")).toContain("application/json")
      const body = (await response.json()) as { status: string; message: string }
      expect(body.status).toBe("error")
      expect(body.message).not.toContain("404 page not found")
      expect(body.message).toContain("Smithers Cloud")
    } finally {
      globalThis.fetch = original
    }
  })

  /*
   * Repro apps/ui/canary-repros/money/18.1 and flow-sweep/A.59: the platform
   * ships no BYOK key store, so the forward could only ever come back a 404.
   * The honest answer is the seam's own 501 naming the state, and NO forward
   * at all — a doomed request is also a 4xx on every ordinary session
   * (repro admin/28.12).
   */
  test("a platform family the upstream does not implement answers an honest 501 and never forwards", async () => {
    const env: WorkerEnv = {
      ...assetsEnv(),
      IDENTITY_UPSTREAM_URL: "https://identity.test",
      IDENTITY_SERVICE_TOKEN: "svc",
      SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test"
    }
    const seen: Array<string> = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      seen.push(url)
      if (url.includes("/api/identity/validate")) {
        return new Response(JSON.stringify({ login: "will", allowlisted: true, admin: false, scopes: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      }
      return new Response("404 page not found\n", { status: 404 })
    }) as unknown as typeof fetch
    try {
      for (
        const request of [
          new Request("https://mvp.test/api/user/byok-keys"),
          new Request("https://mvp.test/api/user/byok-keys/anthropic", { method: "DELETE" })
        ]
      ) {
        const response = await worker.fetch(request, env)
        expect(response.status).toBe(501)
        const body = (await response.json()) as { message: string }
        expect(body.message).toContain("provider keys")
        expect(body.message).not.toContain("404")
      }
      expect(seen.every((url) => url.includes("identity.test"))).toBe(true)
    } finally {
      globalThis.fetch = original
    }
  })

  /*
   * Repro apps/ui/canary-repros/money/17.4: `/billing.upgrade` on an MVP
   * account fired a live POST /api/billing/checkout and came back the
   * platform's `stripe billing is not configured`. The alpha comps every
   * balance, so the honest answer is that there is nothing to buy — and the
   * request never reaches Stripe.
   */
  test("checkout and the billing portal are refused while the alpha comps every balance", async () => {
    const env: WorkerEnv = {
      ...assetsEnv(),
      IDENTITY_UPSTREAM_URL: "https://identity.test",
      IDENTITY_SERVICE_TOKEN: "svc",
      SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test"
    }
    const seen: Array<string> = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      seen.push(url)
      if (url.includes("/api/identity/validate")) {
        return new Response(JSON.stringify({ login: "will", allowlisted: true, admin: false, scopes: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      }
      return new Response(JSON.stringify({ message: "stripe billing is not configured" }), { status: 400 })
    }) as unknown as typeof fetch
    try {
      for (const path of ["/api/billing/checkout", "/api/billing/portal"]) {
        const response = await worker.fetch(new Request(`https://mvp.test${path}`, { method: "POST" }), env)
        expect(`${path} → ${response.status}`).toBe(`${path} → 501`)
        const body = (await response.json()) as { message: string }
        expect(body.message).toContain("nothing to buy")
        expect(body.message).not.toContain("stripe")
      }
      expect(seen.some((url) => url.includes("cloud.test"))).toBe(false)
    } finally {
      globalThis.fetch = original
    }
  })

  test("a deployment that has shipped paid plans forwards checkout unchanged", async () => {
    const env: WorkerEnv = {
      ...assetsEnv(),
      IDENTITY_UPSTREAM_URL: "https://identity.test",
      IDENTITY_SERVICE_TOKEN: "svc",
      SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test",
      BILLING_CHECKOUT_ENABLED: "1"
    }
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes("/api/identity/validate")) {
        return new Response(JSON.stringify({ login: "will", allowlisted: true, admin: false, scopes: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      }
      if (url.includes("/api/identity/cloud-token")) {
        return new Response(JSON.stringify({ found: true, token: "cloud-token-1" }), { status: 200 })
      }
      return new Response(JSON.stringify({ url: "https://checkout.stripe.test/session" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    }) as unknown as typeof fetch
    try {
      const response = await worker.fetch(
        new Request("https://mvp.test/api/billing/checkout", { method: "POST" }),
        env
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ url: "https://checkout.stripe.test/session" })
    } finally {
      globalThis.fetch = original
    }
  })

  test("the platform proxy forwards with the user's cloud bearer and passes the platform answer through", async () => {
    const env: WorkerEnv = {
      ...assetsEnv(),
      IDENTITY_UPSTREAM_URL: "https://identity.test",
      IDENTITY_SERVICE_TOKEN: "svc",
      SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test"
    }
    const seen: Array<{ url: string; auth: string | null; method: string }> = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith("https://identity.test/api/identity/validate")) {
        return new Response(
          JSON.stringify({ login: "will", allowlisted: true, admin: false, scopes: [] }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      }
      if (url.startsWith("https://identity.test/api/identity/cloud-token")) {
        return new Response(JSON.stringify({ found: true, token: "cloud-token-1" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      }
      const auth = new Headers(init?.headers).get("authorization")
      seen.push({ url, auth, method: init?.method ?? "GET" })
      return new Response(JSON.stringify([{ number: 7, title: "A bug", state: "open" }]), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    }) as unknown as typeof fetch
    try {
      const response = await worker.fetch(
        new Request("https://mvp.test/api/repos/will/flows/issues?state=open"),
        env
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual([{ number: 7, title: "A bug", state: "open" }])
      expect(seen).toHaveLength(1)
      expect(seen[0]?.url).toBe("https://cloud.test/api/repos/will/flows/issues?state=open")
      expect(seen[0]?.auth).toBe("Bearer cloud-token-1")
    } finally {
      globalThis.fetch = original
    }
  })
})
