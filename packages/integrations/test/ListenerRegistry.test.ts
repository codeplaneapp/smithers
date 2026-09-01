import { Effect } from "effect"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { make as makeClient } from "../src/github/GitHubClient.ts"
import {
  DEFAULT_REGISTRY_PATH,
  DEFAULT_STATE_PATH,
  type Listener,
  type OwnershipState,
  parseRegistry,
  parseRemoteHooks,
  PENDING_CREATE_MAX_AGE_MS,
  plan,
  readOwnershipState,
  readRegistry,
  reconcile,
  type RemoteHook
} from "../src/github/ListenerRegistry.ts"
import { type Fixture, json, startFixture } from "./Fixture.ts"

const listener = (overrides: Partial<Listener> = {}): Listener => ({
  id: "triage",
  provider: "github",
  repository: "smithersai/smithers",
  events: ["issues"],
  flowId: "triage",
  callbackUrl: "https://hooks.example/webhooks/triage",
  secretEnv: "TRIAGE_WEBHOOK_SECRET",
  active: true,
  ...overrides
})

const hook = (overrides: Partial<RemoteHook> = {}): RemoteHook => ({
  id: 100,
  active: true,
  events: ["issues"],
  config: { url: "https://hooks.example/webhooks/triage", content_type: "json", insecure_ssl: "0" },
  ...overrides
})

const owned = (overrides: Record<string, unknown> = {}): OwnershipState => ({
  version: 1,
  github: [{
    listenerId: "triage",
    repository: "smithersai/smithers",
    hookId: 100,
    callbackUrl: "https://hooks.example/webhooks/triage",
    ...overrides
  }]
})

const hooks = (list: ReadonlyArray<RemoteHook>) => new Map([["smithersai/smithers", list]])

const NOW = 1_700_000_000_000

let workspace: string | undefined
let fixture: Fixture | undefined

afterEach(async () => {
  if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true })
  workspace = undefined
  await fixture?.close()
  fixture = undefined
})

const makeWorkspace = (registry: unknown, state?: unknown): string => {
  const root = mkdtempSync(join(tmpdir(), "smithers-listeners-"))
  workspace = root
  mkdirSync(join(root, ".smithers"), { recursive: true })
  writeFileSync(join(root, DEFAULT_REGISTRY_PATH), JSON.stringify(registry, null, 2))
  if (state !== undefined) writeFileSync(join(root, DEFAULT_STATE_PATH), JSON.stringify(state, null, 2))
  return root
}

