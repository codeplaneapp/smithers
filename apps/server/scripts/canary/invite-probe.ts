/*
 * CN-23 — the closed-alpha entry path, probed against a real deployment.
 *
 *   bun scripts/canary/invite-probe.ts [--logins a,b] [--admit-probe-login]
 *                                      [--allow-inconclusive]
 *
 * The alpha's whole entry path is: seed the allowlist, send an invite, the
 * invited person gets in. src/invite-mechanics.test.ts and
 * src/seed-allowlist.test.ts prove that against fakes. This script is the
 * live half.
 *
 * WHY IT IS READ-ONLY BY DEFAULT
 *
 * Admitting a new user mutates production. A probe that ran the admission on
 * every scheduled tick would write to the alpha allowlist forever, and a run
 * that died mid-probe would leave litter behind. So the halves are split:
 *
 *   Default (read-only, safe to schedule): every roster login named by
 *   --logins / $CANARY_ALLOWLIST_LOGINS reads back as allowlisted. This
 *   asserts the seed is PRESENT. It does not assert an invite ADMITS, and it
 *   says so — it prints a skip line naming --admit-probe-login rather than
 *   passing as if it had checked.
 *
 *   --admit-probe-login (writes, opt-in): the full round trip on one
 *   designated probe identity — absent, invited, admitted, attributed,
 *   removed. The removal runs in a finally, so a failed check still cleans
 *   up. The identity is a FIXED login (invite-verdict.ts DEFAULT_PROBE_LOGIN),
 *   so the worst a crash can leave behind is that one known row, not a new
 *   row per run. It is not a real GitHub account, so admitting it grants
 *   nobody a session.
 *
 * Run the opt-in half after a deploy and in the manual drill in INVITES.md.
 * Do not put it on a schedule.
 *
 * EXIT CODES
 *
 *   0  every check that ran passed, and at least one check ran.
 *   1  a check failed, OR nothing was checked at all.
 *
 * A run that asserted nothing is red, matching CN-18's `ASSERTED NOTHING`. A
 * probe wired into CI before its secrets exist must not report green for an
 * assertion nobody made. --allow-inconclusive buys exit 0 for a contributor
 * running this without production credentials; it is refused when $CI is set,
 * so pasting it into a workflow file cannot restore the green.
 *
 * Credentials (all optional; a missing one skips its checks, and a run left
 * with no checks at all exits 1 — see EXIT CODES):
 *   IDENTITY_UPSTREAM_URL   the identity worker (default: the canary value in wrangler.jsonc)
 *   IDENTITY_SERVICE_TOKEN  read-back credential (x-smithers-service-token)
 *   IDENTITY_ADMIN_TOKEN    write + audit credential (x-smithers-admin-token)
 *   CANARY_ALLOWLIST_LOGINS the roster, a comma list; a repository variable, not a secret
 *   CANARY_PROBE_LOGIN      overrides the designated probe identity
 */
import {
  ALLOW_INCONCLUSIVE_FLAG,
  allowlistStateVerdict,
  auditOutcome,
  DEFAULT_PROBE_LOGIN,
  DEFAULT_READ_PATH,
  invalidLogins,
  inviteRunSummary,
  inviteWriteVerdict,
  isCi,
  parseAllowlistRead,
  parseLogins,
  PROBE_REQUESTER,
  readPathFor
} from "./invite-verdict.ts"

const DEFAULT_IDENTITY_URL = "https://smithers-cloud-identity.willcory10.workers.dev"

const argOf = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const identity = argOf("--identity") ?? process.env.IDENTITY_UPSTREAM_URL ?? DEFAULT_IDENTITY_URL
const readPath = argOf("--read-path") ?? DEFAULT_READ_PATH
const probeLogin = argOf("--probe-login") ?? process.env.CANARY_PROBE_LOGIN ?? DEFAULT_PROBE_LOGIN
const roster = parseLogins(argOf("--logins") ?? process.env.CANARY_ALLOWLIST_LOGINS)
const admitProbeLogin = process.argv.includes("--admit-probe-login")
const allowInconclusive = process.argv.includes(ALLOW_INCONCLUSIVE_FLAG)
const serviceToken = process.env.IDENTITY_SERVICE_TOKEN?.trim() ?? ""
const adminToken = process.env.IDENTITY_ADMIN_TOKEN?.trim() ?? ""

let failures = 0
let passed = 0
let skipped = 0
const check = (label: string, ok: boolean, detail: string): void => {
  if (ok) {
    passed += 1
    console.log(`ok: ${label} — ${detail}`)
  } else {
    failures += 1
    console.log(`FAIL: ${label} — ${detail}`)
  }
}
/* A skip is neither a pass nor a failure: it states what went unverified. */
const skip = (label: string, detail: string): void => {
  skipped += 1
  console.log(`skip: ${label} — ${detail}`)
}

/* Refuse a malformed login before any network call: the identity worker
 * validates writes against the same grammar, so sending one can only produce a
 * confusing upstream refusal. */
