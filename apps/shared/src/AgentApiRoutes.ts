/**
 * Route contract shared by the browser agent client and the server boundary, so the two
 * can never drift. Kept free of Node imports because the browser bundle imports it.
 */
export const TURN_PATH = "/api/agent/turn"
export const CANCEL_PATH = "/api/agent/turn/cancel"

/*
 * The product Worker's backend seams (Wave 2a): auth/identity proxy routes, the
 * billing proxy routes, and the approval decision round trip. The identity and
 * billing prefixes are proxied wholesale; the approval path is implemented on
 * the Worker itself (it forwards to the gateway's submitApproval RPC).
 */
export const AUTH_ROUTE_PREFIX = "/api/auth/"
export const IDENTITY_ROUTE_PREFIX = "/api/identity/"
export const BILLING_ROUTE_PREFIX = "/api/billing/"
export const AUTH_SCOPES_PATH = "/api/auth/scopes"
export const AUTH_SESSION_PATH = "/api/auth/session"
export const AUTH_SIGN_IN_PATH = "/api/auth/github/start"
/* The native sign-in handoff (device-flow style): OAuth in the system browser. */
export const AUTH_NATIVE_START_PATH = "/api/auth/native/start"
export const AUTH_NATIVE_CLAIM_PATH = "/api/auth/native/claim"
export const AUTH_CALLBACK_PATH = "/api/auth/github/callback"
export const AUTH_LOGOUT_PATH = "/api/auth/logout"
export const IDENTITY_REQUEST_ACCESS_PATH = "/api/identity/request-access"
/*
 * The watched-repos contract, served by the identity worker (it owns the
 * session and the GitHub token vault): the chooser's candidates, and the
 * user's selection (null = never chosen, a real distinct state — NOT "all
 * repos"; [] = deliberately chose none).
 */
export const REPO_CANDIDATES_PATH = "/api/identity/repos"
export const WATCHED_REPOS_PATH = "/api/identity/watched"
export const BILLING_BALANCE_PATH = "/api/billing/balance"
export const BILLING_USAGE_PATH = "/api/billing/usage"
export const APPROVAL_DECISION_PATH = "/api/approvals/decision"

/*
 * The browser tool's server-side fetch (Wave 10, §2d): implemented ON the
 * product Worker (SSRF-guarded, no credentials), not proxied to a sibling.
 */
export const TOOLS_BROWSER_FETCH_PATH = "/api/tools/browser-fetch"
/*
 * Wave 11 — the per-user workflow seam (implemented ON the product Worker):
 * provision-or-resume the caller's workspace gateway, relay whitelisted RPCs,
 * read per-run events with afterSeq resume, and proxy the relay SSE change
 * stream. Gateway tokens never reach the browser.
 */
export const WORKFLOW_PROVISION_PATH = "/api/workflow/provision"
export const WORKFLOW_RPC_PATH = "/api/workflow/rpc"
export const WORKFLOW_EVENTS_PATH = "/api/workflow/events"
export const WORKFLOW_STREAM_PATH = "/api/workflow/stream"
/*
 * The chain backend's model relay (DESIGN.md §14, decision D1): the browser
 * runs the real @smthrs/model provider wire against this path; the Worker
 * session-gates the call, injects the provider key, and streams the provider's
 * SSE back verbatim. The full ModelEvent vocabulary therefore reaches the
 * browser without the Worker ever speaking effect — the relay carries the
 * provider protocol, and ModelEvent decoding stays where effect lives.
 */
export const MODEL_STREAM_PATH = "/api/model/stream"

export const ADMIN_ROUTE_PREFIX = "/api/admin/"
export const ADMIN_ALLOWLIST_PATH = "/api/admin/allowlist"
export const ADMIN_GRANT_PATH = "/api/admin/grant"
export const ADMIN_REQUESTS_PATH = "/api/admin/requests"
export const ADMIN_HEALTH_PATH = "/api/admin/health"
/** The bounded client-error log: what actually broke in an alpha user's browser. */
export const ADMIN_ERRORS_PATH = "/api/admin/errors"

/*
 * The local app's own chat boundary (apps/ui/docs/LOCAL-APP.md): the Bun
 * main process serves these on http://127.0.0.1:<port> and the SPA streams
 * the same NDJSON AgentTurnFrames the native bridge used to carry.
 */
export const CHAT_TURN_PATH = "/api/chat/turn"
export const CHAT_CANCEL_PATH = "/api/chat/cancel"
export const HEALTH_PATH = "/api/health"
export const TARGET_GRAPH_PATH = "/api/targets/graph"
export const TARGET_RUNS_PATH = "/api/targets/runs"
export const TARGET_RUN_REPLAY_PATH = "/api/targets/runs/replay"
export const TARGET_AFFECTED_PATH = "/api/targets/affected"
export const TARGET_CI_PATH = "/api/targets/ci"
export const TARGET_OPEN_SOURCE_PATH = "/api/targets/open-source"
