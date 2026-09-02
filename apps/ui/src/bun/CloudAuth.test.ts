import { afterEach, describe, expect, test } from "bun:test"
import type { Server } from "bun"
import { createCloudAuth, parseCloudCredentials } from "./CloudAuth"
import type { CloudAuth, CloudKeychain } from "./CloudAuth"

/*
 * An in-memory keychain double: the real one is macOS `security`, which a
 * test must never touch (RepositoryAuthority discipline: tests bind honest
 * doubles instead of a shared machine resource).
 */
const memoryKeychain = (): CloudKeychain & { readonly store: Map<string, string> } => {
  const store = new Map<string, string>()
  return {
    store,
    read: async (service, account) => store.get(`${service}:${account}`) ?? null,
    write: async (service, account, secret) => void store.set(`${service}:${account}`, secret),
    remove: async (service, account) => void store.delete(`${service}:${account}`)
  }
}

const CREDENTIALS = {
  token: "smithers_test_token",
  username: "will",
  email: "will@codeplane.app",
  expiresAt: "2027-01-01T00:00:00Z"
}

/*
 * The fake jjhub upstream: when the login URL is opened it POSTs the
 * credentials to the callback port (the GitHub CLI flow's half), and it
 * answers the scope probe. `probeStatus`/`probeBody` shape the probe answer.
 */
const fakeUpstream = (options: { readonly probeStatus?: number; readonly probeBody?: string } = {}) => {
  const requests: Array<{ readonly path: string; readonly authorization: string | null }> = []
  const server: Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      requests.push({ path: url.pathname, authorization: request.headers.get("authorization") })
      if (url.pathname === "/api/auth/github/cli") {
        const port = Number(url.searchParams.get("callback_port"))
        // The real flow renders a GitHub page that eventually posts the minted
        // PAT back; the double posts it directly.
        void fetch(`http://127.0.0.1:${port}/callback`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(CREDENTIALS)
        })
        return new Response("<html>login</html>", { headers: { "content-type": "text/html" } })
      }
      if (url.pathname === "/api/user/workspaces") {
        return new Response(options.probeBody ?? "[]", { status: options.probeStatus ?? 200 })
      }
      return new Response("not found", { status: 404 })
    }
  })
  return { server, requests, origin: `http://127.0.0.1:${server.port}` }
}

let auth: CloudAuth | undefined
let upstream: Server<undefined> | undefined

afterEach(async () => {
  await auth?.stop()
  upstream?.stop(true)
  auth = undefined
  upstream = undefined
})

describe("parseCloudCredentials", () => {
  test("accepts the callback shape and refuses anything else whole", () => {
    expect(parseCloudCredentials(CREDENTIALS)).toEqual(CREDENTIALS)
    expect(parseCloudCredentials({ token: "x" })).toBeNull()
    expect(parseCloudCredentials({ ...CREDENTIALS, token: "" })).toBeNull()
    expect(parseCloudCredentials("nope")).toBeNull()
  })
})

