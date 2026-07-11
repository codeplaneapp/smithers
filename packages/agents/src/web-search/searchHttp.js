import { fetchWithPolicy, readResponseText } from "@smithers-orchestrator/http-client";
import { createPublicRedirectValidator } from "@smithers-orchestrator/http-client/node";
import { responseByteLimit } from "../responseByteLimit.js";

const DEFAULT_SEARCH_RESPONSE_BYTES = 1024 * 1024;
const SEARCH_SECRET_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "x-subscription-token",
]);

/** @param {string} text @param {HeadersInit | undefined} headers */
function redactSearchSecrets(text, headers) {
  const secrets = [];
  const values = new Headers(headers);
  for (const name of SEARCH_SECRET_HEADERS) {
    const value = values.get(name);
    if (!value) continue;
    secrets.push(value);
    const credential = value.match(/^\S+\s+(.+)$/)?.[1];
    if (credential) secrets.push(credential);
  }
  let safe = text;
  for (const secret of secrets.sort((left, right) => right.length - left.length)) {
    safe = safe.split(secret).join("[REDACTED]");
  }
  return safe;
}

/**
 * Credential-safe, bounded JSON transport shared by every search provider.
 * Provider credentials stay on the configured origin unless an additional
 * redirect origin is explicitly authorized.
 *
 * @param {string | URL} url
 * @param {RequestInit} init
 * @param {{ provider: string; fetch?: typeof fetch; allowedOrigins?: string[]; maxRedirects?: number; maxResponseBytes?: number; resolveHostname?: (hostname: string) => readonly string[] | Promise<readonly string[]> }} options
 */
export async function fetchSearchJson(url, init, options) {
  const maxResponseBytes = responseByteLimit(
    options.maxResponseBytes,
    DEFAULT_SEARCH_RESPONSE_BYTES,
  );
  const response = await fetchWithPolicy(url, init, {
    fetch: options.fetch,
    allowedOrigins: options.allowedOrigins,
    maxRedirects: options.maxRedirects,
    validateUrl: createPublicRedirectValidator(url, {
      allowedOrigins: options.allowedOrigins,
      resolveHostname: options.resolveHostname,
      signal: init.signal ?? undefined,
    }),
  });
  const text = await readResponseText(response, {
    maxBytes: maxResponseBytes,
    signal: init.signal ?? undefined,
  });
  if (init.signal?.aborted) {
    throw init.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
  }
  if (!response.ok) {
    throw new Error(
      `${options.provider} search failed (${response.status}): ${redactSearchSecrets(text, init.headers)}`,
    );
  }
  return text ? JSON.parse(text) : {};
}
