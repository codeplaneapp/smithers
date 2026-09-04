/**
 * Route contract shared by the browser agent client and the server boundary, so the two
 * can never drift. Kept free of Node imports because the browser bundle imports it.
 */
export const TURN_PATH = "/api/agent/turn"
export const CANCEL_PATH = "/api/agent/turn/cancel"

/*
 * The product Worker's backend seams: auth/identity proxy routes and the
 * billing proxy routes, both proxied wholesale.
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
export const BILLING_BALANCE_PATH = "/api/billing/balance"
export const BILLING_USAGE_PATH = "/api/billing/usage"
/*
 * Approvals are no longer a route of their own. A decision is the gateway's
 * `Approval.Submit` procedure, relayed through {@link WORKFLOW_RPC_PATH}: one
 * call that records the decision AND resumes the run it unblocked, so a lost
 * second call can never leave a run approved and stopped.
 */

/*
 * The browser tool's server-side fetch (Wave 10, §2d): implemented ON the
 * product Worker (SSRF-guarded, no credentials), not proxied to a sibling.
 */
export const TOOLS_BROWSER_FETCH_PATH = "/api/tools/browser-fetch"
/*
 * The per-user workflow seam (implemented ON the product Worker):
 * provision-or-resume the caller's workspace gateway, then relay one
 * allowlisted gateway procedure per call. Gateway tokens never reach the
 * browser: the Worker holds the credential and writes the gateway's RPC frame.
 *
 * The body is `{ repo, procedure, payload }` and the answer is the gateway's
 * own outcome, unwrapped: `{ ok: true, payload }` or `{ ok: false, error }`.
 *
 * The 0.x per-run events route and SSE change stream are gone. A run is
 * followed through the `run-summary`, `transcript`, and `approvals`
 * projections, which carry their own cursor; a live stream belongs on the
 * gateway's own WebSocket mounts, which a path-prefixed relay proxies.
 */
export const WORKFLOW_PROVISION_PATH = "/api/workflow/provision"
export const WORKFLOW_RPC_PATH = "/api/workflow/rpc"
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
