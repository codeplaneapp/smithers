import { afterEach, describe, expect, test } from "bun:test"
import {
  allowlistStateVerdict,
  auditOutcome,
  invalidLogins,
  inviteRunSummary,
  inviteWriteVerdict,
  isCi,
  parseAllowlistRead,
  parseLogins,
  readPathFor
} from "./invite-verdict.ts"

/**
 * CN-23. The probe is exercised as a real subprocess against a loopback stand-in
 * for the identity worker (a sibling deployment outside this repo, so nothing
 * here can import it). The fake keeps a mutable allowlist set and an audit log,
 * which is what makes the round trip provable: the add really has to land for
 * the read-back to answer true, and the cleanup really has to run for the set
 * to end empty. No live deployment and no credential is involved.
 */

const SCRIPT = new URL("./invite-probe.ts", import.meta.url).pathname

interface Recorded {
  readonly method: string
  readonly path: string
  readonly serviceToken: string | null
  readonly adminToken: string | null
  readonly body: unknown
}

interface FakeOptions {
  readonly allowlisted?: ReadonlyArray<string>
  /** Answer the read-back door with this status instead of 200. */
  readonly readStatus?: number
  /** Answer the read-back door with this raw body instead of the real shape. */
  readonly readBody?: string
  /** Refuse writes with this status. */
  readonly writeStatus?: number
  /** Accept the write but never actually admit the login. */
  readonly writeIsALie?: boolean
  /** Serve no admin audit read-back, as the canary identity worker does. */
  readonly noAuditDoor?: boolean
}

const identityDouble = (options: FakeOptions = {}) => {
  const allowlist = new Set(options.allowlisted ?? [])
  const audit: Array<{ login: string; action: string; requester: string }> = []
  const received: Array<Recorded> = []
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const body = request.method === "POST" ? ((await request.json()) as unknown) : undefined
      received.push({
        method: request.method,
        path: url.pathname,
        serviceToken: request.headers.get("x-smithers-service-token"),
        adminToken: request.headers.get("x-smithers-admin-token"),
        body
      })

      if (url.pathname.startsWith("/api/identity/allowlist/")) {
        if (options.readStatus !== undefined) {
          return new Response(options.readBody ?? "", { status: options.readStatus })
        }
        if (options.readBody !== undefined) return new Response(options.readBody, { status: 200 })
        const login = decodeURIComponent(url.pathname.slice("/api/identity/allowlist/".length))
        return Response.json({ login, allowlisted: allowlist.has(login) })
      }

      if (url.pathname === "/api/identity/admin/allowlist" && request.method === "POST") {
        if (options.writeStatus !== undefined) {
          return new Response(JSON.stringify({ error: "requester_required" }), { status: options.writeStatus })
        }
        const write = body as { login: string; action: string; requester: string }
        if (options.writeIsALie !== true) {
          if (write.action === "add") allowlist.add(write.login)
          else allowlist.delete(write.login)
        }
        audit.push({ login: write.login, action: write.action, requester: write.requester })
        return Response.json({ applied: true }, { status: 201 })
      }

      if (url.pathname === "/api/identity/admin/audit") {
        if (options.noAuditDoor === true) return new Response(JSON.stringify({ error: "Not found" }), { status: 404 })
        return Response.json({ entries: audit })
      }

      return new Response("not found", { status: 404 })
    }
  })
  return { server, allowlist, audit, received, origin: `http://localhost:${server.port}` }
}

let live: ReturnType<typeof identityDouble> | undefined

afterEach(() => {
  live?.server.stop(true)
  live = undefined
})

const runProbe = async (
  args: ReadonlyArray<string>,
  env: Record<string, string> = {}
): Promise<{ exitCode: number; stdout: string }> => {
  const proc = Bun.spawn(["bun", SCRIPT, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe"
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ])
  return { exitCode, stdout: `${stdout}${stderr}` }
}

