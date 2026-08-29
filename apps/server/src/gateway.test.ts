/*
 * Wave 11 — the per-user gateway seam, unit-proven against a relay double.
 *
 * The contract under test is WAVE4-RELAY-RECEIPT.md §5 (provision-or-resume is
 * idempotent; re-call at the half-life and ALWAYS adopt what comes back; the
 * 401/409/500-no_capacity taxonomy is distinct and never retry-looped) plus the
 * wave-11b Cloud token door (`POST /api/identity/cloud-token`, service-token,
 * by login, with typed `{found:false, cloud:{status}}` honesty).
 *
 * The hard invariant every one of these pins: a gateway token is an operator
 * credential with `scopes:["*"]` on the user's VM. It lives server-side only.
 */
import { afterEach, describe, expect, test } from "bun:test"
import {
  ALLOWED_GATEWAY_METHODS,
  callGateway,
  clearMemoryGatewayRecords,
  ensureGateway,
  seedMemoryGatewayRecord
} from "./gateway"
import worker from "./index"
import type { WorkerEnv } from "./index"

const GATEWAY_TOKEN = "smithers_gateway_secret-operator-token"
const CLOUD_TOKEN = "smithers_pat_cloud-identity"

const env = (extra: Partial<WorkerEnv> = {}): WorkerEnv => ({
  ASSETS: { fetch: async () => new Response("<html></html>", { status: 200 }) },
  IDENTITY_UPSTREAM_URL: "https://identity.test",
  IDENTITY_SERVICE_TOKEN: "service-token",
  SMITHERS_CLOUD_API_BASE_URL: "https://api.jjhub.test",
  ...extra
})

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

interface RelayCall {
  readonly url: string
  readonly method: string
  readonly authorization: string | null
  readonly serviceToken: string | null
  readonly body: unknown
}

/**
 * The relay double: the identity cloud-token door plus the Cloud provision
 * route and a per-gateway RPC/REST surface, each answering the exact shapes
 * the receipts recorded. `script` lets a test bend one leg at a time.
 */
const withRelay = async (
  script: {
    readonly cloudToken?: (call: RelayCall, attempt: number) => Response | undefined
    readonly provision?: (call: RelayCall, attempt: number) => Response | undefined
    readonly gateway?: (call: RelayCall, attempt: number) => Response | undefined
  },
  run: (calls: RelayCall[]) => Promise<void>
): Promise<void> => {
  const calls: RelayCall[] = []
  const attempts = { cloudToken: 0, provision: 0, gateway: 0 }
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const request = typeof input === "string"
      ? new Request(input, init)
      : input instanceof URL
      ? new Request(input.toString(), init)
      : (input as Request)
    const url = new URL(request.url)
    const raw = await request.clone().text()
    const call: RelayCall = {
      url: request.url,
      method: request.method,
      authorization: request.headers.get("authorization"),
      serviceToken: request.headers.get("x-smithers-service-token"),
      body: raw === "" ? undefined : JSON.parse(raw)
    }
    calls.push(call)
    if (url.pathname === "/api/identity/cloud-token") {
      attempts.cloudToken += 1
      return (
        script.cloudToken?.(call, attempts.cloudToken) ??
          json(200, { valid: true, login: "codeplanesmithers", found: true, token: CLOUD_TOKEN })
      )
    }
    if (/^\/api\/repos\/[^/]+\/[^/]+\/gateway$/.test(url.pathname)) {
      attempts.provision += 1
      return (
        script.provision?.(call, attempts.provision) ??
          json(200, {
            base_url: "https://api.jjhub.test/api/gateways/gw-1",
            token: GATEWAY_TOKEN,
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            gateway_id: "gw-1",
            vm_id: "msb_1",
            status: "running"
          })
      )
    }
    if (url.pathname.startsWith("/api/gateways/")) {
      attempts.gateway += 1
      return script.gateway?.(call, attempts.gateway) ?? json(200, { ok: true, apiVersion: "v1", payload: [] })
    }
    if (url.hostname === "identity.test") {
      // The session probe every workflow route gates on.
      return json(200, { login: "codeplanesmithers", allowlisted: true, admin: false })
    }
    return originalFetch(request)
  }) as typeof fetch
  try {
    await run(calls)
  } finally {
    globalThis.fetch = originalFetch
  }
}

