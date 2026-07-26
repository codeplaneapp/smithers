/**
 * Actionable diagnostics for task output-validation failures
 * (childRun/compute/static). A parent-declared schema mismatch — e.g. a
 * <Subflow> childRun whose parent output schema does not match the child's
 * final output — previously surfaced only a generic "Task output failed
 * validation for <table>" message. These helpers turn the persisted Zod
 * issues into a readable summary (issue path plus expected/received data)
 * and describe the received value's top-level keys (or give an explicit
 * non-object/array description), so the mismatch is debuggable from the
 * durable error alone.
 */

// Cap the number of issue lines embedded in the error message; the full
// issue list still lands in the durable error details as `issues`.
const MAX_SUMMARY_ISSUES = 5;
// Cap the number of top-level keys embedded in the received-value
// description so a huge payload cannot bloat the message.
const MAX_SUMMARY_KEYS = 20;
// Cap the primitive-value preview so a long string payload stays readable.
const MAX_PRIMITIVE_PREVIEW_CHARS = 80;

/** @typedef {{ path?: unknown; message?: unknown; expected?: unknown; received?: unknown; code?: unknown }} ZodIssueLike */

/**
 * @param {unknown} error
 * @returns {ZodIssueLike[]}
 */
function extractIssues(error) {
  if (
    error &&
    typeof error === "object" &&
    "issues" in error &&
    Array.isArray(/** @type {{ issues?: unknown }} */ (error).issues)
  ) {
    return /** @type {ZodIssueLike[]} */ (/** @type {{ issues: unknown[] }} */ (error).issues);
  }
  return [];
}

/**
 * Format one Zod issue as `path: message`, appending the structured
 * expected/received fields when the message does not already carry them
 * (Zod v4 invalid_type messages embed "expected X, received Y" directly).
 *
 * @param {ZodIssueLike} issue
 * @returns {string}
 */
function formatIssue(issue) {
  const path = Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
  let detail = typeof issue.message === "string" && issue.message.length > 0 ? issue.message : "";
  const structuredParts = [];
  if (issue.expected !== undefined && !detail.includes("expected")) {
    structuredParts.push(`expected ${String(issue.expected)}`);
  }
  if (issue.received !== undefined && !detail.includes("received")) {
    structuredParts.push(`received ${String(issue.received)}`);
  }
  if (structuredParts.length > 0) {
    const structured = structuredParts.join(", ");
    detail = detail ? `${detail} (${structured})` : structured;
  }
  if (!detail) {
    detail = typeof issue.code === "string" ? issue.code : "invalid";
  }
  return `${path}: ${detail}`;
}

/**
 * Describe the top-level shape of the payload that failed validation: its
 * keys for a plain object, or an explicit array/non-object description.
 *
 * @param {unknown} received
 * @returns {{ receivedKeys: string[] | null; receivedDescription: string }}
 */
export function describeReceivedOutput(received) {
  if (received === null) {
    return { receivedKeys: null, receivedDescription: "received value is null" };
  }
  if (received === undefined) {
    return { receivedKeys: null, receivedDescription: "received value is undefined" };
  }
  if (Array.isArray(received)) {
    return {
      receivedKeys: null,
      receivedDescription: `received value is an array of ${received.length} element(s), not an object`,
    };
  }
  if (typeof received === "object") {
    const keys = Object.keys(received);
    if (keys.length === 0) {
      return { receivedKeys: keys, receivedDescription: "received value is an object with no top-level keys" };
    }
    const shown = keys.slice(0, MAX_SUMMARY_KEYS).join(", ");
    const overflow = keys.length > MAX_SUMMARY_KEYS ? `, +${keys.length - MAX_SUMMARY_KEYS} more` : "";
    return {
      receivedKeys: keys,
      receivedDescription: `received value top-level keys: [${shown}${overflow}]`,
    };
  }
  /** @type {string | undefined} */
  let preview;
  try {
    preview = JSON.stringify(received);
  } catch {
    preview = undefined;
  }
  if (typeof preview === "string" && preview.length > MAX_PRIMITIVE_PREVIEW_CHARS) {
    preview = `${preview.slice(0, MAX_PRIMITIVE_PREVIEW_CHARS)}…`;
  }
  return {
    receivedKeys: null,
    receivedDescription: `received value is a ${typeof received}${preview !== undefined ? ` (${preview})` : ""}, not an object`,
  };
}

/**
 * Build the actionable diagnostics for an output-validation failure:
 * a one-line summary (for the surfaced error message) plus the received
 * value's top-level keys/description (for the durable error details).
 *
 * @param {unknown} error The Zod (or drizzle-zod insert) validation error.
 * @param {unknown} received The payload that failed validation.
 * @returns {{ summary: string; receivedKeys: string[] | null; receivedDescription: string }}
 */
export function buildOutputValidationDiagnostics(error, received) {
  const { receivedKeys, receivedDescription } = describeReceivedOutput(received);
  const issues = extractIssues(error);
  let issuesPart;
  if (issues.length > 0) {
    const lines = issues.slice(0, MAX_SUMMARY_ISSUES).map(formatIssue);
    const overflow = issues.length > MAX_SUMMARY_ISSUES ? `; +${issues.length - MAX_SUMMARY_ISSUES} more issue(s)` : "";
    issuesPart = `${lines.join("; ")}${overflow}`;
  } else {
    issuesPart = error instanceof Error && error.message ? error.message.slice(0, 200) : "schema validation failed";
  }
  return {
    summary: `${issuesPart}; ${receivedDescription}`,
    receivedKeys,
    receivedDescription,
  };
}