describe("invite-verdict", () => {
  test("a roster is a comma or newline list, minus blanks and comments", () => {
    expect(parseLogins("alice, bob\ncarol\n# note\n")).toEqual(["alice", "bob", "carol"])
    expect(parseLogins(undefined)).toEqual([])
    expect(parseLogins("")).toEqual([])
  })

  test("roster entries that cannot be GitHub logins are named", () => {
    expect(invalidLogins(["alice", "not a login", "-bad", "ok-1"])).toEqual(["not a login", "-bad"])
  })

  test("the read path template substitutes and encodes the login", () => {
    expect(readPathFor("/api/identity/allowlist/{login}", "a b")).toBe("/api/identity/allowlist/a%20b")
    expect(readPathFor("/api/identity/allowlist/", "alice")).toBe("/api/identity/allowlist/alice")
  })

  test("a 404 read is unreadable, never a false — a missing door is not an absent login", () => {
    const read = parseAllowlistRead(404, "not found")
    expect(read.state).toBe("unreadable")
    expect(allowlistStateVerdict("alice", true, read).ok).toBe(false)
    expect(allowlistStateVerdict("alice", false, read).ok).toBe(false)
    if (read.state === "unreadable") expect(read.detail).toContain("--read-path")
  })

  test("a refused credential is unreadable and names the credential", () => {
    const read = parseAllowlistRead(403, "nope")
    expect(read.state).toBe("unreadable")
    if (read.state === "unreadable") expect(read.detail).toContain("IDENTITY_SERVICE_TOKEN")
  })

  test("a 200 with no boolean allowlisted field is unreadable, not a pass", () => {
    expect(parseAllowlistRead(200, "{\"login\":\"alice\"}").state).toBe("unreadable")
    expect(parseAllowlistRead(200, "<html>").state).toBe("unreadable")
    expect(parseAllowlistRead(200, "{\"login\":\"alice\",\"allowlisted\":\"yes\"}").state).toBe("unreadable")
  })

  test("a well-formed read decides both directions", () => {
    expect(parseAllowlistRead(200, "{\"allowlisted\":true}")).toEqual({ state: "known", allowlisted: true })
    expect(allowlistStateVerdict("alice", true, { state: "known", allowlisted: true }).ok).toBe(true)
    expect(allowlistStateVerdict("alice", true, { state: "known", allowlisted: false }).ok).toBe(false)
    expect(allowlistStateVerdict("alice", false, { state: "known", allowlisted: false }).ok).toBe(true)
  })

  test("an unattributed write is reported as such", () => {
    expect(inviteWriteVerdict(201, "{\"applied\":true}").ok).toBe(true)
    const refused = inviteWriteVerdict(400, "{\"error\":\"requester_required\"}")
    expect(refused.ok).toBe(false)
    expect(refused.detail).toContain("unattributed")
  })

  test("the audit outcome needs both the login and the requester", () => {
    expect(
      auditOutcome(200, "[{\"login\":\"p\",\"requester\":\"canary-invite-probe\"}]", "p", "canary-invite-probe").state
    ).toBe("ok")
    expect(auditOutcome(200, "[{\"login\":\"p\",\"requester\":\"someone-else\"}]", "p", "canary-invite-probe").state)
      .toBe("fail")
    expect(auditOutcome(500, "boom", "p", "canary-invite-probe").state).toBe("fail")
  })

  test("a run that asserted nothing is red, credentialed or not", () => {
    const nothing = { passed: 0, failures: 0, skipped: 2 }
    expect(inviteRunSummary({ ...nothing, allowInconclusive: false, ci: false }).exitCode).toBe(1)
    expect(inviteRunSummary({ ...nothing, allowInconclusive: false, ci: true }).exitCode).toBe(1)
    expect(inviteRunSummary({ ...nothing, allowInconclusive: false, ci: false }).line).toContain("ASSERTED NOTHING")
  })

  test("the inconclusive escape hatch is local-only", () => {
    const nothing = { passed: 0, failures: 0, skipped: 2 }
    const local = inviteRunSummary({ ...nothing, allowInconclusive: true, ci: false })
    expect(local.exitCode).toBe(0)
    expect(local.line).toContain("INCONCLUSIVE")
    const inCi = inviteRunSummary({ ...nothing, allowInconclusive: true, ci: true })
    expect(inCi.exitCode).toBe(1)
    expect(inCi.line).toContain("refused under CI")
  })

  test("a failure outranks the escape hatch, and a checked run passes", () => {
    expect(inviteRunSummary({ passed: 1, failures: 1, skipped: 0, allowInconclusive: true, ci: false }).exitCode).toBe(
      1
    )
    expect(inviteRunSummary({ passed: 2, failures: 0, skipped: 1, allowInconclusive: false, ci: false })).toEqual({
      exitCode: 0,
      line: "CN-23 INVITE PROBE PASS: 2 check(s), 0 failures, 1 skipped."
    })
  })

  test("CI is detected from $CI, and an explicit off value is not CI", () => {
    expect(isCi({ CI: "true" })).toBe(true)
    expect(isCi({ CI: "1" })).toBe(true)
    expect(isCi({})).toBe(false)
    expect(isCi({ CI: "" })).toBe(false)
    expect(isCi({ CI: "false" })).toBe(false)
    expect(isCi({ CI: "0" })).toBe(false)
  })

  test("a deployment with no audit door is unavailable, not a failure", () => {
    // The canary identity worker answers 404 here; attribution is still
    // enforced where it is written, so this must not red the run.
    const outcome = auditOutcome(404, "{\"error\":\"Not found\"}", "p", "canary-invite-probe")
    expect(outcome.state).toBe("unavailable")
    expect(outcome.detail).toContain("no admin audit read-back")
  })
})