describe("parseRegistry", () => {
  it("accepts a valid declaration and defaults active to true", () => {
    const registry = parseRegistry({
      version: 1,
      listeners: [{
        id: "triage",
        provider: "github",
        repository: "smithersai/smithers",
        events: ["issues", "issue_comment"],
        flowId: "triage",
        callbackUrl: "https://hooks.example/webhooks/triage",
        secretEnv: "TRIAGE_WEBHOOK_SECRET"
      }]
    })
    expect(registry.listeners[0]?.active).toBe(true)
  })

  it("accepts JSON text and reports unparseable text", () => {
    expect(parseRegistry(JSON.stringify({ version: 1, listeners: [] })).listeners).toEqual([])
    expect(() => parseRegistry("{oops")).toThrow(/not valid JSON/)
    expect(() => parseRegistry([])).toThrow(/must be an object/)
  })

  it("reports every problem it finds, not only the first", () => {
    let message = ""
    try {
      parseRegistry({
        version: 2,
        listeners: [{
          id: "Triage!",
          provider: "gitlab",
          repository: "not-a-repo",
          events: [],
          flowId: "",
          callbackUrl: "http://hooks.example/webhooks/triage",
          secretEnv: "lowercase",
          active: "yes",
          extra: 1
        }]
      })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain("version must be 1")
    expect(message).toContain("listeners[0].id")
    expect(message).toContain("listeners[0].provider")
    expect(message).toContain("listeners[0].repository")
    expect(message).toContain("listeners[0].events")
    expect(message).toContain("listeners[0].flowId")
    expect(message).toContain("listeners[0].secretEnv")
    expect(message).toContain("listeners[0].active")
    expect(message).toContain("listeners[0].extra is not a listener field")
  })

  it("refuses a listeners field that is not an array, and a non-object entry", () => {
    expect(() => parseRegistry({ version: 1, listeners: {} })).toThrow(/listeners must be an array/)
    expect(() => parseRegistry({ version: 1, listeners: ["nope"] })).toThrow(/must be an object/)
  })

  // The receiving route is exact, so a URL that only nearly matches produces a
  // hook whose every delivery is a 404 nobody notices.
  it("requires the callback path to match the flow exactly", () => {
    const withPath = (callbackUrl: string) => parseRegistry({ version: 1, listeners: [{ ...listener(), callbackUrl }] })
    expect(() => withPath("https://hooks.example/webhooks/triage/")).toThrow(/path must be/)
    expect(() => withPath("https://hooks.example/hooks/triage")).toThrow(/path must be/)
    expect(() => withPath("not-a-url")).toThrow(/absolute URL/)
    expect(() => withPath(1 as unknown as string)).toThrow(/must be a string/)
  })

  it("refuses a callback URL that is not plain HTTPS", () => {
    for (
      const callbackUrl of [
        "http://hooks.example/webhooks/triage",
        "https://user:pass@hooks.example/webhooks/triage",
        "https://hooks.example/webhooks/triage?x=1",
        "https://hooks.example/webhooks/triage#f"
      ]
    ) {
      expect(() => parseRegistry({ version: 1, listeners: [{ ...listener(), callbackUrl }] }))
        .toThrow(/HTTPS URL without embedded credentials/)
    }
  })

  it("refuses duplicate ids and conflicting destinations for one flow", () => {
    expect(() => parseRegistry({ version: 1, listeners: [listener(), listener({ repository: "smithersai/other" })] }))
      .toThrow(/duplicate listener id/)
    expect(() =>
      parseRegistry({
        version: 1,
        listeners: [listener(), listener({ id: "triage-2", secretEnv: "OTHER_SECRET" })]
      })
    ).toThrow(/must share callbackUrl and secretEnv/)
  })
})

describe("readRegistry and readOwnershipState", () => {
  it("reads a workspace declaration", () => {
    const root = makeWorkspace({ version: 1, listeners: [listener()] })
    expect(readRegistry(root).listeners).toHaveLength(1)
    expect(readOwnershipState(root)).toEqual({ version: 1, github: [] })
  })

  it("reports a missing declaration by path", () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-listeners-"))
    workspace = root
    expect(() => readRegistry(root)).toThrow(/Listener registry not found/)
  })

  it("refuses to reconcile against an unreadable or malformed state file", () => {
    const root = makeWorkspace({ version: 1, listeners: [listener()] })
    writeFileSync(join(root, DEFAULT_STATE_PATH), "{oops")
    expect(() => readOwnershipState(root)).toThrow(/refusing unsafe reconciliation/)
    writeFileSync(join(root, DEFAULT_STATE_PATH), JSON.stringify({ version: 1, github: [{ listenerId: 1 }] }))
    expect(() => readOwnershipState(root)).toThrow(/refusing unsafe reconciliation/)
    writeFileSync(join(root, DEFAULT_STATE_PATH), JSON.stringify({ version: 2, github: [] }))
    expect(() => readOwnershipState(root)).toThrow(/refusing unsafe reconciliation/)
  })
})

