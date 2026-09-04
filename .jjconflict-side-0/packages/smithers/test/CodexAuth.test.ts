/**
 * The shared ChatGPT auth store over the codex CLI's `auth.json`: reading and
 * refusing the file's states, signing with the bearer and account id, the
 * proactive and reactive refresh paths, single-flight refresh under
 * concurrency, and the atomic codex-format write-back that keeps codex
 * working. Every token in these fixtures is fabricated; no real credential
 * ever appears.
 */
import { ModelError } from "@smthrs/model/ModelError"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { spawn } from "node:child_process"
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import * as CodexAuth from "../src/CodexAuth.ts"

/** A syntactically valid JWT whose payload carries only the given expiry. */
const jwt = (expiresAtSeconds: number, marker = "fake"): string =>
  `eyJhbGciOiJub25lIn0.${
    Buffer.from(JSON.stringify({ exp: expiresAtSeconds, marker })).toString("base64url")
  }.signature`

const HOUR_SECONDS = 3600
const freshJwt = () => jwt(Math.floor(Date.now() / 1000) + HOUR_SECONDS, "fresh")
const expiredJwt = () => jwt(Math.floor(Date.now() / 1000) - HOUR_SECONDS, "expired")

const authJson = (tokens: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
  `${
    JSON.stringify({
      OPENAI_API_KEY: null,
      auth_mode: "chatgpt",
      tokens,
      last_refresh: "2026-08-19T19:35:39.648449Z",
      ...extra
    })
  }\n`

const directories: Array<string> = []

const storeDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "flows-codex-auth-"))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    chmodSync(directory, 0o700)
    rmSync(directory, { recursive: true, force: true })
  }
})

const storeFile = (content: string): string => {
  const file = join(storeDirectory(), "auth.json")
  writeFileSync(file, content, { mode: 0o600 })
  return file
}

const unusedExecutor = RequestExecutor.RequestExecutor.of({
  execute: () => Effect.die(new Error("the token endpoint was not expected"))
})

/** Records every request and answers each with the handler's web response. */
const respondingExecutor = (handler: (calls: number) => Response) => {
  const seen: Array<{
    readonly request: HttpClientRequest.HttpClientRequest
    readonly options: RequestExecutor.ExecuteOptions
  }> = []
  const executor = RequestExecutor.RequestExecutor.of({
    execute: (request, options) => {
      seen.push({ request, options })
      return Effect.succeed(HttpClientResponse.fromWeb(request, handler(seen.length)))
    }
  })
  return { executor, seen }
}

const refreshBody = (request: HttpClientRequest.HttpClientRequest): Record<string, unknown> =>
  request.body._tag === "Uint8Array"
    ? JSON.parse(new TextDecoder().decode(request.body.body))
    : {}

const sign = (file: string, executor: RequestExecutor.RequestExecutor, modelId = "gpt-5.6-sol") =>
  Effect.runPromise(CodexAuth.make({ file, executor }).auth({ modelId }).sign({}))

const signError = (file: string, executor: RequestExecutor.RequestExecutor) =>
  Effect.runPromise(Effect.flip(CodexAuth.make({ file, executor }).auth({ modelId: "gpt-5.6-sol" }).sign({})))

const refreshChild = fileURLToPath(new URL("./fixtures/codex-auth-refresh-child.ts", import.meta.url))

const childSign = (file: string, endpoint: string): Promise<Record<string, string>> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", refreshChild, file, endpoint],
      { cwd: join(fileURLToPath(new URL("../../..", import.meta.url))) }
    )
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk
    })
    child.once("error", reject)
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`refresh child exited ${code}: ${stderr}`))
        return
      }
      resolve(JSON.parse(stdout))
    })
  })