describe("cloud sign-in", () => {
  test("start answers the CLI login URL; the callback signs in; the session never carries the token", async () => {
    const fake = fakeUpstream()
    upstream = fake.server
    const keychain = memoryKeychain()
    auth = await createCloudAuth({ api: fake.origin, keychain, waitTimeoutMs: 5000 })
    expect(auth.session()).toEqual({ state: "signed-out", username: null, expiresAt: null })

    const started = await auth.start()
    if ("error" in started) throw new Error(started.error)
    const login = new URL(started.url)
    expect(login.origin).toBe(fake.origin)
    expect(login.pathname).toBe("/api/auth/github/cli")
    const callbackPort = Number(login.searchParams.get("callback_port"))
    expect(callbackPort).toBeGreaterThan(0)
    expect(auth.session().state).toBe("signing-in")

    // The renderer opens the URL in the system browser; the double posts back.
    const page = await fetch(started.url)
    expect(page.status).toBe(200)
    const deadline = Date.now() + 5000
    while (auth.session().state !== "signed-in") {
      if (Date.now() > deadline) throw new Error("the callback never signed the session in")
      await Bun.sleep(10)
    }
    const session = auth.session()
    expect(session).toEqual({ state: "signed-in", username: "will", expiresAt: CREDENTIALS.expiresAt })
    expect(JSON.stringify(session)).not.toContain(CREDENTIALS.token)
    // The bearer stays Bun-side, for the proxy alone.
    expect(auth.token()).toBe(CREDENTIALS.token)
    // At rest in the keychain under the API host.
    expect(keychain.store.get(`smithers-cloud:127.0.0.1:${fake.server.port}`)).toBe(JSON.stringify(CREDENTIALS))
    // The probe ran once, with the bearer, and answered 200: not degraded.
    const probes = fake.requests.filter((request) => request.path === "/api/user/workspaces")
    expect(probes).toHaveLength(1)
    expect(probes[0]?.authorization).toBe(`Bearer ${CREDENTIALS.token}`)
  })

  test("a 403 insufficient-scope probe answer degrades the session", async () => {
    const fake = fakeUpstream({ probeStatus: 403, probeBody: JSON.stringify({ error: "insufficient token scope" }) })
    upstream = fake.server
    auth = await createCloudAuth({ api: fake.origin, keychain: memoryKeychain(), waitTimeoutMs: 5000 })
    const started = await auth.start()
    if ("error" in started) throw new Error(started.error)
    await fetch(started.url)
    const deadline = Date.now() + 5000
    while (auth.session().state !== "signed-in") {
      if (Date.now() > deadline) throw new Error("the callback never signed the session in")
      await Bun.sleep(10)
    }
    expect(auth.session()).toEqual({
      state: "signed-in",
      username: "will",
      expiresAt: CREDENTIALS.expiresAt,
      scopes: "degraded"
    })
  })

  test("a 403 that does not name scope does not degrade", async () => {
    const fake = fakeUpstream({ probeStatus: 403, probeBody: JSON.stringify({ error: "forbidden" }) })
    upstream = fake.server
    auth = await createCloudAuth({ api: fake.origin, keychain: memoryKeychain(), waitTimeoutMs: 5000 })
    const started = await auth.start()
    if ("error" in started) throw new Error(started.error)
    await fetch(started.url)
    const deadline = Date.now() + 5000
    while (auth.session().state !== "signed-in") {
      if (Date.now() > deadline) throw new Error("the callback never signed the session in")
      await Bun.sleep(10)
    }
    expect(auth.session().scopes).toBeUndefined()
  })

  test("a callback that never arrives expires the attempt back to signed-out", async () => {
    auth = await createCloudAuth({ api: "http://127.0.0.1:1", keychain: memoryKeychain(), waitTimeoutMs: 50 })
    const started = await auth.start()
    if ("error" in started) throw new Error(started.error)
    expect(auth.session().state).toBe("signing-in")
    await Bun.sleep(150)
    expect(auth.session().state).toBe("signed-out")
  })

  test("a malformed callback body is refused and the attempt stays open", async () => {
    auth = await createCloudAuth({ api: "http://127.0.0.1:1", keychain: memoryKeychain(), waitTimeoutMs: 5000 })
    const started = await auth.start()
    if ("error" in started) throw new Error(started.error)
    const port = Number(new URL(started.url).searchParams.get("callback_port"))
    const bad = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "" })
    })
    expect(bad.status).toBe(400)
    expect(auth.session().state).toBe("signing-in")
    const good = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(CREDENTIALS)
    })
    expect(good.status).toBe(200)
  })

  test("sign-out forgets the credential and clears the keychain entry", async () => {
    const fake = fakeUpstream()
    upstream = fake.server
    const keychain = memoryKeychain()
    auth = await createCloudAuth({ api: fake.origin, keychain, waitTimeoutMs: 5000 })
    const started = await auth.start()
    if ("error" in started) throw new Error(started.error)
    await fetch(started.url)
    while (auth.session().state !== "signed-in") await Bun.sleep(10)
    await auth.signOut()
    expect(auth.session()).toEqual({ state: "signed-out", username: null, expiresAt: null })
    expect(auth.token()).toBeUndefined()
    expect(keychain.store.size).toBe(0)
  })

  test("a previous launch's credential restores from the keychain", async () => {
    const keychain = memoryKeychain()
    keychain.store.set("smithers-cloud:api.jjhub.tech", JSON.stringify(CREDENTIALS))
    auth = await createCloudAuth({ api: "https://api.jjhub.tech", keychain })
    expect(auth.session()).toEqual({ state: "signed-in", username: "will", expiresAt: CREDENTIALS.expiresAt })
    expect(auth.token()).toBe(CREDENTIALS.token)
  })

  test("SMITHERS_CLOUD_TOKEN is the dev/CI override: read first, never stored", async () => {
    const keychain = memoryKeychain()
    keychain.store.set("smithers-cloud:api.jjhub.tech", JSON.stringify(CREDENTIALS))
    auth = await createCloudAuth({ api: "https://api.jjhub.tech", keychain, envToken: "smithers_env_override" })
    expect(auth.token()).toBe("smithers_env_override")
    expect(auth.session().state).toBe("signed-in")
    // The override is not a login: no stored credential is touched or reported.
    expect(auth.session().username).toBeNull()
    const started = await auth.start()
    expect("error" in started).toBe(true)
  })
})
