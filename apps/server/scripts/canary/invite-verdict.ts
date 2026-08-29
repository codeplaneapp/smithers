/*
 * CN-23 — "the allowlist seed is present and an invite actually admits a new
 * user" — as pure verdicts over already-fetched values. invite-probe.ts is the
 * process shell around this file: it does the fetching, the printing, and the
 * exit code. Everything that can be wrong about a probe's *judgement* lives
 * here, where a bun test can drive it without a deployment.
 *
 * The identity Worker is not in this repository (apps/UPSTREAMS.md); it lives
 * in ~/flows/ui/workers/identity. Its write door is documented in
 * apps/server/INVITES.md and is exercised by src/seed-allowlist.test.ts.
 *
 * Its read-back door is not documented anywhere in this tree. What the live
 * deployment answers, unauthenticated, on 2026-08-18:
 *
 *   GET /api/identity/allowlist/octocat  -> 401 {"error":"Unauthorized service"}
 *   GET /api/identity/admin/audit        -> 404 {"error":"Not found"}
 *
 * The worker answers 401 for a route it implements but gates, and 404 for one
 * it does not implement. So the per-login read-back exists and gates on a
 * service token, and there is no admin audit read-back. Every rule below
 * therefore treats an unexpected read as unreadable — never as an answer. A
 * 404 in particular is not evidence that a login is off the allowlist; it is
 * evidence that nothing answered.
 */

export interface Verdict {
  readonly ok: boolean
  readonly detail: string
}

/**
 * GitHub's login grammar. The identity Worker validates writes against it, so
 * a roster entry that cannot be a GitHub login is a configuration mistake
 * worth refusing before any network call.
 */
export const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

/**
 * The designated probe identity. It is deliberately a FIXED login, not a
 * timestamped one: a crashed run then leaves at most this single, named,
 * greppable row on the alpha allowlist instead of a new one every run. It is
 * not a real GitHub account, so admitting it grants nobody access — the
 * OAuth callback can never mint a session for a login GitHub will not issue.
 */
export const DEFAULT_PROBE_LOGIN = "canary-invite-probe"

/** The read-back door, as a path template. Overridable because it is unverified. */
export const DEFAULT_READ_PATH = "/api/identity/allowlist/{login}"

/** The audit attribution written with every probe invite. */
export const PROBE_REQUESTER = "canary-invite-probe"

/*
 * Split a comma- or newline-separated roster, dropping blanks and `#`
 * comments. Splitting on spaces too would quietly turn a malformed entry into
 * several well-formed ones, which is how a bad roster passes validation.
 * seed-allowlist.mjs reads its --file the same way.
 */
export const parseLogins = (raw: string | undefined): ReadonlyArray<string> => {
  if (raw === undefined) return []
  return raw
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !entry.startsWith("#"))
}

/** The roster entries that cannot be GitHub logins. */
export const invalidLogins = (logins: ReadonlyArray<string>): ReadonlyArray<string> =>
  logins.filter((login) => !LOGIN_PATTERN.test(login))

export const readPathFor = (template: string, login: string): string =>
  template.includes("{login}")
    ? template.replaceAll("{login}", encodeURIComponent(login))
    : `${template}${encodeURIComponent(login)}`

/**
 * What one read-back answered. `known` is the only state that says anything
 * about the allowlist; everything else is the probe admitting it does not
 * know, which is a failed check rather than a `false`.
 */
export type AllowlistRead =
  | { readonly state: "known"; readonly allowlisted: boolean }
  | { readonly state: "unreadable"; readonly detail: string }

const preview = (body: string): string => body.trim().replace(/\s+/g, " ").slice(0, 160)

