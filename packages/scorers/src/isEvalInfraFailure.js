// A red eval case is only evidence against the workflow when the case
// actually ran. A child run that died because the harness could not reach a
// service, resolve a host, complete a TLS handshake, spawn a binary, or
// survive the process is an environment fault: grading it as a plain failure
// sends repair loops off to "fix" product code that was never exercised.
// These signatures are matched against the case's formatted error text.
const EVAL_INFRA_ERROR_PATTERNS = [
  // Smithers' own sandbox/tooling denials: the run was blocked, not wrong.
  /TOOL_NETWORK_DISABLED/,
  /TOOL_GIT_REMOTE_DISABLED/,
  // Sockets, DNS, and TLS: the service on the other end never answered.
  /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EADDRINUSE|EHOSTUNREACH|ENETUNREACH/,
  /TLS handshake|SSL routines|certificate (?:verify|has expired|is not trusted|unknown)|self[- ]signed certificate/i,
  // The process, not the program: missing binaries, signals, memory.
  /spawn .* ENOENT/,
  /SIGKILL|SIGSEGV|SIGABRT|SIGBUS/,
  /out of memory|heap limit|Bus error/i,
  // Provider capacity must carry provider provenance: a Smithers agent quota
  // code, a provider response code/type, or an HTTP status. Free-form
  // workflow messages such as "rate limit exceeded for tenant" are product
  // failures and deliberately do not match.
  /\bAGENT_QUOTA_EXCEEDED\b/,
  /(?:^429\b|(?:HTTP(?:\/[0-9.]+)?\s+|status(?:Code)?[:= ]+|error status[:= ]*)429\b)/i,
  /\boverloaded_error\b/,
];

/**
 * True when an eval case's error text indicates the harness or environment
 * failed before the workflow's own behavior could be observed. Callers use
 * this to grade the case `inconclusive` instead of `failed` so eval-driven
 * loops repair the harness (or stop) rather than iterate on the product.
 *
 * The pattern list is deliberately conservative: an unrecognized error stays
 * a genuine failure. Fail-closed is correct here because an inconclusive
 * verdict suppresses the strongest signal an eval suite produces.
 * @param {string} errorText
 * @returns {boolean}
 */
export function isEvalInfraFailure(errorText) {
  if (typeof errorText !== "string" || errorText === "") {
    return false;
  }
  return EVAL_INFRA_ERROR_PATTERNS.some((pattern) => pattern.test(errorText));
}