describe("CodexAuth.locate", () => {
  it("resolves $CODEX_HOME/auth.json, defaulting to ~/.codex exactly as codex does", () => {
    expect(CodexAuth.locate({ CODEX_HOME: "/lane/codex-home" })).toBe("/lane/codex-home/auth.json")
    // An empty value is treated like an unset one, the resolver's convention.
    expect(CodexAuth.locate({ CODEX_HOME: "" })).toBe(CodexAuth.locate({}))
    expect(CodexAuth.locate({})).toMatch(/\/\.codex\/auth\.json$/)
  })
})

describe("CodexAuth sign", () => {
  it("signs with the bearer and the account id without touching the token endpoint", async () => {
    const access = freshJwt()
    const file = storeFile(authJson({
      id_token: "fake-id-token",
      access_token: access,
      refresh_token: "fake-refresh-token",
      account_id: "acct-fake-123"
    }))

    const headers = await sign(file, unusedExecutor)

    expect(headers).toEqual({
      Authorization: `Bearer ${access}`,
      "chatgpt-account-id": "acct-fake-123"
    })
  })

  it("omits the account header when the store holds no account id", async () => {
    const access = freshJwt()
    const file = storeFile(authJson({ access_token: access, refresh_token: "fake-refresh-token" }))

    const headers = await sign(file, unusedExecutor)

    expect(headers).toEqual({ Authorization: `Bearer ${access}` })
  })

  it("assumes an unreadable token payload is valid rather than refreshing every request", async () => {
    // The reactive path recovers from the 401 if the assumption is wrong;
    // assuming expired would spend a refresh on every sign.
    const file = storeFile(authJson({ access_token: "opaque-not-a-jwt", refresh_token: "fake-refresh-token" }))

    const headers = await sign(file, unusedExecutor)

    expect(headers).toEqual({ Authorization: "Bearer opaque-not-a-jwt" })

    const malformedJwt = storeFile(authJson({ access_token: "header.!!!!.signature", refresh_token: "refresh" }))
    expect(await sign(malformedJwt, unusedExecutor)).toEqual({ Authorization: "Bearer header.!!!!.signature" })
  })

  it("refuses a missing store by naming the file and the login command", async () => {
    const file = join(storeDirectory(), "auth.json")

    const error = await signError(file, unusedExecutor)

    expect(error).toMatchObject({ code: "authentication" })
    expect(error.message).toContain(file)
    expect(error.message).toContain("codex login")
  })

  it("refuses a store that is not JSON without echoing its contents", async () => {
    const file = storeFile("fake-secret-soup{{{")

    const error = await signError(file, unusedExecutor)

    expect(error).toMatchObject({ code: "authentication" })
    expect(error.message).not.toContain("soup")
  })

  it("refuses an API-key login, which holds no ChatGPT token set", async () => {
    const file = storeFile(`${JSON.stringify({ OPENAI_API_KEY: "sk-fake", auth_mode: "apikey" })}\n`)

    const error = await signError(file, unusedExecutor)

    expect(error).toMatchObject({ code: "authentication" })
    expect(error.message).toContain("API-key logins cannot serve this mode")
    expect(error.message).not.toContain("sk-fake")

    for (const body of [[], { tokens: [] }, { tokens: { access_token: "", refresh_token: "refresh" } }]) {
      const malformed = storeFile(`${JSON.stringify(body)}\n`)
      expect(await signError(malformed, unusedExecutor)).toMatchObject({ code: "authentication" })
    }
  })
})

