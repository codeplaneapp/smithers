import { describe, expect, test } from "bun:test"
import { createAppJwt, createGithubAppAuth, pkcs8FromPkcs1 } from "./githubApp"
import type { GithubAppDeps } from "./githubApp"

/**
 * One real RSA key pair per run. The App JWT is signed with the private half
 * and verified with the public half, so the test proves the signature GitHub
 * checks rather than the shape of a string.
 */
const pair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256" },
  true,
  ["sign", "verify"]
)

const toBase64 = (bytes: Uint8Array) => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const fromBase64 = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0))

const fromBase64Url = (value: string) =>
  fromBase64(value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4))

const armor = (label: string, der: Uint8Array) =>
  `-----BEGIN ${label}-----\n${toBase64(der).replace(/(.{64})/g, "$1\n")}\n-----END ${label}-----\n`

const pkcs8Der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))

/** One DER element at `offset`: its tag, and where its payload starts and ends. */
const element = (bytes: Uint8Array, offset: number) => {
  const tag = bytes[offset]!
  const first = bytes[offset + 1]!
  if (first < 0x80) return { tag, start: offset + 2, end: offset + 2 + first }
  const width = first & 0x7f
  let length = 0
  for (let index = 0; index < width; index += 1) length = length * 256 + bytes[offset + 2 + index]!
  return { tag, start: offset + 2 + width, end: offset + 2 + width + length }
}

/** The RSAPrivateKey inside a PrivateKeyInfo: SEQUENCE { INTEGER, SEQUENCE, OCTET STRING <this> }. */
const pkcs1Of = (pkcs8: Uint8Array) => {
  const sequence = element(pkcs8, 0)
  const version = element(pkcs8, sequence.start)
  const algorithm = element(pkcs8, version.end)
  const key = element(pkcs8, algorithm.end)
  expect([sequence.tag, version.tag, algorithm.tag, key.tag]).toEqual([0x30, 0x02, 0x30, 0x04])
  return pkcs8.subarray(key.start, key.end)
}

const PKCS1_PEM = armor("RSA PRIVATE KEY", pkcs1Of(pkcs8Der))
const PKCS8_PEM = armor("PRIVATE KEY", pkcs8Der)

const APP_ID = "4163546"
const NOW = 1_757_000_000_000
const INSTALLATION_TOKEN = "ghs_installation_token_never_served"

const decodePart = (part: string) => JSON.parse(new TextDecoder().decode(fromBase64Url(part))) as Record<string, unknown>

const installations = (accounts: ReadonlyArray<{ id: number; login: string }>) =>
  accounts.map((account) => ({
    id: account.id,
    account: { login: account.login, type: "Organization" },
    repository_selection: "all"
  }))

const SMITHERSAI_INSTALLATION = installations([{ id: 150824198, login: "smithersai" }])

interface HarnessOptions {
  readonly answer?: (request: Request) => Response | Promise<Response>
  readonly cache?: GithubAppDeps["cache"]
}

const harness = (options: HarnessOptions = {}) => {
  let now = NOW
  const requests: Array<Request> = []
  const logs: Array<string> = []
  const answer = options.answer ?? ((request: Request) =>
    new URL(request.url).pathname === "/app/installations"
      ? Response.json(SMITHERSAI_INSTALLATION)
      : Response.json({ token: INSTALLATION_TOKEN, expires_at: new Date(now + 3_600_000).toISOString() }, { status: 201 }))
  const auth = createGithubAppAuth({
    fetch: async (request) => {
      requests.push(request)
      return answer(request)
    },
    now: () => now,
    cache: options.cache ?? (() => undefined),
    log: (line) => logs.push(line)
  })
  return {
    auth,
    requests,
    logs,
    paths: () => requests.map((request) => new URL(request.url).pathname),
    advance: (ms: number) => {
      now += ms
    }
  }
}

const APP_ENV = { SMITHERS_GITHUB_APP_ID: APP_ID, SMITHERS_GITHUB_APP_PRIVATE_KEY: PKCS1_PEM }