describe("plan", () => {
  it("creates a declared listener the workspace does not own", () => {
    const actions = plan({
      registry: { version: 1, listeners: [listener()] },
      state: { version: 1, github: [] },
      hooksByRepository: new Map()
    })
    expect(actions).toEqual([{
      action: "create",
      listenerId: "triage",
      repository: "smithersai/smithers",
      hookId: null,
      reason: "declared listener is missing",
      destructive: false
    }])
  })

  // Ownership is the whole safety property: a matching URL proves nothing,
  // because anyone can point a hook anywhere.
  it("reports an unowned hook on the declared URL as a conflict, never an update", () => {
    const actions = plan({
      registry: { version: 1, listeners: [listener()] },
      state: { version: 1, github: [] },
      hooksByRepository: hooks([hook()])
    })
    expect(actions).toHaveLength(1)
    expect(actions[0]?.action).toBe("conflict")
    expect(actions[0]?.hookId).toBe(100)
  })

  it("leaves an unowned hook on some other URL alone, once per repository", () => {
    const actions = plan({
      registry: { version: 1, listeners: [listener(), listener({ id: "triage-2" })] },
      state: { version: 1, github: [] },
      hooksByRepository: hooks([hook({ id: 200, config: { url: "https://someone-else.example/hook" } })])
    })
    expect(actions.filter((action) => action.action === "leave")).toEqual([{
      action: "leave",
      listenerId: null,
      repository: "smithersai/smithers",
      hookId: 200,
      reason: "GitHub hook is not owned by this workspace",
      destructive: false
    }])
  })

  it("is a noop when the owned hook matches", () => {
    const actions = plan({
      registry: { version: 1, listeners: [listener()] },
      state: owned(),
      hooksByRepository: hooks([hook()])
    })
    expect(actions.map((action) => action.action)).toEqual(["noop"])
  })

  it("updates on every kind of drift", () => {
    const drifted: ReadonlyArray<RemoteHook> = [
      hook({ config: { url: "https://old.example/webhooks/triage", content_type: "json", insecure_ssl: "0" } }),
      hook({ config: { url: "https://hooks.example/webhooks/triage", content_type: "form", insecure_ssl: "0" } }),
      hook({ config: { url: "https://hooks.example/webhooks/triage", content_type: "json", insecure_ssl: "1" } }),
      hook({ active: false }),
      hook({ events: ["issues", "pull_request"] })
    ]
    for (const remote of drifted) {
      const actions = plan({
        registry: { version: 1, listeners: [listener()] },
        state: owned(),
        hooksByRepository: hooks([remote])
      })
      expect(actions.map((action) => action.action)).toEqual(["update"])
    }
  })

  it("treats a rotated secret as drift", () => {
    const actions = plan({
      registry: { version: 1, listeners: [listener()] },
      state: owned({ secretDigest: "old" }),
      hooksByRepository: hooks([hook()]),
      secretDigests: new Map([["triage", "new"]])
    })
    expect(actions.map((action) => action.action)).toEqual(["update"])
  })

  it("ignores event order and duplicates", () => {
    const actions = plan({
      registry: { version: 1, listeners: [listener({ events: ["issue_comment", "issues", "issues"] })] },
      state: owned(),
      hooksByRepository: hooks([hook({ events: ["issues", "issue_comment"] })])
    })
    expect(actions.map((action) => action.action)).toEqual(["noop"])
  })

  it("recreates an owned hook somebody deleted remotely", () => {
    const actions = plan({
      registry: { version: 1, listeners: [listener()] },
      state: owned(),
      hooksByRepository: hooks([])
    })
    expect(actions.map((action) => action.action)).toEqual(["create"])
    expect(actions[0]?.reason).toBe("owned GitHub hook was removed remotely")
  })

  it("expresses a repository move as a delete plus a create", () => {
    const actions = plan({
      registry: { version: 1, listeners: [listener({ repository: "smithersai/other" })] },
      state: owned(),
      hooksByRepository: hooks([hook()])
    })
    expect(actions.map((action) => action.action)).toEqual(["delete", "create"])
    expect(actions[0]?.destructive).toBe(true)
  })

  it("deletes an owned hook whose listener the declaration dropped", () => {
    const actions = plan({
      registry: { version: 1, listeners: [] },
      state: owned(),
      hooksByRepository: hooks([hook()])
    })
    expect(actions).toEqual([{
      action: "delete",
      listenerId: "triage",
      repository: "smithersai/smithers",
      hookId: 100,
      reason: "owned listener was removed from the registry",
      destructive: true
    }])
  })

  it("plans nothing for an owned hook that no longer exists remotely and is no longer declared", () => {
    const actions = plan({
      registry: { version: 1, listeners: [] },
      state: owned(),
      hooksByRepository: hooks([])
    })
    expect(actions).toEqual([])
  })

  it("accepts an empty repository entry", () => {
    const actions = plan({
      registry: { version: 1, listeners: [listener()] },
      state: { version: 1, github: [] },
      hooksByRepository: new Map([["other/repo", [hook()]]])
    })
    expect(actions.map((action) => action.action)).toEqual(["create"])
  })
})