describe("CodexAuth refresh", () => {
  it("refreshes a near-expiry token through the executor and rewrites the store in codex's format", async () => {
    const rotated = freshJwt()
    const file = storeFile(authJson(
      {
        id_token: "fake-id-0",
        access_token: expiredJwt(),
        refresh_token: "fake-refresh-0",
        account_id: "acct-fake-123"
      },
      { custom_field: "kept" }
    ))
    const { executor, seen } = respondingExecutor(() =>
      new Response(
        JSON.stringify({ id_token: "fake-id-1", access_token: rotated, refresh_token: "fake-refresh-1" }),
        { status: 200 }
      )
    )

    const headers = await sign(file, executor)

    expect(headers).toEqual({ Authorization: `Bearer ${rotated}`, "chatgpt-account-id": "acct-fake-123" })
    expect(seen).toHaveLength(1)
    // Under the seat's own model capability, so the kernel's redaction and
    // permission checks cover the token endpoint like any model call.
    expect(seen[0]?.options.modelId).toBe("gpt-5.6-sol")
    expect(seen[0]?.request.url).toBe(CodexAuth.refreshUrl)
    expect(refreshBody(seen[0]!.request)).toEqual({
      client_id: CodexAuth.clientId,
      grant_type: "refresh_token",
      refresh_token: "fake-refresh-0",
      scope: "openid profile email"
    })

    const written = JSON.parse(readFileSync(file, "utf8"))
    expect(written.tokens).toEqual({
      id_token: "fake-id-1",
      access_token: rotated,
      refresh_token: "fake-refresh-1",
      // Not in the refresh response; codex expects it to survive untouched.
      account_id: "acct-fake-123"
    })
    expect(written.OPENAI_API_KEY).toBeNull()
    expect(written.auth_mode).toBe("chatgpt")
    expect(written.custom_field).toBe("kept")
    // RFC3339 with six fractional digits, the format codex writes.
    expect(written.last_refresh).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
    expect(written.last_refresh).not.toBe("2026-08-19T19:35:39.648449Z")
    expect(statSync(file).mode & 0o777).toBe(0o600)
    // The write is atomic: rename left no temporary behind.
    expect(readdirSync(join(file, ".."))).toEqual(["auth.json"])
  })

  it("keeps the previous refresh token when the endpoint's answer omits one", async () => {
    const rotated = freshJwt()
    const file = storeFile(authJson({ access_token: expiredJwt(), refresh_token: "fake-refresh-0" }))
    const { executor } = respondingExecutor(() =>
      new Response(JSON.stringify({ access_token: rotated }), { status: 200 })
    )

    await sign(file, executor)

    const written = JSON.parse(readFileSync(file, "utf8"))
    expect(written.tokens).toEqual({ access_token: rotated, refresh_token: "fake-refresh-0" })
  })

  it("spends one refresh across concurrent signs: the second entrant adopts the first's write", async () => {
    const rotated = freshJwt()
    const file = storeFile(authJson({ access_token: expiredJwt(), refresh_token: "fake-refresh-0" }))
    const { executor, seen } = respondingExecutor(() =>
      new Response(JSON.stringify({ access_token: rotated }), { status: 200 })
    )
    const auth = CodexAuth.make({ file, executor }).auth({ modelId: "gpt-5.6-sol" })

    const [first, second] = await Effect.runPromise(
      Effect.all([auth.sign({}), auth.sign({})], { concurrency: "unbounded" })
    )

    // The single-flight section re-reads the file before spending the refresh
    // token, so the loser of the race finds the rotated token and stops.
    expect(seen).toHaveLength(1)
    expect(first).toEqual({ Authorization: `Bearer ${rotated}` })
    expect(second).toEqual(first)
  })

  it("serializes refreshes across distinct stores through the auth-file lock", async () => {
    const rotated = freshJwt()
    const file = storeFile(authJson({ access_token: expiredJwt(), refresh_token: "fake-refresh-0" }))

    const observed = await Effect.runPromise(Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let calls = 0
      const executor = RequestExecutor.RequestExecutor.of({
        execute: (request) =>
          Effect.gen(function*() {
            calls += 1
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
            return HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify({ access_token: rotated }), { status: 200 })
            )
          })
      })
      const first = CodexAuth.make({ file, executor }).auth({ modelId: "gpt-5.6-sol" })
      const second = CodexAuth.make({ file, executor }).auth({ modelId: "gpt-5.6-sol" })
      const firstFiber = yield* Effect.forkChild(first.sign({}), { startImmediately: true })
      yield* Deferred.await(started)
      const secondFiber = yield* Effect.forkChild(second.sign({}), { startImmediately: true })
      yield* Effect.sleep("50 millis")
      yield* Deferred.succeed(release, undefined)
      const headers = yield* Effect.all([Fiber.join(firstFiber), Fiber.join(secondFiber)])
      return { calls, headers }
    }))

    expect(observed.calls).toBe(1)
    expect(observed.headers).toEqual([
      { Authorization: `Bearer ${rotated}` },
      { Authorization: `Bearer ${rotated}` }
    ])
    expect(readdirSync(join(file, ".."))).toEqual(["auth.json"])
  })

  it("spends a one-use refresh token once across two real processes", async () => {
    const rotated = freshJwt()
    const file = storeFile(authJson({ access_token: expiredJwt(), refresh_token: "one-use-refresh" }))
    let calls = 0
    const server = createServer((request, response) => {
      let body = ""
      request.setEncoding("utf8")
      request.on("data", (chunk: string) => {
        body += chunk
      })
      request.on("end", () => {
        calls += 1
        const submitted = JSON.parse(body) as { readonly refresh_token?: unknown }
        if (calls !== 1 || submitted.refresh_token !== "one-use-refresh") {
          response.writeHead(409, { "content-type": "application/json" })
          response.end(JSON.stringify({ error: "refresh token already spent" }))
          return
        }
        setTimeout(() => {
          response.writeHead(200, { "content-type": "application/json" })
          response.end(JSON.stringify({ access_token: rotated, refresh_token: "rotated-refresh" }))
        }, 100)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("refresh server did not bind TCP")
    try {
      const endpoint = `http://127.0.0.1:${address.port}/token`
      const headers = await Promise.all([childSign(file, endpoint), childSign(file, endpoint)])
      expect(calls).toBe(1)
      expect(headers).toEqual([
        { Authorization: `Bearer ${rotated}` },
        { Authorization: `Bearer ${rotated}` }
      ])
      expect(JSON.parse(readFileSync(file, "utf8")).tokens).toMatchObject({
        access_token: rotated,
        refresh_token: "rotated-refresh"
      })
      expect(readdirSync(join(file, ".."))).toEqual(["auth.json"])
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error === undefined ? resolve() : reject(error))
      )
    }
  })

  it("recovers only an old lock whose owner token is not live", async () => {
    const rotated = freshJwt()
    const file = storeFile(authJson({ access_token: expiredJwt(), refresh_token: "fake-refresh-0" }))
    const lock = `${file}.refresh.lock`
    writeFileSync(lock, "2147483647", { mode: 0o600 })
    utimesSync(lock, 0, 0)
    const { executor, seen } = respondingExecutor(() =>
      new Response(JSON.stringify({ access_token: rotated }), { status: 200 })
    )

    await sign(file, executor)

    expect(seen).toHaveLength(1)
    expect(readdirSync(join(file, ".."))).toEqual(["auth.json"])
  })

  it("does not recover a stale lock while its recorded process is alive", async () => {
    const file = storeFile(authJson({ access_token: jwt(0), refresh_token: "fake-refresh-0" }))
    const lock = `${file}.refresh.lock`
    writeFileSync(lock, `${process.pid}:live`, { mode: 0o600 })
    utimesSync(lock, 0, 0)

    const exit = await Effect.runPromise(
      Effect.gen(function*() {
        yield* TestClock.setTime(10 * 60_000)
        const fiber = yield* Effect.forkChild(
          CodexAuth.make({ file, executor: unusedExecutor }).auth({ modelId: "gpt-5.6-sol" }).sign({}),
          { startImmediately: true }
        )
        yield* Effect.yieldNow
        yield* TestClock.adjust("31 seconds")
        return yield* Effect.exit(Fiber.join(fiber))
      }).pipe(Effect.provide(TestClock.layer()))
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("treats a non-positive stale-lock pid as dead without probing it", async () => {
    const rotated = freshJwt()
    const file = storeFile(authJson({ access_token: expiredJwt(), refresh_token: "fake-refresh-0" }))
    const lock = `${file}.refresh.lock`
    writeFileSync(lock, "0:invalid", { mode: 0o600 })
    utimesSync(lock, 0, 0)
    const { executor } = respondingExecutor(() =>
      new Response(JSON.stringify({ access_token: rotated }), { status: 200 })
    )

    expect(await sign(file, executor)).toEqual({ Authorization: `Bearer ${rotated}` })
  })

  it("sanitizes host refusal and preserves an already typed model failure", async () => {
    const requestFailure = async (failure: unknown) => {
      const file = storeFile(authJson({ access_token: expiredJwt(), refresh_token: "fake-refresh-0" }))
      const executor = RequestExecutor.RequestExecutor.of({
        execute: () => Effect.fail(failure as never)
      })
      return await signError(file, executor)
    }

    const untyped = await requestFailure(new Error("host secret"))
    expect(untyped).toMatchObject({ code: "authentication" })
    expect(untyped.message).not.toContain("host secret")

    const typed = new ModelError({ code: "transport", message: "safe typed failure" })
    expect(await requestFailure(typed)).toBe(typed)
  })

  it("maps an unreadable token response body to a transport failure", async () => {
    const file = storeFile(authJson({ access_token: expiredJwt(), refresh_token: "fake-refresh-0" }))
    const body = new ReadableStream({
      pull(controller) {
        controller.error(new Error("body secret"))
      }
    })
    const executor = RequestExecutor.RequestExecutor.of({
      execute: (request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body)))
    })

    const error = await signError(file, executor)
    expect(error).toMatchObject({ code: "transport" })
    expect(error.message).not.toContain("body secret")
  })

  it("refreshes reactively even when the token still looks fresh: a 401 outranks the expiry claim", async () => {
    const rotated = freshJwt()
    const file = storeFile(authJson({ access_token: freshJwt(), refresh_token: "fake-refresh-0" }))
    const { executor, seen } = respondingExecutor(() =>
      new Response(JSON.stringify({ access_token: rotated }), { status: 200 })
    )
    const auth = CodexAuth.make({ file, executor }).auth({ modelId: "gpt-5.6-sol" })

    await Effect.runPromise(auth.refresh!)

    expect(seen).toHaveLength(1)
    expect(JSON.parse(readFileSync(file, "utf8")).tokens.access_token).toBe(rotated)
  })

  it("refuses an answer without an access token by naming the endpoint, never the tokens", async () => {
    const file = storeFile(authJson({ access_token: expiredJwt(), refresh_token: "fake-refresh-0" }))
    const { executor } = respondingExecutor(() => new Response(JSON.stringify({}), { status: 200 }))

    const error = await signError(file, executor)

    expect(error).toMatchObject({ code: "authentication" })
    expect(error.message).toContain(CodexAuth.refreshUrl)
    expect(error.message).not.toContain("fake-refresh-0")
  })

  it("treats an unparseable answer exactly like a token-free one", async () => {
    const file = storeFile(authJson({ access_token: expiredJwt(), refresh_token: "fake-refresh-0" }))
    const { executor } = respondingExecutor(() => new Response("not json", { status: 200 }))

    const error = await signError(file, executor)

    expect(error).toMatchObject({ code: "authentication" })
    expect(error.message).toContain(CodexAuth.refreshUrl)
  })

  it("fails typed when the rotated tokens cannot be written back, leaving no temporary", async () => {
    const directory = storeDirectory()
    const file = join(directory, "auth.json")
    writeFileSync(file, authJson({ access_token: expiredJwt(), refresh_token: "fake-refresh-0" }), { mode: 0o600 })
    const { executor } = respondingExecutor(() =>
      new Response(JSON.stringify({ access_token: freshJwt() }), { status: 200 })
    )
    chmodSync(directory, 0o500)

    const error = await signError(file, executor)

    expect(error).toMatchObject({ code: "authentication" })
    expect(error.message).toContain(file)
    chmodSync(directory, 0o700)
    expect(readdirSync(directory)).toEqual(["auth.json"])
  })
})