describe("the App JWT", () => {
  test("carries an RS256 header and GitHub's claims, and verifies with the App's public key", async () => {
    const jwt = await createAppJwt(APP_ID, PKCS1_PEM, NOW)
    const [header, claims, signature] = jwt.split(".")
    expect(decodePart(header!)).toEqual({ alg: "RS256", typ: "JWT" })
    expect(decodePart(claims!)).toEqual({ iat: NOW / 1000 - 60, exp: NOW / 1000 + 540, iss: APP_ID })
    // GitHub rejects a JWT that claims more than 10 minutes of life.
    const life = decodePart(claims!).exp as number - (decodePart(claims!).iat as number)
    expect(life).toBeLessThanOrEqual(600)
    expect(jwt).not.toMatch(/[+/=]/)
    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      pair.publicKey,
      fromBase64Url(signature!),
      new TextEncoder().encode(`${header}.${claims}`)
    )
    expect(verified).toBe(true)
  })

  test("imports the PKCS#1 key GitHub issues and the PKCS#8 key openssl converts, and signs the same bytes", async () => {
    const fromPkcs1 = await createAppJwt(APP_ID, PKCS1_PEM, NOW)
    const fromPkcs8 = await createAppJwt(APP_ID, PKCS8_PEM, NOW)
    expect(fromPkcs1).toBe(fromPkcs8)
    // The hand-written DER wrapper reproduces the PrivateKeyInfo WebCrypto exports, byte for byte.
    expect(toBase64(pkcs8FromPkcs1(pkcs1Of(pkcs8Der)))).toBe(toBase64(pkcs8Der))
  })

  test("reads a key stored with escaped newlines, and refuses one with no PEM armor", async () => {
    const escaped = PKCS1_PEM.replaceAll("\n", "\\n")
    expect(await createAppJwt(APP_ID, escaped, NOW)).toBe(await createAppJwt(APP_ID, PKCS1_PEM, NOW))
    await expect(createAppJwt(APP_ID, "not a key", NOW)).rejects.toThrow()
  })
})