describe("invite-probe.ts against a stateful identity double", () => {
  test("read-only: a seeded roster passes, nothing is written, and the admission half is declared unverified", async () => {
    live = identityDouble({ allowlisted: ["alice", "bob"] })
    const result = await runProbe(["--identity", live.origin, "--logins", "alice,bob"], {
      IDENTITY_SERVICE_TOKEN: "service-123"
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("ok: allowlist seed: alice is admitted")
    expect(result.stdout).toContain("ok: allowlist seed: bob is admitted")
    expect(result.stdout).toContain("skip: an invite admits a new user")
    expect(result.stdout).toContain("--admit-probe-login")
    expect(result.stdout).toContain("CN-23 INVITE PROBE PASS")
    // The default run is safe to schedule: no write reached the deployment.
    expect(live.received.every((entry) => entry.method === "GET")).toBe(true)
    expect(live.received[0]?.serviceToken).toBe("service-123")
  })

  test("a roster login that is not seeded fails the run", async () => {
    live = identityDouble({ allowlisted: ["alice"] })
    const result = await runProbe(["--identity", live.origin, "--logins", "alice,bob"], {
      IDENTITY_SERVICE_TOKEN: "service-123"
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("ok: allowlist seed: alice is admitted")
    expect(result.stdout).toContain("FAIL: allowlist seed: bob is admitted — bob: allowlisted=false")
    expect(result.stdout).toContain("CN-23 INVITE PROBE FAILED")
  })

  test("a read-back door that answers 404 fails loudly instead of reporting everyone unadmitted", async () => {
    live = identityDouble({ allowlisted: ["alice"], readStatus: 404 })
    const result = await runProbe(["--identity", live.origin, "--logins", "alice"], {
      IDENTITY_SERVICE_TOKEN: "service-123"
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("NOT evidence the login is off the allowlist")
  })

  test("an unrecognized read-back shape fails rather than passing vacuously", async () => {
    live = identityDouble({ allowlisted: ["alice"], readBody: "{\"login\":\"alice\"}" })
    const result = await runProbe(["--identity", live.origin, "--logins", "alice"], {
      IDENTITY_SERVICE_TOKEN: "service-123"
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("carries no boolean \"allowlisted\" field")
  })

  test("no credential skips the check and touches nothing, and the run is still red for asserting nothing", async () => {
    live = identityDouble({ allowlisted: ["alice"] })
    const result = await runProbe(["--identity", live.origin, "--logins", "alice"])
    expect(result.stdout).toContain("skip: allowlist seed — neither IDENTITY_SERVICE_TOKEN nor IDENTITY_ADMIN_TOKEN")
    expect(result.stdout).not.toContain("FAIL: allowlist seed")
    expect(live.received).toEqual([])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("CN-23 ASSERTED NOTHING")
  })

  test("an empty roster skips with the variable named, and never passes vacuously", async () => {
    live = identityDouble()
    const result = await runProbe(["--identity", live.origin], { IDENTITY_SERVICE_TOKEN: "service-123" })
    expect(result.stdout).toContain("CANARY_ALLOWLIST_LOGINS")
    expect(result.stdout).toContain("An empty roster proves nothing")
    expect(result.stdout).not.toContain("ok: allowlist seed")
    // A credential with no roster verifies exactly as much as no credential.
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("CN-23 ASSERTED NOTHING")
  })

  test("a roster entry that cannot be a GitHub login is refused before any network call", async () => {
    live = identityDouble()
    const result = await runProbe(["--identity", live.origin, "--logins", "alice,not a login"], {
      IDENTITY_SERVICE_TOKEN: "service-123"
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("cannot be GitHub logins — not a login")
    expect(live.received).toEqual([])
  })

  test("a malformed --probe-login is refused before any network call", async () => {
    live = identityDouble()
    const result = await runProbe(["--identity", live.origin, "--admit-probe-login", "--probe-login", "-nope-"], {
      IDENTITY_ADMIN_TOKEN: "admin-123"
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("cannot be GitHub logins — -nope-")
    expect(live.received).toEqual([])
  })

  test("--admit-probe-login runs the round trip and leaves the allowlist exactly as it found it", async () => {
    live = identityDouble({ allowlisted: ["alice"] })
    const result = await runProbe(["--identity", live.origin, "--logins", "alice", "--admit-probe-login"], {
      IDENTITY_SERVICE_TOKEN: "service-123",
      IDENTITY_ADMIN_TOKEN: "admin-123"
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("ok: a fresh probe login starts off the allowlist")
    expect(result.stdout).toContain("ok: the admin allowlist door accepts the invite")
    expect(result.stdout).toContain("ok: the invited login is admitted")
    expect(result.stdout).toContain("ok: the invite is attributed in the audit log")
    expect(result.stdout).toContain("ok: the probe login is off the allowlist again")
    // The production-state promise: the seeded roster is untouched and the probe login is gone.
    expect([...live.allowlist]).toEqual(["alice"])
    expect(live.audit.map((entry) => entry.action)).toEqual(["add", "remove"])
    expect(live.audit.every((entry) => entry.requester === "canary-invite-probe")).toBe(true)
    const writes = live.received.filter((entry) => entry.method === "POST")
    expect(writes.every((entry) => entry.adminToken === "admin-123")).toBe(true)
  })

  test("a deployment with no audit door still passes: the CN-23 assertion does not depend on it", async () => {
    live = identityDouble({ noAuditDoor: true })
    const result = await runProbe(["--identity", live.origin, "--admit-probe-login"], {
      IDENTITY_SERVICE_TOKEN: "service-123",
      IDENTITY_ADMIN_TOKEN: "admin-123"
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("ok: the invited login is admitted")
    expect(result.stdout).toContain("skip: the invite is attributed in the audit log")
    expect(result.stdout).toContain("no admin audit read-back")
  })

  test("a write the deployment accepts but does not honor fails the CN-23 assertion, and still cleans up", async () => {
    live = identityDouble({ writeIsALie: true })
    const result = await runProbe(["--identity", live.origin, "--admit-probe-login"], {
      IDENTITY_SERVICE_TOKEN: "service-123",
      IDENTITY_ADMIN_TOKEN: "admin-123"
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("ok: the admin allowlist door accepts the invite")
    expect(result.stdout).toContain("FAIL: the invited login is admitted")
    // Cleanup is in a finally, so it runs after a failed check.
    expect(live.audit.map((entry) => entry.action)).toEqual(["add", "remove"])
  })

  test("a refused invite fails, and the cleanup write still runs", async () => {
    live = identityDouble({ writeStatus: 400 })
    const result = await runProbe(["--identity", live.origin, "--admit-probe-login"], {
      IDENTITY_SERVICE_TOKEN: "service-123",
      IDENTITY_ADMIN_TOKEN: "admin-123"
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("FAIL: the admin allowlist door accepts the invite")
    expect(result.stdout).toContain("unattributed")
    expect(live.received.filter((entry) => entry.method === "POST").length).toBe(2)
  })

  test("a probe login left behind by a crashed run is reported and removed, not silently re-added", async () => {
    live = identityDouble({ allowlisted: ["canary-invite-probe"] })
    const result = await runProbe(["--identity", live.origin, "--admit-probe-login"], {
      IDENTITY_SERVICE_TOKEN: "service-123",
      IDENTITY_ADMIN_TOKEN: "admin-123"
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("an earlier run did not reach its cleanup")
    expect([...live.allowlist]).toEqual([])
  })

  /*
   * The regression this trio pins. The probe used to print INCONCLUSIVE and
   * exit 0 when nothing was verified, so a CI step wired up before its secrets
   * existed would have been green on every deploy while asserting nothing
   * about the allowlist.
   */
  test("a run that verified nothing exits 1, like CN-18's ASSERTED NOTHING", async () => {
    live = identityDouble()
    const result = await runProbe(["--identity", live.origin])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("CN-23 ASSERTED NOTHING: 0 checks ran, 2 skipped.")
    expect(result.stdout).toContain("IDENTITY_SERVICE_TOKEN")
    expect(result.stdout).toContain("--allow-inconclusive")
    expect(result.stdout).not.toContain("PROBE PASS")
  })

  test("--allow-inconclusive lets an uncredentialed local run end green", async () => {
    live = identityDouble()
    const result = await runProbe(["--identity", live.origin, "--allow-inconclusive"], { CI: "" })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("CN-23 INVITE PROBE INCONCLUSIVE: nothing was verified, 2 skipped.")
    expect(result.stdout).not.toContain("PROBE PASS")
  })

  test("--allow-inconclusive is refused under CI, so the escape hatch cannot green a CI step", async () => {
    live = identityDouble()
    const result = await runProbe(["--identity", live.origin, "--allow-inconclusive"], { CI: "true" })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("CN-23 ASSERTED NOTHING")
    expect(result.stdout).toContain("refused under CI")
  })

  test("an unreachable identity worker fails with the target named, never a stack trace", async () => {
    const result = await runProbe(["--identity", "http://127.0.0.1:1", "--logins", "alice"], {
      IDENTITY_SERVICE_TOKEN: "service-123"
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain(
      "the identity worker is unreachable at http://127.0.0.1:1/api/identity/allowlist/alice"
    )
  })
})