const badLogins = invalidLogins(admitProbeLogin ? [...roster, probeLogin] : roster)
if (badLogins.length > 0) {
  console.log(`FAIL: these entries cannot be GitHub logins — ${badLogins.join(", ")}`)
  process.exit(1)
}

const readHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {}
  if (serviceToken !== "") headers["x-smithers-service-token"] = serviceToken
  if (adminToken !== "") headers["x-smithers-admin-token"] = adminToken
  return headers
}

const readAllowlist = async (login: string) => {
  const target = new URL(readPathFor(readPath, login), identity).toString()
  try {
    const response = await fetch(target, { headers: readHeaders() })
    return parseAllowlistRead(response.status, await response.text())
  } catch (error) {
    return {
      state: "unreadable" as const,
      detail: `the identity worker is unreachable at ${target}: ${
        error instanceof Error ? error.message : String(error)
      }`
    }
  }
}

const writeAllowlist = async (login: string, action: "add" | "remove") => {
  const target = new URL("/api/identity/admin/allowlist", identity).toString()
  try {
    const response = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json", "x-smithers-admin-token": adminToken },
      body: JSON.stringify({ login, action, requester: PROBE_REQUESTER, timestamp: new Date().toISOString() })
    })
    return { status: response.status, body: await response.text() }
  } catch (error) {
    return { status: 0, body: error instanceof Error ? error.message : String(error) }
  }
}

/* Half one: the seed is present. */
if (serviceToken === "" && adminToken === "") {
  skip(
    "allowlist seed",
    "neither IDENTITY_SERVICE_TOKEN nor IDENTITY_ADMIN_TOKEN is set, so the allowlist cannot be read back"
  )
} else if (roster.length === 0) {
  skip(
    "allowlist seed",
    "no roster to check: set $CANARY_ALLOWLIST_LOGINS (a repository variable) or pass --logins. An empty roster proves nothing"
  )
} else {
  for (const login of roster) {
    const verdict = allowlistStateVerdict(login, true, await readAllowlist(login))
    check(`allowlist seed: ${login} is admitted`, verdict.ok, verdict.detail)
  }
}

/* Half two: an invite actually admits. Opt-in, because it writes. */
if (!admitProbeLogin) {
  skip(
    "an invite admits a new user",
    `not exercised: this run made no write. Pass --admit-probe-login to run the round trip on ${probeLogin}, or run the manual drill in INVITES.md`
  )
} else if (adminToken === "") {
  skip("an invite admits a new user", "IDENTITY_ADMIN_TOKEN is unset, so no invite can be issued")
} else {
  try {
    const before = await readAllowlist(probeLogin)
    if (before.state === "known" && before.allowlisted) {
      console.log(
        `note: ${probeLogin} was already on the allowlist — an earlier run did not reach its cleanup. This run removes it.`
      )
    } else {
      const freshVerdict = allowlistStateVerdict(probeLogin, false, before)
      check("a fresh probe login starts off the allowlist", freshVerdict.ok, freshVerdict.detail)
    }

    const written = await writeAllowlist(probeLogin, "add")
    const writeVerdict = inviteWriteVerdict(written.status, written.body)
    check("the admin allowlist door accepts the invite", writeVerdict.ok, writeVerdict.detail)

    /* The CN-23 assertion: the invite ADMITTED the login, read back from the deployment. */
    const admitted = allowlistStateVerdict(probeLogin, true, await readAllowlist(probeLogin))
    check("the invited login is admitted", admitted.ok, admitted.detail)

    const auditTarget = new URL("/api/identity/admin/audit", identity).toString()
    try {
      const audit = await fetch(auditTarget, { headers: { "x-smithers-admin-token": adminToken } })
      const outcome = auditOutcome(audit.status, await audit.text(), probeLogin, PROBE_REQUESTER)
      if (outcome.state === "unavailable") skip("the invite is attributed in the audit log", outcome.detail)
      else check("the invite is attributed in the audit log", outcome.state === "ok", outcome.detail)
    } catch (error) {
      check(
        "the invite is attributed in the audit log",
        false,
        `the audit door is unreachable at ${auditTarget}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  } finally {
    /*
     * Cleanup runs even when a check above failed. A probe that leaves a
     * synthetic login on the production allowlist is worse than the gap it
     * was closing.
     */
    const removed = await writeAllowlist(probeLogin, "remove")
    const removeVerdict = inviteWriteVerdict(removed.status, removed.body)
    check("the probe login is withdrawn again", removeVerdict.ok, removeVerdict.detail)
    const after = allowlistStateVerdict(probeLogin, false, await readAllowlist(probeLogin))
    check("the probe login is off the allowlist again", after.ok, after.detail)
  }
}

const summary = inviteRunSummary({ passed, failures, skipped, allowInconclusive, ci: isCi(process.env) })
console.log(`\n${summary.line}`)
process.exit(summary.exitCode)