describe("the installation token exchange", () => {
  test("signs the lookup with the App JWT and mints a token on the smithersai installation", async () => {
    const { auth, requests, paths } = harness()
    const bearer = await auth.token(APP_ENV)
    expect(bearer).toEqual({ value: INSTALLATION_TOKEN, renewable: true })
    expect(paths()).toEqual(["/app/installations", "/app/installations/150824198/access_tokens"])
    expect(requests.map((request) => request.method)).toEqual(["GET", "POST"])
    for (const request of requests) {
      expect(request.headers.get("accept")).toBe("application/vnd.github+json")
      expect(request.headers.get("x-github-api-version")).toBe("2022-11-28")
      const jwt = request.headers.get("authorization")!.replace("Bearer ", "")
      expect(decodePart(jwt.split(".")[1]!)).toEqual({ iat: NOW / 1000 - 60, exp: NOW / 1000 + 540, iss: APP_ID })
    }
  })

  test("prefers the smithersai installation over another account's, and falls back to the first", async () => {
    const roster = installations([{ id: 1, login: "someone-else" }, { id: 150824198, login: "SmithersAI" }])
    const chosen = async (body: unknown) => {
      const { auth, paths } = harness({
        answer: (request) =>
          new URL(request.url).pathname === "/app/installations"
            ? Response.json(body)
            : Response.json({ token: INSTALLATION_TOKEN }, { status: 201 })
      })
      await auth.token(APP_ENV)
      return paths()[1]
    }
    expect(await chosen(roster)).toBe("/app/installations/150824198/access_tokens")
    expect(await chosen(installations([{ id: 42, login: "someone-else" }]))).toBe("/app/installations/42/access_tokens")
  })

  test("an App installed nowhere says so once and reads anonymously for five minutes", async () => {
    const { auth, logs, requests, advance } = harness({
      answer: (request) => new URL(request.url).pathname === "/app/installations" ? Response.json([]) : Response.json({}, { status: 500 })
    })
    expect(await auth.token(APP_ENV)).toBeUndefined()
    expect(logs).toEqual(["the GitHub App is not installed on any organization"])
    expect(requests).toHaveLength(1)
    expect(await auth.token(APP_ENV)).toBeUndefined()
    expect(requests).toHaveLength(1)
    advance(300_001)
    expect(await auth.token(APP_ENV)).toBeUndefined()
    expect(requests).toHaveLength(2)
    expect(logs).toHaveLength(2)
  })

  test("a key that cannot be imported is named without quoting it, and never reaches GitHub", async () => {
    const { auth, logs, requests } = harness()
    const broken = { ...APP_ENV, SMITHERS_GITHUB_APP_PRIVATE_KEY: armor("RSA PRIVATE KEY", Uint8Array.of(1, 2, 3, 4)) }
    expect(await auth.token(broken)).toBeUndefined()
    expect(logs).toEqual(["the GitHub App private key could not be imported"])
    expect(requests).toHaveLength(0)
    expect(logs.join("\n")).not.toContain("AQIDBA")
  })

  test("a refused lookup or exchange names the status and falls back to the anonymous read", async () => {
    for (const [path, status, line] of [
      ["/app/installations", 401, "the GitHub App installation lookup answered 401"],
      ["/access_tokens", 403, "the GitHub App installation token exchange answered 403"]
    ] as const) {
      const { auth, logs } = harness({
        answer: (request) =>
          new URL(request.url).pathname.includes(path)
            ? Response.json({ message: "refused" }, { status })
            : Response.json(SMITHERSAI_INSTALLATION)
      })
      expect(await auth.token(APP_ENV)).toBeUndefined()
      expect(logs).toEqual([line])
    }
  })

  test("a token GitHub does not send, and an unreachable GitHub, both fall back honestly", async () => {
    const empty = harness({
      answer: (request) =>
        new URL(request.url).pathname === "/app/installations"
          ? Response.json(SMITHERSAI_INSTALLATION)
          : Response.json({ expires_at: "later" }, { status: 201 })
    })
    expect(await empty.auth.token(APP_ENV)).toBeUndefined()
    expect(empty.logs).toEqual(["the GitHub App installation token exchange answered no token"])

    const offline = harness({
      answer: () => {
        throw new Error("offline")
      }
    })
    expect(await offline.auth.token(APP_ENV)).toBeUndefined()
    expect(offline.logs).toEqual(["the GitHub App installation lookup could not reach GitHub"])
  })

  test("holds the token for 55 minutes, then exchanges once more", async () => {
    const { auth, paths, advance } = harness()
    await auth.token(APP_ENV)
    await auth.token(APP_ENV)
    advance(54 * 60_000)
    await auth.token(APP_ENV)
    expect(paths()).toHaveLength(2)
    advance(60_001)
    await auth.token(APP_ENV)
    expect(paths()).toHaveLength(4)
  })

  test("never keeps a token past the expiry GitHub states", async () => {
    let now = NOW
    const paths: Array<string> = []
    const auth = createGithubAppAuth({
      fetch: async (request) => {
        const path = new URL(request.url).pathname
        paths.push(path)
        return path === "/app/installations"
          ? Response.json(SMITHERSAI_INSTALLATION)
          : Response.json({ token: INSTALLATION_TOKEN, expires_at: new Date(now + 120_000).toISOString() }, { status: 201 })
      },
      now: () => now,
      cache: () => undefined,
      log: () => {}
    })
    expect(await auth.token(APP_ENV)).toEqual({ value: INSTALLATION_TOKEN, renewable: true })
    expect(paths).toHaveLength(2)
    now += 61_000
    // 2 minutes of stated life minus a minute of slack: the held copy is already stale, so the
    // second read exchanges again. Counting the exchanges is the only assertion that fails when
    // the stated expiry is ignored: the served value is the same string either way.
    expect((await auth.token(APP_ENV))?.value).toBe(INSTALLATION_TOKEN)
    expect(paths).toHaveLength(4)
  })

  test("joins concurrent callers onto one exchange", async () => {
    const { auth, paths } = harness()
    const bearers = await Promise.all([auth.token(APP_ENV), auth.token(APP_ENV), auth.token(APP_ENV)])
    expect(bearers.map((bearer) => bearer?.value)).toEqual([INSTALLATION_TOKEN, INSTALLATION_TOKEN, INSTALLATION_TOKEN])
    expect(paths()).toHaveLength(2)
  })
})