describe("reconcile", () => {
  const env = (extra: Record<string, string> = {}) => ({
    GITHUB_TOKEN: "token",
    TRIAGE_WEBHOOK_SECRET: "hook-secret",
    ...extra
  })

  it("plans without applying by default", async () => {
    const root = makeWorkspace({ version: 1, listeners: [listener()] })
    fixture = await startFixture((_request, response) => json(response, 200, []))
    const result = await Effect.runPromise(reconcile({
      workspaceRoot: root,
      env: env(),
      client: makeClient({ token: "token", apiBaseUrl: fixture.origin })
    }))
    expect(result.changes).toBe(1)
    expect(result.applied).toEqual([])
    expect(result.skipped.map((action) => action.action)).toEqual(["create"])
    expect(fixture.requests.every((request) => request.method === "GET")).toBe(true)
  })

  it("creates the hook and records ownership when applying", async () => {
    const root = makeWorkspace({ version: 1, listeners: [listener()] })
    fixture = await startFixture((request, response) => {
      if (request.method === "GET") {
        json(response, 200, [])
        return
      }
      json(response, 201, { id: 555 })
    })
    const result = await Effect.runPromise(reconcile({
      workspaceRoot: root,
      apply: true,
      env: env(),
      client: makeClient({ token: "token", apiBaseUrl: fixture.origin })
    }))
    expect(result.applied.map((action) => action.action)).toEqual(["create"])
    const created = fixture.requests.find((request) => request.method === "POST")
    expect(JSON.parse(created?.body ?? "{}")).toMatchObject({
      name: "web",
      active: true,
      events: ["issues"],
      config: {
        url: "https://hooks.example/webhooks/triage",
        content_type: "json",
        insecure_ssl: "0",
        secret: "hook-secret"
      }
    })
    const state = JSON.parse(readFileSync(join(root, DEFAULT_STATE_PATH), "utf8")) as OwnershipState
    expect(state.github[0]).toMatchObject({ listenerId: "triage", hookId: 555 })
    expect(state.github[0]?.secretDigest).toHaveLength(64)
  })

  it("refuses to apply while an unowned hook holds a declared URL", async () => {
    const root = makeWorkspace({ version: 1, listeners: [listener()] })
    fixture = await startFixture((_request, response) => json(response, 200, [hook()]))
    const failure = await Effect.runPromise(Effect.flip(reconcile({
      workspaceRoot: root,
      apply: true,
      env: env(),
      client: makeClient({ token: "token", apiBaseUrl: fixture.origin })
    })))
    expect(failure.reason).toBe("listener-conflict")
    expect(fixture.requests.some((request) => request.method !== "GET")).toBe(false)
  })

  it("skips a delete unless allowDelete is set, and then performs it", async () => {
    const root = makeWorkspace({ version: 1, listeners: [] }, owned())
    fixture = await startFixture((request, response) => {
      json(response, 200, request.method === "GET" ? [hook()] : {})
    })
    const client = makeClient({ token: "token", apiBaseUrl: fixture.origin })
    const skipped = await Effect.runPromise(
      reconcile({ workspaceRoot: root, apply: true, env: env(), client })
    )
    expect(skipped.applied).toEqual([])
    expect(skipped.skipped.map((action) => action.action)).toEqual(["delete"])
    expect(fixture.requests.some((request) => request.method === "DELETE")).toBe(false)

    const deleted = await Effect.runPromise(
      reconcile({ workspaceRoot: root, apply: true, allowDelete: true, env: env(), client })
    )
    expect(deleted.applied.map((action) => action.action)).toEqual(["delete"])
    expect(fixture.requests.some((request) => request.method === "DELETE")).toBe(true)
    expect(readOwnershipState(root).github).toEqual([])
  })

  // Applying the create half of a move without the delete half would leave two
  // live hooks for one listener, both delivering.
  it("skips the create half of a move whose delete was refused", async () => {
    const root = makeWorkspace(
      { version: 1, listeners: [listener({ repository: "smithersai/other" })] },
      owned()
    )
    // The old hook is still there, which is what makes the delete real and the
    // create dangerous: applying the create alone would leave two live hooks.
    fixture = await startFixture((request, response) =>
      json(response, 200, request.url.includes("/smithersai/smithers/") ? [hook()] : [])
    )
    const result = await Effect.runPromise(reconcile({
      workspaceRoot: root,
      apply: true,
      env: env(),
      client: makeClient({ token: "token", apiBaseUrl: fixture.origin })
    }))
    expect(result.applied).toEqual([])
    expect(result.skipped.map((action) => action.action).sort()).toEqual(["create", "delete"])
  })

  it("names the missing credential rather than the failure GitHub would report", async () => {
    const root = makeWorkspace({ version: 1, listeners: [listener()] })
    const noToken = await Effect.runPromise(Effect.flip(reconcile({ workspaceRoot: root, env: {} })))
    expect(noToken.reason).toBe("credentials-missing")
    expect(noToken.message).toContain("SMITHERS_GITHUB_TOKEN")

    const noSecret = await Effect.runPromise(
      Effect.flip(reconcile({ workspaceRoot: root, env: { GITHUB_TOKEN: "token" } }))
    )
    expect(noSecret.reason).toBe("credentials-missing")
    expect(noSecret.message).toContain("TRIAGE_WEBHOOK_SECRET")
  })

  it("explains a permission failure in terms of the scope the token needs", async () => {
    const root = makeWorkspace({ version: 1, listeners: [listener()] })
    fixture = await startFixture((_request, response) => json(response, 403, { message: "Must have admin rights" }))
    const failure = await Effect.runPromise(Effect.flip(reconcile({
      workspaceRoot: root,
      env: env(),
      client: makeClient({ token: "token", apiBaseUrl: fixture.origin })
    })))
    expect(failure.reason).toBe("permission-denied")
    expect(failure.message).toContain("admin:repo_hook")
  })

  it("refuses a hook GitHub answered without a usable id", async () => {
    const root = makeWorkspace({ version: 1, listeners: [listener()] })
    fixture = await startFixture((request, response) =>
      json(response, request.method === "GET" ? 200 : 201, request.method === "GET" ? [] : { id: 0 })
    )
    const failure = await Effect.runPromise(Effect.flip(reconcile({
      workspaceRoot: root,
      apply: true,
      env: env(),
      client: makeClient({ token: "token", apiBaseUrl: fixture.origin })
    })))
    expect(failure.reason).toBe("decode-failed")
  })

  it("takes the registry in memory and the credentials from the ambient environment", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-listeners-"))
    workspace = root
    fixture = await startFixture((_request, response) => json(response, 200, []))
    const previousToken = process.env["GITHUB_TOKEN"]
    const previousSecret = process.env["TRIAGE_WEBHOOK_SECRET"]
    process.env["GITHUB_TOKEN"] = "ambient-token"
    process.env["TRIAGE_WEBHOOK_SECRET"] = "ambient-secret"
    try {
      const result = await Effect.runPromise(reconcile({
        workspaceRoot: root,
        registry: { version: 1, listeners: [listener()] },
        client: makeClient({ token: "ambient-token", apiBaseUrl: fixture.origin })
      }))
      expect(result.changes).toBe(1)
    } finally {
      if (previousToken === undefined) delete process.env["GITHUB_TOKEN"]
      else process.env["GITHUB_TOKEN"] = previousToken
      if (previousSecret === undefined) delete process.env["TRIAGE_WEBHOOK_SECRET"]
      else process.env["TRIAGE_WEBHOOK_SECRET"] = previousSecret
    }
  })

  it("updates a drifted hook in place", async () => {
    const root = makeWorkspace({ version: 1, listeners: [listener()] }, owned())
    fixture = await startFixture((request, response) => {
      json(response, 200, request.method === "GET" ? [hook({ active: false })] : { id: 100 })
    })
    const result = await Effect.runPromise(reconcile({
      workspaceRoot: root,
      apply: true,
      env: env(),
      client: makeClient({ token: "token", apiBaseUrl: fixture.origin })
    }))
    expect(result.applied.map((action) => action.action)).toEqual(["update"])
    expect(fixture.requests.some((request) => request.method === "PATCH")).toBe(true)
  })
})