const signedIn = (path: string, init?: RequestInit): Request =>
  new Request(`https://mvp.test${path}`, {
    ...init,
    headers: { "content-type": "application/json", cookie: "smithers_session=abc", ...(init?.headers ?? {}) }
  })

afterEach(() => clearMemoryGatewayRecords())

describe("wave 11 — provision-or-resume (§5)", () => {
  test("provisions with the user's Cloud token, adopts what comes back, and caches to the half-life", async () => {
    await withRelay({}, async (calls) => {
      const first = await ensureGateway(env(), "codeplanesmithers", "codeplanesmithers/smithers-demo")
      expect(first.status).toBe("ready")
      if (first.status !== "ready") return
      expect(first.record.gatewayId).toBe("gw-1")
      expect(first.record.token).toBe(GATEWAY_TOKEN)
      // The half-life cadence: re-resolve at the midpoint of the window.
      const window = first.record.expiresAt - Date.now()
      expect(first.record.renewAfter - Date.now()).toBeGreaterThan(window * 0.4)
      expect(first.record.renewAfter).toBeLessThan(first.record.expiresAt)

      // The door was called with the service token and the login; the
      // provision leg carried the Cloud token as a bearer.
      const door = calls.find((call) => call.url.endsWith("/api/identity/cloud-token"))
      expect(door?.serviceToken).toBe("service-token")
      expect(door?.body).toEqual({ login: "codeplanesmithers" })
      const provision = calls.find((call) => call.url.includes("/gateway"))
      expect(provision?.url).toBe("https://api.jjhub.test/api/repos/codeplanesmithers/smithers-demo/gateway")
      expect(provision?.authorization).toBe(`Bearer ${CLOUD_TOKEN}`)

      // Inside the half-life a second resolve is free: no second provision.
      const second = await ensureGateway(env(), "codeplanesmithers", "codeplanesmithers/smithers-demo")
      expect(second.status).toBe("ready")
      expect(calls.filter((call) => call.url.includes("/gateway")).length).toBe(1)
    })
  })

  test("a resolved Durable Object write failure cannot report the gateway ready", async () => {
    await withRelay({}, async () => {
      const outcome = await ensureGateway(
        env({
          GATEWAY_SESSIONS: {
            idFromName: (name) => name,
            get: () => ({
              fetch: async (request) =>
                request.method === "PUT"
                  ? new Response("storage unavailable", { status: 500 })
                  : json(200, { record: null })
            })
          }
        }),
        "will",
        "will/mvp"
      )
      expect(outcome.status).toBe("unavailable")
      expect(outcome.status === "unavailable" && outcome.detail).toContain("HTTP 500")
    })
  })

  test("a renew adopts a DIFFERENT gateway id, token and base url — nothing is assumed unchanged", async () => {
    // §5 item 3: the reprovision path legitimately hands back a different
    // gateway; every cached URL must be rebuilt from what came back.
    await withRelay(
      {
        provision: (_call, attempt) =>
          json(200, {
            base_url: `https://api.jjhub.test/api/gateways/gw-${attempt}`,
            token: `${GATEWAY_TOKEN}-${attempt}`,
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            gateway_id: `gw-${attempt}`,
            vm_id: `msb_${attempt}`
          })
      },
      async () => {
        const first = await ensureGateway(env(), "will", "will/mvp")
        expect(first.status === "ready" && first.record.gatewayId).toBe("gw-1")
        // The renew path (what a relay 401 and a past-half-life record both take).
        const second = await ensureGateway(env(), "will", "will/mvp", true)
        expect(second.status === "ready" && second.record.gatewayId).toBe("gw-2")
        expect(second.status === "ready" && second.record.token).toBe(`${GATEWAY_TOKEN}-2`)
        expect(second.status === "ready" && second.record.baseUrl).toBe(
          "https://api.jjhub.test/api/gateways/gw-2"
        )
        // And the renewed record is what a later resolve reads back.
        const third = await ensureGateway(env(), "will", "will/mvp")
        expect(third.status === "ready" && third.record.gatewayId).toBe("gw-2")
      }
    )
  })

  test("a bogus short expires_at cannot spin the provision loop — the renew floor holds", async () => {
    // The relay's `expires_at` is advisory (§5: always now + 1h, never
    // checked). A garbage timestamp must not turn the half-life cadence
    // into a per-call provision stampede, so the floor is a real minimum.
    await withRelay(
      {
        provision: () =>
          json(200, {
            base_url: "https://api.jjhub.test/api/gateways/gw-1",
            token: GATEWAY_TOKEN,
            expires_at: new Date(Date.now() + 2).toISOString(),
            gateway_id: "gw-1"
          })
      },
      async (calls) => {
        const first = await ensureGateway(env(), "will", "will/mvp")
        expect(first.status === "ready" && first.record.renewAfter - Date.now()).toBeGreaterThan(30_000)
        await new Promise((resolve) => setTimeout(resolve, 5))
        await ensureGateway(env(), "will", "will/mvp")
        await ensureGateway(env(), "will", "will/mvp")
        expect(calls.filter((call) => call.url.includes("/gateway")).length).toBe(1)
      }
    )
  })

  test("409 is 'still provisioning' — surfaced for the caller to poll, never stampeded", async () => {
    await withRelay(
      { provision: () => new Response("repo gateway provisioning is still in progress", { status: 409 }) },
      async (calls) => {
        const outcome = await ensureGateway(env(), "will", "will/mvp")
        expect(outcome.status).toBe("provisioning")
        // Exactly ONE provision attempt: this seam does not retry-loop.
        expect(calls.filter((call) => call.url.includes("/gateway")).length).toBe(1)
      }
    )
  })

  /*
   * Repro apps/ui/canary-repros/honesty/22.6: Smithers Cloud accepted the
   * provision POST and never answered, so the route hung past 70s and the
   * product left "Preparing your <repo> workspace…" standing with no run
   * card, no timeout and no error. A deadline turns silence into one of the
   * seam's own honest states — the request always ANSWERS.
   */
  test("a provision upstream that never answers becomes an honest state, not a hang", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : (input as Request).url)
      if (url.pathname === "/api/identity/cloud-token") {
        return json(200, { found: true, token: CLOUD_TOKEN })
      }
      // The exact canary shape: the connection is accepted and nothing
      // ever comes back. Only the seam's own deadline ends this.
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")))
      })
    }) as typeof fetch
    try {
      const started = Date.now()
      const outcome = await ensureGateway(
        env({ UPSTREAM_TIMEOUT_MS: "150" }),
        "codeplanesmithers",
        "codeplanesmithers/canary-sandbox"
      )
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(outcome.status).toBe("provisioning")
      if (outcome.status === "provisioning") {
        expect(outcome.detail).toContain("codeplanesmithers/canary-sandbox")
        expect(outcome.detail).toContain("longer than")
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("the provision ROUTE answers a state a client can act on when Cloud stays silent", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : (input as Request).url)
      if (url.pathname === "/api/identity/validate") {
        return json(200, { login: "codeplanesmithers", allowlisted: true, admin: false })
      }
      if (url.pathname === "/api/identity/cloud-token") {
        return json(200, { found: true, token: CLOUD_TOKEN })
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")))
      })
    }) as typeof fetch
    try {
      const response = await worker.fetch(
        signedIn("/api/workflow/provision", {
          method: "POST",
          body: JSON.stringify({ repo: "codeplanesmithers/canary-sandbox" })
        }),
        env({ UPSTREAM_TIMEOUT_MS: "150" })
      )
      expect(response.status).toBe(200)
      const body = (await response.json()) as { status: string; message: string }
      expect(body.status).toBe("provisioning")
      expect(body.message).toContain("codeplanesmithers/canary-sandbox")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("500 no_capacity is surfaced honestly and never retried", async () => {
    await withRelay(
      { provision: () => json(500, { error: "no_capacity", message: "no worker has capacity" }) },
      async (calls) => {
        const outcome = await ensureGateway(env(), "will", "will/mvp")
        expect(outcome.status).toBe("no_capacity")
        expect(outcome.status === "no_capacity" && outcome.detail).toContain("no free workspace capacity")
        expect(calls.filter((call) => call.url.includes("/gateway")).length).toBe(1)
      }
    )
  })

  test("429 quota_exceeded is the same honest no-capacity truth, not a leaked status code", async () => {
    // Caught live on canary while verifying wave 12: the pool's other refusal
    // shape is `429 {"code":"quota_exceeded","message":"concurrent sandboxes
    // limit reached"}`, which used to surface as "answered HTTP 429: {…}".
    await withRelay(
      {
        provision: () => json(429, { code: "quota_exceeded", message: "concurrent sandboxes limit reached" })
      },
      async (calls) => {
        const outcome = await ensureGateway(env(), "will", "will/mvp")
        expect(outcome.status).toBe("no_capacity")
        expect(outcome.status === "no_capacity" && outcome.detail).toContain("no free workspace capacity")
        expect(calls.filter((call) => call.url.includes("/gateway")).length).toBe(1)
      }
    )
  })

  test("a repo with no Smithers Cloud counterpart is its own state, not a raw HTTP failure", async () => {
    // Wave 12 §4: the watched set is a GITHUB set. A watched repo that has no
    // Cloud repository behind it answers 404 — a distinct, un-retryable state
    // the product states in its own words instead of leaking the status code.
    await withRelay(
      { provision: () => json(404, { error: "not_found", message: "repository not found" }) },
      async (calls) => {
        const outcome = await ensureGateway(env(), "will", "will/mvp")
        expect(outcome.status).toBe("no_cloud_repo")
        expect(outcome.status === "no_cloud_repo" && outcome.detail).toContain("isn't on Smithers Cloud yet")
        // Stated once; never retry-looped.
        expect(calls.filter((call) => call.url.includes("/gateway")).length).toBe(1)
      }
    )
  })

  test("the browser sees no-cloud-repo as a 200 state, not a 502", async () => {
    await withRelay(
      { provision: () => json(404, { error: "not_found" }) },
      async () => {
        const response = await worker.fetch(
          signedIn("/api/workflow/provision", { method: "POST", body: JSON.stringify({ repo: "will/mvp" }) }),
          env()
        )
        expect(response.status).toBe(200)
        const body = (await response.json()) as { status?: string; message?: string }
        expect(body.status).toBe("no-cloud-repo")
        expect(body.message).toContain("isn't on Smithers Cloud yet")
      }
    )
  })

  test("401 re-mints the Cloud token through the door and retries exactly ONCE", async () => {
    await withRelay(
      { provision: (_call, attempt) => (attempt <= 2 ? new Response("unauthorized", { status: 401 }) : undefined) },
      async (calls) => {
        const outcome = await ensureGateway(env(), "will", "will/mvp")
        expect(outcome.status).toBe("unavailable")
        // One re-mint, two provision attempts — bounded, not a loop.
        expect(calls.filter((call) => call.url.endsWith("/api/identity/cloud-token")).length).toBe(2)
        expect(calls.filter((call) => call.url.includes("/gateway")).length).toBe(2)
      }
    )
  })

  test("no Cloud identity is stated as itself, not as a generic failure", async () => {
    await withRelay(
      {
        cloudToken: () => json(200, { valid: true, found: false, cloud: { status: "no_github_token", reason: null } })
      },
      async (calls) => {
        const outcome = await ensureGateway(env(), "will", "will/mvp")
        expect(outcome.status).toBe("no_cloud_token")
        expect(outcome.status === "no_cloud_token" && outcome.detail).toContain("no_github_token")
        // Nothing was provisioned on a missing identity.
        expect(calls.filter((call) => call.url.includes("/gateway")).length).toBe(0)
      }
    )
  })

  test("callGateway sets the bearer the browser cannot, and joins the relay's PATH base", async () => {
    await withRelay({}, async (calls) => {
      const call = await callGateway(env(), "will", "will/mvp", "/v1/rpc/listWorkflows", {
        method: "POST",
        body: {}
      })
      expect(call.status).toBe("ok")
      const rpc = calls.find((entry) => entry.url.includes("/v1/rpc/"))
      // base_url is a PATH base — URL-joining an absolute path would drop it.
      expect(rpc?.url).toBe("https://api.jjhub.test/api/gateways/gw-1/v1/rpc/listWorkflows")
      expect(rpc?.authorization).toBe(`Bearer ${GATEWAY_TOKEN}`)
    })
  })

  test("a cached record whose gateway is GONE re-provisions and retries once", async () => {
    /*
     * §5: a gateway VM can idle-suspend or be recycled, so a cached record
     * can point at a base_url that no longer answers at all. That is stale
     * state, not a dead end — the record is rebuilt and the call retried.
     * (Caught for real: a persisted record survived a restart and every
     * relay call failed "Network connection lost" forever.)
     */
    await withRelay(
      {
        provision: (_call, attempt) =>
          json(200, {
            base_url: `https://api.jjhub.test/api/gateways/gw-${attempt}`,
            token: `${GATEWAY_TOKEN}-${attempt}`,
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            gateway_id: `gw-${attempt}`
          }),
        gateway: (call) => {
          if (call.url.includes("/api/gateways/gw-1/")) throw new Error("Network connection lost.")
          return json(200, { ok: true, payload: [] })
        }
      },
      async (calls) => {
        const call = await callGateway(env(), "will", "will/mvp", "/v1/rpc/listWorkflows", {
          method: "POST",
          body: {}
        })
        expect(call.status).toBe("ok")
        const rpcCalls = calls.filter((entry) => entry.url.includes("/v1/rpc/"))
        expect(rpcCalls).toHaveLength(2)
        expect(rpcCalls[1]?.url).toContain("/api/gateways/gw-2/")
        // Bounded: exactly two provisions, never a loop.
        expect(calls.filter((entry) => entry.url.endsWith("/gateway")).length).toBe(2)
      }
    )
  })

  test("a gateway that stays unreachable states why, once, and stops", async () => {
    await withRelay(
      {
        gateway: () => {
          throw new Error("Network connection lost.")
        }
      },
      async (calls) => {
        const call = await callGateway(env(), "will", "will/mvp", "/v1/rpc/listWorkflows", {
          method: "POST",
          body: {}
        })
        expect(call.status).toBe("unavailable")
        // The reason is stated, never swallowed into a flat sentence.
        expect(call.status === "unavailable" && call.detail).toContain("Network connection lost.")
        expect(calls.filter((entry) => entry.url.includes("/v1/rpc/"))).toHaveLength(2)
      }
    )
  })

  test("a 401 from the relay re-provisions and retries the call once with the fresh token", async () => {
    await withRelay(
      {
        provision: (_call, attempt) =>
          json(200, {
            base_url: `https://api.jjhub.test/api/gateways/gw-${attempt}`,
            token: `${GATEWAY_TOKEN}-${attempt}`,
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            gateway_id: `gw-${attempt}`
          }),
        gateway: (_call, attempt) =>
          attempt === 1
            ? json(401, { message: "invalid gateway credentials" })
            : json(200, { ok: true, payload: [{ key: "create-workflow" }] })
      },
      async (calls) => {
        const call = await callGateway(env(), "will", "will/mvp", "/v1/rpc/listWorkflows", {
          method: "POST",
          body: {}
        })
        expect(call.status).toBe("ok")
        if (call.status !== "ok") return
        expect(await call.response.json()).toEqual({ ok: true, payload: [{ key: "create-workflow" }] })
        const rpcCalls = calls.filter((entry) => entry.url.includes("/v1/rpc/"))
        expect(rpcCalls).toHaveLength(2)
        // The retry adopted the reprovisioned gateway, id and token both.
        expect(rpcCalls[1]?.url).toContain("/api/gateways/gw-2/")
        expect(rpcCalls[1]?.authorization).toBe(`Bearer ${GATEWAY_TOKEN}-2`)
      }
    )
  })
  /*
   * Caught live on canary: a gateway provisioned an hour earlier answered
   * every relay call with a Cloudflare 502 — its VM had idle-suspended (§5:
   * "VM stops; the row stays `running`, so the relay keeps 200-ing until the
   * tunnel fails. Re-POST resumes it"). Nothing re-POSTed, so the run card
   * sat in "reconnecting" for as long as the cached record lived.
   */
  test("a relay tunnel failure resumes the workspace and retries the call once", async () => {
    await withRelay(
      {
        provision: (_call, attempt) =>
          json(200, {
            base_url: `https://api.jjhub.test/api/gateways/gw-${attempt}`,
            token: `${GATEWAY_TOKEN}-${attempt}`,
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            gateway_id: `gw-${attempt}`
          }),
        gateway: (_call, attempt) =>
          attempt === 1
            ? new Response("error code: 502\n", { status: 502, headers: { "content-type": "text/plain" } })
            : json(200, { ok: true, payload: [{ key: "create-workflow" }] })
      },
      async (calls) => {
        // An hour-old record, exactly what a live DO holds when the VM
        // behind it has since idle-suspended.
        seedMemoryGatewayRecord("will", "will/mvp", {
          gatewayId: "gw-0",
          baseUrl: "https://api.jjhub.test/api/gateways/gw-0",
          token: `${GATEWAY_TOKEN}-0`,
          vmId: "msb_0",
          expiresAt: Date.now() + 30 * 60 * 1000,
          renewAfter: Date.now() + 20 * 60 * 1000,
          provisionedAt: Date.now() - 60 * 60 * 1000
        })

        const call = await callGateway(env(), "will", "will/mvp", "/v1/rpc/getRun", {
          method: "POST",
          body: { runId: "run-1" },
          replayable: true
        })
        expect(call.status).toBe("ok")
        if (call.status !== "ok") return
        expect(call.response.status).toBe(200)
        const rpcCalls = calls.filter((entry) => entry.url.includes("/v1/rpc/"))
        expect(rpcCalls).toHaveLength(2)
        expect(rpcCalls[1]?.url).toContain("/api/gateways/gw-")
      }
    )
  })

  test("a tunnel failure never replays a call a repeat could duplicate", async () => {
    await withRelay(
      {
        gateway: () => new Response("error code: 502\n", { status: 502 })
      },
      async (calls) => {
        seedMemoryGatewayRecord("will", "will/mvp", {
          gatewayId: "gw-0",
          baseUrl: "https://api.jjhub.test/api/gateways/gw-0",
          token: `${GATEWAY_TOKEN}-0`,
          vmId: null,
          expiresAt: Date.now() + 30 * 60 * 1000,
          renewAfter: Date.now() + 20 * 60 * 1000,
          provisionedAt: Date.now() - 60 * 60 * 1000
        })
        const call = await callGateway(env(), "will", "will/mvp", "/v1/rpc/launchRun", {
          method: "POST",
          body: { workflow: "create-workflow", input: { prompt: "x" } },
          replayable: false
        })
        // The workspace was resumed for the next attempt; this one is
        // reported as what it was, and the run was never launched twice.
        expect(call.status).toBe("unavailable")
        expect(call.status === "unavailable" && call.detail).toContain("gone to sleep")
        expect(calls.filter((entry) => entry.url.includes("/v1/rpc/launchRun"))).toHaveLength(1)
      }
    )
  })

  test("a tunnel failure right after provisioning is stated, not stampeded", async () => {
    await withRelay(
      {
        gateway: () => new Response("error code: 502\n", { status: 502 })
      },
      async (calls) => {
        // A record minted moments ago: re-POSTing again cannot resume
        // anything, and an EventSource reconnect loop must not drive one
        // provision call per retry.
        for (let index = 0; index < 4; index += 1) {
          const call = await callGateway(env(), "will", "will/mvp", "/v1/api/runs/run-1/events", {
            method: "GET"
          })
          expect(call.status).toBe("ok")
          if (call.status === "ok") expect(call.response.status).toBe(502)
        }
        expect(calls.filter((entry) => entry.url.endsWith("/gateway"))).toHaveLength(1)
      }
    )
  })
})

