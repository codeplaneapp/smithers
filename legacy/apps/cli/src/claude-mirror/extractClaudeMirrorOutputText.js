/**
 * Reduce an aggregated node detail (see node-detail.js) to the single text a
 * /workflows mirror row should display: the node's useful output, or its
 * failure, in that order of preference.
 *
 * @param {any} detail
 * @returns {string}
 */
export function extractClaudeMirrorOutputText(detail) {
  // node-detail wraps stored output as { validated, raw, source, cacheKey };
  // the useful payload is validated, then raw. `source: "none"` means the
  // node stored nothing: fall through to the attempt response text.
  let output = detail?.output;
  if (output && typeof output === "object" && "source" in output && ("validated" in output || "raw" in output)) {
    output = output.validated ?? output.raw ?? null;
  }
  if (typeof output === "string" && output.length > 0) {
    return output;
  }
  if (output !== undefined && output !== null) {
    try {
      return JSON.stringify(output);
    } catch {
      // fall through to attempts
    }
  }
  const attempts = Array.isArray(detail?.attempts) ? detail.attempts : [];
  for (let index = attempts.length - 1; index >= 0; index--) {
    const attempt = attempts[index];
    if (typeof attempt?.responseText === "string" && attempt.responseText.length > 0) {
      return attempt.responseText;
    }
    if (attempt?.error) {
      try {
        return typeof attempt.error === "string" ? attempt.error : JSON.stringify(attempt.error);
      } catch {
        // keep scanning
      }
    }
  }
  return "";
}