export const parseAllowlistRead = (status: number, body: string): AllowlistRead => {
  if (status === 404 || status === 405) {
    return {
      state: "unreadable",
      detail:
        `HTTP ${status} — nothing answered the read-back door at this path, so this is NOT evidence the login is off the allowlist. Point --read-path at the identity worker's per-login allowlist route.`
    }
  }
  if (status === 401 || status === 403) {
    return {
      state: "unreadable",
      detail:
        `HTTP ${status} — the read credential was refused. Set IDENTITY_SERVICE_TOKEN (or IDENTITY_ADMIN_TOKEN) to a token the identity worker accepts.`
    }
  }
  if (status !== 200) {
    return { state: "unreadable", detail: `HTTP ${status} ${preview(body)}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch {
    return { state: "unreadable", detail: `HTTP 200 but the body is not JSON: ${preview(body)}` }
  }
  const allowlisted = (parsed as { allowlisted?: unknown } | null)?.allowlisted
  if (typeof allowlisted !== "boolean") {
    return {
      state: "unreadable",
      detail: `HTTP 200 but the body carries no boolean "allowlisted" field: ${preview(body)}`
    }
  }
  return { state: "known", allowlisted }
}

/** Assert one login's allowlist state. An unreadable answer always fails. */
export const allowlistStateVerdict = (login: string, expected: boolean, read: AllowlistRead): Verdict => {
  if (read.state === "unreadable") return { ok: false, detail: `${login}: ${read.detail}` }
  return {
    ok: read.allowlisted === expected,
    detail: `${login}: allowlisted=${read.allowlisted}, expected ${expected}`
  }
}

/** The identity admin write door's answer to one invite. */
export const inviteWriteVerdict = (status: number, body: string): Verdict => {
  if (status >= 200 && status < 300) return { ok: true, detail: `HTTP ${status} ${preview(body)}` }
  if (body.includes("requester_required") || body.includes("timestamp_required")) {
    return {
      ok: false,
      detail: `HTTP ${status} ${
        preview(body)
      } — the write was refused as unattributed; the probe must send requester and timestamp.`
    }
  }
  return { ok: false, detail: `HTTP ${status} ${preview(body)}` }
}

/**
 * The invite is attributed in the identity worker's audit log — where one is
 * exposed. The canary identity worker answers 404 for
 * /api/identity/admin/audit, so this reports `unavailable` (a skip) rather
 * than a failure: attribution is still enforced on the WRITE side, where the
 * upstream refuses an unattributed call, it simply cannot be read back.
 */
export type AuditOutcome =
  | { readonly state: "ok"; readonly detail: string }
  | { readonly state: "fail"; readonly detail: string }
  | { readonly state: "unavailable"; readonly detail: string }

export const auditOutcome = (status: number, body: string, login: string, requester: string): AuditOutcome => {
  if (status === 404 || status === 405) {
    return {
      state: "unavailable",
      detail:
        `HTTP ${status} — this deployment exposes no admin audit read-back, so the attribution written with the invite cannot be read back. The write door still refuses unattributed calls.`
    }
  }
  if (status !== 200) return { state: "fail", detail: `HTTP ${status} ${preview(body)}` }
  const named = body.includes(login) && body.includes(requester)
  return {
    state: named ? "ok" : "fail",
    detail: named
      ? `the audit log names ${login} and requester ${requester}`
      : `the audit log does not name both ${login} and requester ${requester}: ${preview(body)}`
  }
}

/**
 * The flag that lets a local run without production credentials end green.
 * It is spelled as a flag, not an env var, so a CI step that ever grew one
 * would carry the word "inconclusive" in the workflow file where a reviewer
 * reads it. `inviteRunSummary` refuses it under CI regardless.
 */
export const ALLOW_INCONCLUSIVE_FLAG = "--allow-inconclusive"

/**
 * Is this a CI run? GitHub Actions sets CI=true on every step, as does every
 * other runner this repo could move to. The probe reads it for one purpose:
 * to refuse the local escape hatch there.
 */
export const isCi = (env: { readonly [key: string]: string | undefined }): boolean => {
  const raw = env.CI?.trim().toLowerCase()
  if (raw === undefined || raw === "") return false
  return raw !== "0" && raw !== "false"
}

export interface RunSummary {
  readonly exitCode: number
  readonly line: string
}

/**
 * Turn the tallies into a verdict and an exit code.
 *
 * A run that asserted nothing exits 1, the same way CN-18's `summarizeHealth`
 * treats zero healthy targets. The two constraints pull apart here: a
 * contributor without production secrets must not face a red they cannot act
 * on, and CI must never report green for an assertion nobody made. They are
 * resolved by making the green-on-nothing case explicit and local-only —
 * ALLOW_INCONCLUSIVE_FLAG buys exit 0 on a developer's machine, and is refused
 * under CI, where the whole point of the step is the assertion. So the default
 * everywhere, including a CI step wired up before its secrets exist, is red.
 */
export const inviteRunSummary = (counts: {
  readonly passed: number
  readonly failures: number
  readonly skipped: number
  readonly allowInconclusive: boolean
  readonly ci: boolean
}): RunSummary => {
  const { passed, failures, skipped, allowInconclusive, ci } = counts
  if (failures > 0) {
    return {
      exitCode: 1,
      line: `CN-23 INVITE PROBE FAILED: ${failures} check(s), ${passed} passed, ${skipped} skipped.`
    }
  }
  if (passed === 0) {
    if (allowInconclusive && !ci) {
      return {
        exitCode: 0,
        line: `CN-23 INVITE PROBE INCONCLUSIVE: nothing was verified, ${skipped} skipped. ` +
          `${ALLOW_INCONCLUSIVE_FLAG} accepted that for this local run; under CI it is refused.`
      }
    }
    const refusal = allowInconclusive && ci
      ? ` ${ALLOW_INCONCLUSIVE_FLAG} is refused under CI: a CI step must never report success for an assertion it did not make.`
      : ""
    return {
      exitCode: 1,
      line: `CN-23 ASSERTED NOTHING: 0 checks ran, ${skipped} skipped.${refusal}` +
        " Set IDENTITY_SERVICE_TOKEN and CANARY_ALLOWLIST_LOGINS (add IDENTITY_ADMIN_TOKEN and --admit-probe-login for the write half)" +
        `, or pass ${ALLOW_INCONCLUSIVE_FLAG} to accept a local run that verifies nothing.`
    }
  }
  return { exitCode: 0, line: `CN-23 INVITE PROBE PASS: ${passed} check(s), 0 failures, ${skipped} skipped.` }
}