describe("wave 11 — the /api/workflow/* routes", () => {
  test("provision answers the gateway id and cadence — and NEVER the token", async () => {
    await withRelay({}, async () => {
      const response = await worker.fetch(
        signedIn("/api/workflow/provision", {
          method: "POST",
          body: JSON.stringify({ repo: "codeplanesmithers/smithers-demo" })
        }),
        env()
      )
      expect(response.status).toBe(200)
      const text = await response.text()
      expect(JSON.parse(text)).toMatchObject({ status: "ready", gatewayId: "gw-1" })
      // The one invariant that matters most on this seam.
      expect(text).not.toContain(GATEWAY_TOKEN)
      expect(text).not.toContain(CLOUD_TOKEN)
      expect(text).not.toContain("smithers_gateway")
    })
  })

  test("a signed-out caller gets 401 and nothing is provisioned", async () => {
    const originalFetch = globalThis.fetch
    let provisions = 0
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const request = typeof input === "string" ? new Request(input, init) : (input as Request)
      if (new URL(request.url).pathname.endsWith("/gateway")) provisions += 1
      return json(401, { error: "unauthorized" })
    }) as typeof fetch
    try {
      const response = await worker.fetch(
        new Request("https://mvp.test/api/workflow/provision", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ repo: "will/mvp" })
        }),
        env()
      )
      expect(response.status).toBe(401)
      expect(provisions).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("the rpc relay refuses any method outside the allowlist before touching the gateway", async () => {
    await withRelay({}, async (calls) => {
      const response = await worker.fetch(
        signedIn("/api/workflow/rpc", {
          method: "POST",
          body: JSON.stringify({ repo: "will/mvp", method: "runShell", params: { cmd: "rm -rf /" } })
        }),
        env()
      )
      expect(response.status).toBe(400)
      expect(((await response.json()) as { message: string }).message).toContain("does not relay runShell")
      expect(calls.filter((call) => call.url.includes("/api/gateways/"))).toHaveLength(0)
    })
    // The allowlist is exactly the product's seam — nothing else crosses.
    expect([...ALLOWED_GATEWAY_METHODS].sort()).toEqual([
      "getNodeOutput",
      "getRun",
      "launchRun",
      "listApprovals",
      "listWorkflows",
      "submitApproval",
      "whatHappened"
    ])
  })

  test("a malformed repo is refused before any upstream call", async () => {
    await withRelay({}, async (calls) => {
      for (const repo of ["not-a-repo", "../../etc/passwd", "owner/repo/extra", ""]) {
        const response = await worker.fetch(
          signedIn("/api/workflow/rpc", {
            method: "POST",
            body: JSON.stringify({ repo, method: "listWorkflows", params: {} })
          }),
          env()
        )
        expect(response.status).toBe(400)
      }
      expect(calls.filter((call) => call.url.includes("/api/gateways/"))).toHaveLength(0)
    })
  })

  /*
   * `..` matches every character a repository name may contain, and URL
   * parsing resolves it away — `POST /api/repos/../admin/gateway` becomes
   * `POST /api/admin/gateway`, carrying the user's server-held Cloud token
   * to a route this seam never allowlisted. Holding the token server-side is
   * pointless if the browser can still choose where it is spent.
   */
  test("a dot-segment repo cannot steer the Cloud token off the provision route", async () => {
    await withRelay({}, async (calls) => {
      for (const repo of ["../admin", "../..", "owner/..", "./config", "codeplanesmithers/."]) {
        const rpc = await worker.fetch(
          signedIn("/api/workflow/rpc", {
            method: "POST",
            body: JSON.stringify({ repo, method: "listWorkflows", params: {} })
          }),
          env()
        )
        expect(rpc.status).toBe(400)
        const provision = await worker.fetch(
          signedIn("/api/workflow/provision", { method: "POST", body: JSON.stringify({ repo }) }),
          env()
        )
        expect(provision.status).toBe(400)
      }
      // Not one call left the Worker: no Cloud token was minted, let alone spent.
      expect(calls.filter((call) => call.url.includes("/api/repos/"))).toHaveLength(0)
      expect(calls.filter((call) => call.url.endsWith("/api/identity/cloud-token"))).toHaveLength(0)
    })
    // The seam refuses it again on its own, whatever the caller did.
    const direct = await ensureGateway(env(), "codeplanesmithers", "../admin")
    expect(direct.status).toBe("unavailable")
  })

  test("a dot-PREFIXED repository name is real and stays legal", async () => {
    await withRelay({}, async () => {
      const outcome = await ensureGateway(env(), "codeplanesmithers", "codeplanesmithers/.github")
      expect(outcome.status).toBe("ready")
    })
  })

  test("two logins whose keys would concatenate identically keep separate records", async () => {
    await withRelay(
      {
        provision: (_call, attempt) =>
          json(200, {
            base_url: `https://api.jjhub.test/api/gateways/gw-${attempt}`,
            token: `${GATEWAY_TOKEN}-${attempt}`,
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            gateway_id: `gw-${attempt}`,
            vm_id: `msb_${attempt}`,
            status: "running"
          })
      },
      async () => {
        // ("ab", "c/d") and ("a", "bc/d") concatenate to the same string.
        const first = await ensureGateway(env(), "ab", "c/d")
        const second = await ensureGateway(env(), "a", "bc/d")
        expect(first.status).toBe("ready")
        expect(second.status).toBe("ready")
        if (first.status !== "ready" || second.status !== "ready") return
        expect(second.record.token).not.toBe(first.record.token)
      }
    )
  })

  test("run events relay with afterSeq resume, and the gateway's envelope passes through", async () => {
    await withRelay(
      {
        gateway: (call) =>
          json(200, {
            ok: true,
            data: [{ runId: "run-9", seq: 12, event: "node.started", payload: { nodeId: "design" } }],
            echoUrl: call.url
          })
      },
      async (calls) => {
        const response = await worker.fetch(
          signedIn("/api/workflow/events?repo=will/mvp&runId=run-9&afterSeq=11"),
          env()
        )
        expect(response.status).toBe(200)
        const body = (await response.json()) as { ok: boolean; data: Array<{ seq: number }> }
        expect(body.ok).toBe(true)
        expect(body.data[0]?.seq).toBe(12)
        const events = calls.find((call) => call.url.includes("/events"))
        expect(events?.url).toContain("/api/gateways/gw-1/v1/api/runs/run-9/events")
        expect(events?.url).toContain("afterSeq=11")
        expect(events?.authorization).toBe(`Bearer ${GATEWAY_TOKEN}`)
      }
    )
  })

  test("the SSE stream proxies Last-Event-ID through so a reconnect replays", async () => {
    await withRelay(
      {
        gateway: (call) =>
          new Response(`id: 42\nevent: change\ndata: {"seq":42}\n\n`, {
            status: 200,
            headers: { "content-type": "text/event-stream", "x-echo-last-event-id": call.url }
          })
      },
      async (calls) => {
        const response = await worker.fetch(
          signedIn("/api/workflow/stream?repo=will/mvp", { headers: { "last-event-id": "41" } }),
          env()
        )
        expect(response.status).toBe(200)
        expect(response.headers.get("content-type")).toContain("text/event-stream")
        expect(await response.text()).toContain("event: change")
        const stream = calls.find((call) => call.url.endsWith("/v1/api/stream"))
        expect(stream?.url).toBe("https://api.jjhub.test/api/gateways/gw-1/v1/api/stream")
      }
    )
  })

  test("no_capacity reaches the browser as an honest state, not a 500 and not a retry loop", async () => {
    await withRelay(
      { provision: () => json(500, { error: "no_capacity" }) },
      async (calls) => {
        const response = await worker.fetch(
          signedIn("/api/workflow/provision", {
            method: "POST",
            body: JSON.stringify({ repo: "will/mvp" })
          }),
          env()
        )
        expect(response.status).toBe(200)
        const body = (await response.json()) as { status: string; message: string }
        expect(body.status).toBe("no-capacity")
        expect(body.message).toContain("nothing was queued")
        expect(calls.filter((call) => call.url.includes("/gateway"))).toHaveLength(1)
      }
    )
  })

  test("an approval decision naming its repo round-trips through the per-user gateway", async () => {
    await withRelay(
      { gateway: () => json(200, { ok: true, payload: { runId: "run-9", nodeId: "gate", approved: true } }) },
      async (calls) => {
        const response = await worker.fetch(
          signedIn("/api/approvals/decision", {
            method: "POST",
            body: JSON.stringify({
              runId: "run-9",
              nodeId: "gate",
              iteration: 0,
              decision: { approved: true },
              repo: "will/mvp"
            })
          }),
          env()
        )
        expect(response.status).toBe(200)
        const submit = calls.find((call) => call.url.includes("/v1/rpc/submitApproval"))
        expect(submit?.url).toBe("https://api.jjhub.test/api/gateways/gw-1/v1/rpc/submitApproval")
        expect(submit?.authorization).toBe(`Bearer ${GATEWAY_TOKEN}`)
        expect(submit?.body).toEqual({
          runId: "run-9",
          nodeId: "gate",
          iteration: 0,
          decision: { approved: true }
        })
        // The client freezes the card from the flat echo — the static
        // seam's shape. The relayed gateway's RPC envelope must be
        // unwrapped to it, or the decision is recorded while the card
        // reports "the engine did not echo the decision" (live F-6).
        const echo = (await response.json()) as { approved?: unknown; runId?: unknown }
        expect(echo.approved).toBe(true)
        expect(echo.runId).toBe("run-9")
      }
    )
  })

  test("a repo-less approval keeps the static GATEWAY_UPSTREAM_URL mode (the local stub stack)", async () => {
    await withRelay({}, async (calls) => {
      const response = await worker.fetch(
        signedIn("/api/approvals/decision", {
          method: "POST",
          body: JSON.stringify({ runId: "run-9", nodeId: "gate", iteration: 0, decision: { approved: true } })
        }),
        env({ GATEWAY_UPSTREAM_URL: undefined })
      )
      // No static upstream configured → the honest not-configured answer,
      // and NOT a per-user provision.
      expect(response.status).toBe(501)
      expect(calls.filter((call) => call.url.includes("/gateway")).length).toBe(0)
    })
  })
})