describe("reconcile failure channel", () => {
  const env = (extra: Record<string, string> = {}) => ({
    GITHUB_TOKEN: "token",
    TRIAGE_WEBHOOK_SECRET: "hook-secret",
    ...extra
  })

  // `readRegistry` throws, and a throw inside `Effect.gen` is a defect. A
  // caller's `catchTag` on `IntegrationError` misses it, so the single most
  // common operator error used to crash the fiber instead of failing.
  it("fails invalid-config for a missing declaration rather than dying", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-listeners-"))
    workspace = root
    const failure = await Effect.runPromise(Effect.flip(reconcile({ workspaceRoot: root, env: env() })))
    expect(failure.reason).toBe("invalid-config")
    expect(failure.message).toContain("Listener registry not found")
  })

  it("fails invalid-config for an unparseable declaration", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-listeners-"))
    workspace = root
    mkdirSync(join(root, ".smithers"), { recursive: true })
    writeFileSync(join(root, DEFAULT_REGISTRY_PATH), "{not json")
    const failure = await Effect.runPromise(Effect.flip(reconcile({ workspaceRoot: root, env: env() })))
    expect(failure.reason).toBe("invalid-config")
  })

  it("fails invalid-config for an unparseable ownership state file", async () => {
    const root = makeWorkspace({ version: 1, listeners: [listener()] })
    writeFileSync(join(root, DEFAULT_STATE_PATH), "{not json")
    const failure = await Effect.runPromise(Effect.flip(reconcile({ workspaceRoot: root, env: env() })))
    expect(failure.reason).toBe("invalid-config")
  })

  // A repository name is interpolated into the request path, and `new URL`
  // resolves dot segments, so a declaration naming `../..` would otherwise
  // walk a token-bearing GET off the endpoint it belongs to.
  it("refuses a declared repository that is not a repository name", async () => {
    const root = makeWorkspace({ version: 1, listeners: [listener({ repository: "../.." })] })
    fixture = await startFixture((_request, response) => json(response, 200, []))
    const failure = await Effect.runPromise(Effect.flip(reconcile({
      workspaceRoot: root,
      env: env(),
      client: makeClient({ token: "token", apiBaseUrl: fixture.origin })
    })))
    expect(failure.reason).toBe("invalid-config")
    expect(fixture.requests).toHaveLength(0)
  })

  // An injected client carries its own credential. Requiring an ambient token
  // as well is a check about a request this module will not make.
  it("does not require an ambient token when a client is injected", async () => {
    const root = makeWorkspace({ version: 1, listeners: [listener()] })
    fixture = await startFixture((_request, response) => json(response, 200, []))
    const result = await Effect.runPromise(reconcile({
      workspaceRoot: root,
      env: { TRIAGE_WEBHOOK_SECRET: "hook-secret" },
      client: makeClient({ token: "injected", apiBaseUrl: fixture.origin })
    }))
    expect(result.changes).toBe(1)
    // The webhook secret stays required: it goes into the hook body.
    const noSecret = await Effect.runPromise(Effect.flip(reconcile({
      workspaceRoot: root,
      env: {},
      client: makeClient({ token: "injected", apiBaseUrl: fixture.origin })
    })))
    expect(noSecret.reason).toBe("credentials-missing")
  })

  // Only 401, 403, and 404 are a scope problem. A 500 is not, and rewriting it
  // as one would send an operator to the wrong place.
  it("passes a failure that is not a permission problem through unchanged", async () => {
    const root = makeWorkspace({ version: 1, listeners: [listener()] })
    fixture = await startFixture((_request, response) => json(response, 500, { message: "server error" }))
    const failure = await Effect.runPromise(Effect.flip(reconcile({
      workspaceRoot: root,
      env: env(),
      client: makeClient({ token: "token", apiBaseUrl: fixture.origin, maxRetries: 0 })
    })))
    expect(failure.reason).toBe("delivery-failed")
    expect(failure.message).not.toContain("admin:repo_hook")
  })

  it("refuses a hook list GitHub returned in a shape it cannot read", async () => {
    const root = makeWorkspace({ version: 1, listeners: [listener()] })
    fixture = await startFixture((_request, response) => json(response, 200, [{ id: 1, active: true }]))
    const failure = await Effect.runPromise(Effect.flip(reconcile({
      workspaceRoot: root,
      env: env(),
      client: makeClient({ token: "token", apiBaseUrl: fixture.origin })
    })))
    expect(failure.reason).toBe("decode-failed")
    expect(failure.details).toMatchObject({ field: "config", index: 0 })
  })

  // Planning against a truncated hook list emits a `create` for a hook that is
  // simply past the page budget, so the repository ends up with two.
  it("refuses to plan against a hook list it could not read to the end", async () => {
    const root = makeWorkspace({ version: 1, listeners: [listener()] })
    fixture = await startFixture((_request, response) =>
      json(response, 200, [hook()], { link: `<${(fixture as Fixture).origin}/next>; rel="next"` })
    )
    const failure = await Effect.runPromise(Effect.flip(reconcile({
      workspaceRoot: root,
      env: env(),
      client: makeClient({ token: "token", apiBaseUrl: fixture.origin })
    })))
    expect(failure.message).toContain("incomplete list")
  })
})