describe("the edge copy of the installation token", () => {
  const edgeCache = () => {
    const records = new Map<string, Response>()
    return {
      records,
      cache: () => ({
        match: async (request: RequestInfo | URL) => records.get((request as Request).url)?.clone(),
        put: async (request: RequestInfo | URL, response: Response) => {
          records.set((request as Request).url, response.clone())
        },
        delete: async (request: RequestInfo | URL) => records.delete((request as Request).url)
      })
    }
  }

  test("a cold isolate reuses the token instead of exchanging again", async () => {
    const edge = edgeCache()
    const first = harness({ cache: edge.cache })
    await first.auth.token(APP_ENV)
    expect(first.paths()).toHaveLength(2)
    const cold = harness({ cache: edge.cache })
    expect((await cold.auth.token(APP_ENV))?.value).toBe(INSTALLATION_TOKEN)
    expect(cold.paths()).toHaveLength(0)
  })

  test("the entry is keyed on a URL no visitor can request, and expires with the token", async () => {
    const edge = edgeCache()
    const { auth, advance } = harness({ cache: edge.cache })
    await auth.token(APP_ENV)
    expect([...edge.records.keys()]).toEqual(["https://github-app.smithers.invalid/installation-token"])
    advance(56 * 60_000)
    const cold = harness({ cache: edge.cache })
    cold.advance(56 * 60_000)
    await cold.auth.token(APP_ENV)
    expect(cold.paths()).toHaveLength(2)
  })

  test("forget drops both copies, so the next read exchanges once", async () => {
    const edge = edgeCache()
    const { auth, paths } = harness({ cache: edge.cache })
    await auth.token(APP_ENV)
    await auth.forget()
    expect(edge.records.size).toBe(0)
    await auth.token(APP_ENV)
    expect(paths()).toHaveLength(4)
  })
})

describe("the credentials the bearer comes from", () => {
  test("GITHUB_TOKEN wins over the App and is never re-exchanged", async () => {
    const { auth, requests } = harness()
    expect(await auth.token({ ...APP_ENV, GITHUB_TOKEN: " ghp_override " })).toEqual({ value: "ghp_override", renewable: false })
    expect(requests).toHaveLength(0)
  })

  test("no App secrets and no token means an anonymous read, with nothing logged", async () => {
    const { auth, requests, logs } = harness()
    for (const env of [{}, { GITHUB_TOKEN: "" }, { SMITHERS_GITHUB_APP_ID: APP_ID }, { SMITHERS_GITHUB_APP_PRIVATE_KEY: PKCS1_PEM }]) {
      expect(await auth.token(env)).toBeUndefined()
    }
    expect(requests).toHaveLength(0)
    expect(logs).toEqual([])
  })

  test("no log line ever quotes the private key, the JWT, or the token", async () => {
    const { auth, logs } = harness({
      answer: (request) =>
        new URL(request.url).pathname === "/app/installations"
          ? Response.json(SMITHERSAI_INSTALLATION)
          : Response.json({ token: INSTALLATION_TOKEN }, { status: 500 })
    })
    await auth.token(APP_ENV)
    const written = logs.join("\n")
    expect(written).toBe("the GitHub App installation token exchange answered 500")
    expect(written).not.toContain(INSTALLATION_TOKEN)
    expect(written).not.toContain("PRIVATE KEY")
    expect(written).not.toContain(PKCS1_PEM.split("\n")[1])
  })
})
