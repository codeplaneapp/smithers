import { HttpClientPolicyError } from "./errors.js";

/**
 * Parse and enforce the only URL protocols Fetch callers in Smithers may use.
 * The thrown error never repeats the raw input, which may contain credentials.
 *
 * @param {string | URL} input
 * @returns {URL}
 */
export function assertHttpUrl(input) {
  let url;
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(input);
  } catch {
    throw new HttpClientPolicyError(
      "INVALID_URL",
      "Outbound request URL is invalid.",
      {},
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpClientPolicyError(
      "UNSUPPORTED_PROTOCOL",
      `Outbound request uses an unsupported protocol. Only HTTP(S) is allowed (received ${url.protocol}).`,
      { protocol: url.protocol },
    );
  }
  if (url.username || url.password) {
    throw new HttpClientPolicyError(
      "INVALID_URL",
      "Outbound request URLs must not include userinfo.",
      { reason: "userinfo" },
    );
  }
  return url;
}

/**
 * A log/error-safe URL label. Paths can carry credentials (for example bot
 * tokens and signed webhook IDs), so generic diagnostics expose only origin.
 *
 * @param {URL} url
 * @returns {string}
 */
export function safeUrlLabel(url) {
  return url.origin;
}