describe("collision preflight on every create", () => {
  const moved = listener({ repository: "smithersai/other" })

  // `hooksByRepository` already holds the destination's hooks in both of these
  // cases; the check simply was not consulted, so apply could add a second
  // hook beside an unowned one and double every delivery.
  it("reports a conflict when a moved listener lands on an unowned hook", () => {
    const actions = plan({
      registry: { version: 1, listeners: [moved] },
      state: owned(),
      hooksByRepository: new Map([["smithersai/smithers", [hook()]], ["smithersai/other", [hook({ id: 900 })]]])
    })
    expect(actions.map((action) => [action.action, action.repository])).toEqual([
      ["delete", "smithersai/smithers"],
      ["conflict", "smithersai/other"]
    ])
  })

  it("reports a conflict when a remotely deleted hook's URL is held by an unowned one", () => {
    const actions = plan({
      registry: { version: 1, listeners: [listener()] },
      state: owned(),
      hooksByRepository: hooks([hook({ id: 901 })])
    })
    expect(actions.map((action) => action.action)).toEqual(["conflict"])
  })

  it("still creates when the destination has no hook on that URL", () => {
    const actions = plan({
      registry: { version: 1, listeners: [moved] },
      state: owned(),
      hooksByRepository: new Map([["smithersai/smithers", [hook()]], ["smithersai/other", []]])
    })
    expect(actions.map((action) => action.action)).toEqual(["delete", "create"])
  })
})

