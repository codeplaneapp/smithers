import { createHash } from "node:crypto";

/**
 * Derives an opaque, stable-per-token principal id. It must stay stable per
 * token (it also doubles as the rate-limiter key), but must never contain
 * token substrings — it is embedded verbatim in scope-decision logs and every
 * emitted proxy event, which feed the observability/OTLP path.
 *
 * @param {string} authorization
 * @returns {string}
 */
function derivePrincipalId(authorization) {
  const salt = process.env.SMITHERS_ELECTRIC_PRINCIPAL_SALT ?? "";
  const hash = createHash("sha256").update(salt + authorization).digest("hex");
  return `tok_${hash.slice(0, 16)}`;
}

/**
 * @param {string} gatewayUrl
 * @param {string} authorization
 * @param {typeof fetch} [fetchClient]
 * @returns {Promise<import("./SmithersElectricProxyOptions.ts").SmithersElectricAuthContext | null>}
 */
export async function deriveGrantsFromGateway(gatewayUrl, authorization, fetchClient = fetch) {
  // listRuns returns exactly the runs the token is authorized to read, so its
  // result is the authoritative grant set. A 401/403 means no access.
  const response = await fetchClient(`${gatewayUrl.replace(/\/+$/, "")}/v1/rpc/listRuns`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body: JSON.stringify({}),
  }).catch(() => null);
  if (!response || !response.ok) return null;
  const body = /** @type {{ payload?: unknown } | null} */ (await response.json().catch(() => null));
  const payload = body?.payload;
  const rows = Array.isArray(payload) ? payload : [];
  const grantedRunIds = rows
    .map((row) => (row && typeof row === "object" ? (/** @type {{ runId?: unknown }} */ (row)).runId : undefined))
    .filter((id) => typeof id === "string");
  return {
    principalId: derivePrincipalId(authorization),
    scopes: ["run:read"],
    grantedRunIds,
  };
}
