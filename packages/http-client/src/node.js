import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { HttpClientPolicyError } from "./errors.js";
import { isNonGlobalIpLiteral } from "./ip.js";
import { assertHttpUrl } from "./url.js";

/**
 * @typedef {(hostname: string) => readonly string[] | Promise<readonly string[]>} HostnameResolver
 */

/** @param {AbortSignal} signal */
function abortReason(signal) {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

/** @param {string} hostname @returns {Promise<readonly string[]>} */
async function defaultResolver(hostname) {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

/**
 * @param {HostnameResolver} resolver
 * @param {string} hostname
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<readonly string[]>}
 */
async function resolveWithAbort(resolver, hostname, signal) {
  if (signal?.aborted) throw abortReason(signal);
  if (!signal) return resolver(hostname);
  return new Promise((resolve, reject) => {
    let settled = false;
    /** @param {() => void} fn */
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(abortReason(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => resolver(hostname))
      .then(
        (addresses) => finish(() => resolve(addresses)),
        (error) => finish(() => reject(error)),
      );
  });
}

/**
 * Fail closed unless a hostname is localhost-free and every resolved A/AAAA
 * address is ordinary global unicast. IP literals are classified directly.
 *
 * This closes static DNS aliases to private ranges. Standard Fetch resolves
 * the hostname again, so callers must still enforce a private-range/metadata
 * deny at the network boundary to eliminate DNS-rebinding TOCTOU.
 *
 * @param {string} hostname
 * @param {{ resolveHostname?: HostnameResolver; signal?: AbortSignal }} [options]
 * @returns {Promise<void>}
 */
export async function assertPublicHostname(hostname, options = {}) {
  const host = hostname
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (!host) {
    throw new HttpClientPolicyError("INVALID_URL", "Outbound destination has no hostname.", {
      reason: "missing-hostname",
    });
  }
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "local" ||
    host.endsWith(".local") ||
    isNonGlobalIpLiteral(host)
  ) {
    throw new HttpClientPolicyError(
      "INVALID_URL",
      "Outbound destination is localhost-style or outside ordinary public-unicast space.",
      { reason: "non-public-destination" },
    );
  }
  // A recognized global literal needs no DNS lookup.
  if (isIP(host) !== 0) return;

  let addresses;
  try {
    addresses = await resolveWithAbort(
      options.resolveHostname ?? defaultResolver,
      host,
      options.signal,
    );
  } catch {
    if (options.signal?.aborted) throw abortReason(options.signal);
    throw new HttpClientPolicyError(
      "INVALID_URL",
      "Outbound destination hostname could not be resolved safely.",
      { reason: "dns-resolution-failed" },
    );
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new HttpClientPolicyError(
      "INVALID_URL",
      "Outbound destination hostname did not resolve to a public address.",
      { reason: "dns-no-addresses" },
    );
  }
  for (const address of addresses) {
    if (typeof address !== "string" || isIP(address) === 0 || isNonGlobalIpLiteral(address)) {
      throw new HttpClientPolicyError(
        "INVALID_URL",
        "Outbound destination hostname resolves outside ordinary public-unicast space.",
        { reason: "dns-non-public-address" },
      );
    }
  }
}

/**
 * Build a redirect-only destination guard for a configured provider endpoint.
 * The initial origin and explicitly allowed origins are operator trust and may
 * intentionally be private. Any other redirect must resolve entirely to
 * ordinary public-unicast space before Fetch may contact it.
 *
 * Fetch performs its own DNS lookup after this check, so deployments must still
 * deny private/metadata ranges at the network boundary to close rebinding TOCTOU.
 *
 * @param {string | URL} initialUrl
 * @param {{
 *   allowedOrigins?: readonly (string | URL)[];
 *   resolveHostname?: HostnameResolver;
 *   signal?: AbortSignal;
 * }} [options]
 * @returns {(url: URL, context: { readonly initial: boolean; readonly from?: URL }) => Promise<void>}
 */
export function createPublicRedirectValidator(initialUrl, options = {}) {
  const trustedOrigins = new Set([assertHttpUrl(initialUrl).origin]);
  for (const origin of options.allowedOrigins ?? []) {
    trustedOrigins.add(assertHttpUrl(origin).origin);
  }
  return async (url, context) => {
    if (context.initial || trustedOrigins.has(url.origin)) return;
    await assertPublicHostname(url.hostname, {
      resolveHostname: options.resolveHostname,
      signal: options.signal,
    });
  };
}