describe("converging after an interrupted create", () => {
  const env = { GITHUB_TOKEN: "token", TRIAGE_WEBHOOK_SECRET: "hook-secret" }

  // The module doc says a failure partway through leaves a state file the next
  // run converges from. Without a pending record it does not: the next run
  // sees an unowned hook on the declared URL and refuses, permanently.
  it("adopts the hook an interrupted run created instead of reporting a conflict", () => {
    const actions = plan({
      registry: { version: 1, listeners: [listener()] },
      state: {
        version: 1,
        github: [],
        pending: [{
          listenerId: "triage",
          repository: "smithersai/smithers",
          callbackUrl: "https://hooks.example/webhooks/triage",
          startedAtMs: NOW
        }]
      },
      hooksByRepository: hooks([hook()]),
      nowMs: NOW
    })
    expect(actions.map((action) => [action.action, action.hookId])).toEqual([["update", 100]])
    // And the adopted hook is not also reported as somebody else's.
    expect(actions.some((action) => action.action === "leave")).toBe(false)
  })

  // An intent is evidence, not proof. A record left by a run that died months
  // ago must not license adopting whatever hook sits on that URL today.
  it("refuses to adopt on a pending record older than the window", () => {
    const actions = plan({
      registry: { version: 1, listeners: [listener()] },
      state: {
        version: 1,
        github: [],
        pending: [{
          listenerId: "triage",
          repository: "smithersai/smithers",
          callbackUrl: "https://hooks.example/webhooks/triage",
          startedAtMs: NOW - PENDING_CREATE_MAX_AGE_MS - 1
        }]
      },
      hooksByRepository: hooks([hook()]),
      nowMs: NOW
    })
    expect(actions.map((action) => action.action)).toEqual(["conflict"])
  })

  // Two hooks on one URL means the workspace cannot tell its own from the
  // other, so it refuses rather than guessing.
  it("refuses to adopt when two hooks hold the declared URL", () => {
    const actions = plan({
      registry: { version: 1, listeners: [listener()] },
      state: {
        version: 1,
        github: [],
        pending: [{
          listenerId: "triage",
          repository: "smithersai/smithers",
          callbackUrl: "https://hooks.example/webhooks/triage",
          startedAtMs: NOW
        }]
      },
      hooksByRepository: hooks([hook(), hook({ id: 101 })]),
      nowMs: NOW
    })
    expect(actions.map((action) => action.action)).toEqual(["conflict", "leave"])
  })

  // A run that deleted the old hook and died before writing ownership used to
  // leave a plan that deleted it again forever: GitHub answered 404, apply
  // aborted before the create, and the move never completed.
  it("skips the delete half of a move whose hook is already gone", () => {
    const actions = plan({
      registry: { version: 1, listeners: [listener({ repository: "smithersai/other" })] },
      state: owned(),
      hooksByRepository: new Map([["smithersai/smithers", []], ["smithersai/other", []]]),
      nowMs: NOW
    })
    expect(actions.map((action) => action.action)).toEqual(["create"])
  })

  it("still reports a conflict for a pending record naming a different URL", () => {
    const actions = plan({
      registry: { version: 1, listeners: [listener()] },
      state: {
        version: 1,
        github: [],
        pending: [{
          listenerId: "triage",
          repository: "smithersai/smithers",
          callbackUrl: "https://hooks.example/webhooks/other",
          startedAtMs: NOW
        }]
      },
      hooksByRepository: hooks([hook()]),
      nowMs: NOW
    })
    expect(actions.map((action) => action.action)).toEqual(["conflict"])
  })

  // A record kept past a refusal would be a standing licence to adopt whatever
  // hook later appeared on that URL, which is the conflict check inverted.
  it("retires the pending record when GitHub refuses the create", async () => {
    const root = makeWorkspace({ version: 1, listeners: [listener()] })
    fixture = await startFixture((request, response) => {
      json(response, request.method === "GET" ? 200 : 422, request.method === "GET" ? [] : { message: "Validation" })
    })
    await Effect.runPromise(Effect.flip(reconcile({
      workspaceRoot: root,
      apply: true,
      env,
      client: makeClient({ token: "token", apiBaseUrl: fixture.origin })
    })))
    expect(readOwnershipState(root).pending).toEqual([])
  })

  it("drops a pending record the declaration no longer asks for", async () => {
    const stale = {
      version: 1,
      github: [],
      pending: [{
        listenerId: "triage",
        repository: "smithersai/smithers",
        callbackUrl: "https://hooks.example/webhooks/other",
        startedAtMs: Date.now()
      }]
    }
    const root = makeWorkspace({ version: 1, listeners: [listener()] }, stale)
    fixture = await startFixture((request, response) => {
      json(response, 200, request.method === "GET" ? [] : { id: 700 })
    })
    await Effect.runPromise(reconcile({
      workspaceRoot: root,
      apply: true,
      env,
      client: makeClient({ token: "token", apiBaseUrl: fixture.origin })
    }))
    expect(readOwnershipState(root).pending).toEqual([])
  })

  it("records the pending create before the POST and clears it after", async () => {
    const root = makeWorkspace({ version: 1, listeners: [listener()] })
    fixture = await startFixture((request, response) => {
      if (request.method === "GET") {
        json(response, 200, [])
        return
      }
      json(response, 500, { message: "gateway lost the answer" })
    })
    const client = makeClient({ token: "token", apiBaseUrl: fixture.origin })
    await Effect.runPromise(Effect.flip(reconcile({ workspaceRoot: root, apply: true, env, client })))
    const state = readOwnershipState(root)
    expect(state.github).toEqual([])
    expect(state.pending).toMatchObject([{
      listenerId: "triage",
      repository: "smithersai/smithers",
      callbackUrl: "https://hooks.example/webhooks/triage"
    }])
    expect(typeof state.pending?.[0]?.startedAtMs).toBe("number")

    await fixture.close()
    // The next run sees the hook GitHub did create and adopts it.
    fixture = await startFixture((request, response) => {
      json(response, 200, request.method === "GET" ? [hook()] : { id: 100 })
    })
    const adopted = await Effect.runPromise(reconcile({
      workspaceRoot: root,
      apply: true,
      env,
      client: makeClient({ token: "token", apiBaseUrl: fixture.origin })
    }))
    expect(adopted.applied.map((action) => action.action)).toEqual(["update"])
    const settled = readOwnershipState(root)
    expect(settled.github).toMatchObject([{ listenerId: "triage", hookId: 100 }])
    expect(settled.pending).toEqual([])
  })
})

