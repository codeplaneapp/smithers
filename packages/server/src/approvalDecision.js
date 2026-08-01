// @smithers-type-exports-begin
/**
 * @typedef {{
 *   mode: "gate" | "select" | "rank" | "decision";
 *   title: string | null;
 *   summary: string | null;
 *   options: Array<{ key: string; label: string; summary?: string }>;
 *   allowedScopes: string[];
 *   allowedUsers: string[];
 *   restrictionError: string | null;
 *   autoApprove: Record<string, unknown> | null;
 * }} ApprovalRequestRecord
 */
// @smithers-type-exports-end

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function asString(value) {
  return typeof value === "string" ? value : undefined;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function parseStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry) => typeof entry === "string");
}

/**
 * @param {unknown} value
 * @param {"allowedScopes" | "allowedUsers"} field
 * @returns {{ values: string[]; error: string | null }}
 */
function parseApprovalRestriction(value, field) {
  if (value === undefined) {
    return { values: [], error: null };
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    return {
      values: [],
      error: `${field} must be an array of non-empty strings`,
    };
  }
  return { values: value, error: null };
}

/**
 * @param {unknown} value
 * @param {string | null} fallbackTitle
 * @returns {ApprovalRequestRecord}
 */
function parseApprovalRequest(value, fallbackTitle) {
  const record = asObject(value);
  const allowedScopes = parseApprovalRestriction(record?.allowedScopes, "allowedScopes");
  const allowedUsers = parseApprovalRestriction(record?.allowedUsers, "allowedUsers");
  const options = Array.isArray(record?.options)
    ? record.options
        .filter((entry) => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)))
        .map((entry) => ({
          key: asString(entry.key) ?? "",
          label: asString(entry.label) ?? "",
          ...(asString(entry.summary) ? { summary: asString(entry.summary) } : {}),
        }))
        .filter((entry) => entry.key.length > 0 && entry.label.length > 0)
    : [];
  const autoApprove =
    record?.autoApprove && typeof record.autoApprove === "object" && !Array.isArray(record.autoApprove)
      ? record.autoApprove
      : null;
  return {
    mode: record?.mode === "select" || record?.mode === "rank" || record?.mode === "decision" ? record.mode : "gate",
    title: asString(record?.title) ?? fallbackTitle,
    summary: asString(record?.summary) ?? null,
    options,
    allowedScopes: allowedScopes.values,
    allowedUsers: allowedUsers.values,
    restrictionError: allowedScopes.error ?? allowedUsers.error,
    autoApprove,
  };
}

/**
 * @param {ApprovalRequestRecord} request
 * @param {unknown} decision
 */
function validateApprovalDecision(request, decision) {
  if (request.mode === "select") {
    // Fail closed: a select request whose options were all malformed (dropped
    // by parseApprovalRequest) must not accept an arbitrary selection.
    if (request.options.length === 0) {
      return { ok: false, code: "INVALID_REQUEST", message: "select approval request has no valid options" };
    }
    const payload = asObject(decision);
    const selected = asString(payload?.selected);
    if (!selected) {
      return { ok: false, code: "INVALID_REQUEST", message: "select approvals require decision.selected" };
    }
    if (!request.options.some((option) => option.key === selected)) {
      return { ok: false, code: "INVALID_REQUEST", message: `Unknown selection: ${selected}` };
    }
  }
  if (request.mode === "rank") {
    if (request.options.length === 0) {
      return { ok: false, code: "INVALID_REQUEST", message: "rank approval request has no valid options" };
    }
    const payload = asObject(decision);
    const rankedRaw = payload?.ranked;
    // The original decision object is what gets persisted, so a mixed-type
    // array must be rejected outright — sanitizing only the validation copy
    // would persist a decisionJson that violates the string[] contract.
    if (!Array.isArray(rankedRaw) || rankedRaw.some((entry) => typeof entry !== "string")) {
      return { ok: false, code: "INVALID_REQUEST", message: "decision.ranked must be an array of strings" };
    }
    const ranked = parseStringArray(rankedRaw);
    if (ranked.length === 0) {
      return { ok: false, code: "INVALID_REQUEST", message: "rank approvals require decision.ranked" };
    }
    const allowed = new Set(request.options.map((option) => option.key));
    if (ranked.some((value) => !allowed.has(value))) {
      return { ok: false, code: "INVALID_REQUEST", message: "rank approval included unknown options" };
    }
  }
  return { ok: true };
}

/**
 * @param {unknown} value
 * @param {unknown} explicitNote
 */
function normalizeDecision(value, explicitNote) {
  const stableDecision = asObject(value);
  return {
    decision: stableDecision && "value" in stableDecision ? stableDecision.value : value,
    note: asString(explicitNote) ?? asString(stableDecision?.note),
  };
}

/**
 * Shared approval request parsing and decision validation for all transports.
 */
export const approvalDecision = {
  parseApprovalRequest,
  validateApprovalDecision,
  normalizeDecision,
  unwrapDecision(value) {
    return normalizeDecision(value, undefined).decision;
  },
};