describe("parseRemoteHooks", () => {
  it("accepts what GitHub returns", () => {
    expect(parseRemoteHooks([hook()], "smithersai/smithers")).toEqual([hook()])
    expect(parseRemoteHooks([], "smithersai/smithers")).toEqual([])
  })

  it("names the member and the field it could not read", () => {
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [{ ...hook(), id: "100" }, "id"],
      [{ ...hook(), id: -1 }, "id"],
      [{ ...hook(), config: null }, "config"],
      [{ ...hook(), config: { url: 7 } }, "config.url"],
      // A hook without a URL is a hook `plan` cannot compare, so it is not an
      // optional field here.
      [{ ...hook(), config: {} }, "config.url"],
      [{ ...hook(), config: { url: "https://x", content_type: 7 } }, "config.content_type"],
      [{ ...hook(), config: { url: "https://x", insecure_ssl: {} } }, "config.insecure_ssl"],
      [{ ...hook(), events: "issues" }, "events"],
      [{ ...hook(), events: [7] }, "events"],
      [{ ...hook(), active: "yes" }, "active"]
    ]
    for (const [member, field] of cases) {
      expect(() => parseRemoteHooks([member], "smithersai/smithers")).toThrow(new RegExp(`hooks\\[0\\]\\.${field}`))
    }
    expect(() => parseRemoteHooks(["not an object"], "smithersai/smithers")).toThrow(/hooks\[0\]/)
  })
})

describe("pending records are part of the state file's contract", () => {
  it("refuses a state file whose pending list is malformed", () => {
    for (
      const pending of [
        "not-an-array",
        [{ listenerId: "triage" }],
        [{ listenerId: 1, repository: "a/b", callbackUrl: "https://x", startedAtMs: 1 }],
        [{ listenerId: "triage", repository: "a/b", callbackUrl: "https://x" }],
        [{ listenerId: "triage", repository: "a/b", callbackUrl: "https://x", startedAtMs: -1 }]
      ]
    ) {
      const root = makeWorkspace({ version: 1, listeners: [listener()] }, { version: 1, github: [], pending })
      expect(() => readOwnershipState(root)).toThrow(/refusing unsafe reconciliation/)
    }
  })

  it("accepts a state file that has none", () => {
    const root = makeWorkspace({ version: 1, listeners: [listener()] }, { version: 1, github: [] })
    expect(readOwnershipState(root).pending).toEqual([])
  })
})
