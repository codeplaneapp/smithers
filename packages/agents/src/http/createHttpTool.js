import { dynamicTool } from "ai";
import { z } from "zod";

/** @typedef {import("ai").Tool} Tool */
/** @typedef {import("./CreateHttpToolOptions.ts").CreateHttpToolOptions} CreateHttpToolOptions */
/** @typedef {import("./HttpToolInput.ts").HttpToolInput} HttpToolInput */
/** @typedef {import("./HttpToolOutput.ts").HttpToolOutput} HttpToolOutput */

const httpToolInputSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).optional().default("GET"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null(), z.undefined()])).optional(),
  body: z.unknown().optional(),
  auth: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("bearer"), token: z.string() }),
      z.object({ type: z.literal("basic"), username: z.string(), password: z.string() }),
      z.object({ type: z.literal("header"), name: z.string(), value: z.string() }),
    ])
    .optional(),
  timeoutMs: z.number().int().positive().optional(),
});

/**
 * Create an AI SDK tool that can call any REST API without an OpenAPI spec.
 *
 * @param {CreateHttpToolOptions} [options]
 * @returns {Tool}
 */
export function createHttpTool(options = {}) {
  return dynamicTool({
    description:
      options.description ??
      "Call any REST API by providing method, url, headers, query params, body, and optional auth.",
    inputSchema: httpToolInputSchema,
    execute: async (input, executionOptions) =>
      executeHttpRequest(/** @type {HttpToolInput} */ (input), options, executionOptions?.abortSignal),
  });
}

/** Redirect statuses the tool resolves manually (fetch spec § 4.4). */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Hop budget for one logical request, matching the fetch spec's limit. */
const MAX_REDIRECTS = 20;

/**
 * @param {HttpToolInput} input
 * @param {CreateHttpToolOptions} options
 * @param {AbortSignal} [abortSignal] AI SDK cancellation signal from ToolExecutionOptions.
 * @returns {Promise<HttpToolOutput>}
 */
async function executeHttpRequest(input, options, abortSignal) {
  abortSignal?.throwIfAborted();
  const url = new URL(input.url);
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== null && value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const controller = input.timeoutMs ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), input.timeoutMs) : null;
  const signal = composeAbortSignals(abortSignal, controller?.signal);
  try {
    // Resolve every Location hop manually (`redirect: "manual"`). Letting
    // fetch follow redirects would forward the caller's secret headers
    // (custom API keys, configured defaults) to whatever host a response
    // points at; here each hop rebuilds its headers so secrets ride only to
    // the origin the caller originally authorized or an allowlisted host.
    const originalOrigin = url.origin;
    let currentUrl = url;
    let method = input.method ?? "GET";
    let sendBody = input.body !== undefined;
    for (let hop = 0; ; hop++) {
      const headers = buildHopHeaders(input, options, currentUrl, originalOrigin, hop);
      const init = /** @type {RequestInit} */ ({ method, headers, redirect: "manual" });
      if (sendBody && method !== "GET" && method !== "HEAD") {
        init.body = serializeBody(input.body, headers);
      }
      if (signal) {
        init.signal = signal;
      }
      const response = await fetch(currentUrl, init);
      const location = response.headers.get("location");
      const nextUrl =
        REDIRECT_STATUSES.has(response.status) && location !== null
          ? resolveLocation(location, currentUrl)
          : null;
      if (!nextUrl) {
        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          body: await parseResponseBody(response),
        };
      }
      if (hop + 1 > MAX_REDIRECTS) {
        throw new Error(`HTTP tool request to ${input.url} exceeded ${MAX_REDIRECTS} redirects`);
      }
      // 303 turns any non-HEAD method into a body-less GET; 301/302 do the
      // same for POST (fetch spec § 4.4 step 13).
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        if (method !== "HEAD") {
          method = "GET";
        }
        sendBody = false;
      }
      await response.body?.cancel();
      currentUrl = nextUrl;
    }
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

/**
 * Compose the AI SDK's cancellation signal with the tool's own timeout signal
 * so whichever fires first aborts the underlying fetch. Returns undefined when
 * neither exists so the request stays signal-free, matching prior behavior.
 *
 * @param {AbortSignal | undefined} abortSignal
 * @param {AbortSignal | undefined} timeoutSignal
 * @returns {AbortSignal | undefined}
 */
function composeAbortSignals(abortSignal, timeoutSignal) {
  if (abortSignal && timeoutSignal) {
    return AbortSignal.any([abortSignal, timeoutSignal]);
  }
  return abortSignal ?? timeoutSignal;
}

/**
 * Build the outgoing headers for one hop of the manually resolved redirect
 * chain. The first hop gets the standard treatment: host-gated default
 * headers, then caller headers, then auth. Redirect hops carry those
 * potentially-secret headers only while they stay on the original request's
 * origin or land on an explicitly allowlisted host; every other cross-origin
 * hop is sent bare, so a redirecting (or compromised) endpoint cannot bounce
 * the request elsewhere and exfiltrate the secrets.
 *
 * @param {HttpToolInput} input
 * @param {CreateHttpToolOptions} options
 * @param {URL} url
 * @param {string} originalOrigin
 * @param {number} hop
 * @returns {Headers}
 */
function buildHopHeaders(input, options, url, originalOrigin, hop) {
  const headers = new Headers();
  if (hop > 0 && !isTrustedRedirectTarget(url, originalOrigin, options)) {
    return headers;
  }
  applyDefaultHeaders(headers, options, url);
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    headers.set(key, value);
  }
  applyAuth(headers, input.auth);
  return headers;
}

/**
 * A redirect hop may carry the request's secret headers only when it stays on
 * the origin the caller originally requested or lands on a host the tool
 * creator allowlisted via `baseUrl`/`allowedHosts`.
 *
 * @param {URL} url
 * @param {string} originalOrigin
 * @param {CreateHttpToolOptions} options
 * @returns {boolean}
 */
function isTrustedRedirectTarget(url, originalOrigin, options) {
  if (url.origin === originalOrigin) return true;
  const allowed = resolveAllowedHosts(options);
  return allowed !== null && allowed.has(url.host.toLowerCase());
}

/**
 * Resolve a Location header against the URL that produced it. Returns null
 * for an unparseable or non-HTTP(S) target, in which case the redirect
 * response itself is returned to the caller instead of being followed.
 *
 * @param {string} location
 * @param {URL} base
 * @returns {URL | null}
 */
function resolveLocation(location, base) {
  try {
    const next = new URL(location, base);
    return next.protocol === "http:" || next.protocol === "https:" ? next : null;
  } catch {
    return null;
  }
}

/**
 * Attach the tool creator's configured default headers, but only to hosts the
 * creator trusts. `defaultHeaders` can carry secrets (API keys, cookies) while
 * the model chooses the request URL, so sending them to an arbitrary host would
 * leak them to an attacker-controlled endpoint. When `baseUrl`/`allowedHosts`
 * pin an allowlist the headers ride only to matching hosts; requests to the
 * configured base URL are never broken. With no allowlist the behavior is
 * unchanged (send everywhere), so configure one when the headers hold secrets.
 *
 * @param {Headers} headers
 * @param {CreateHttpToolOptions} options
 * @param {URL} url
 */
function applyDefaultHeaders(headers, options, url) {
  const defaults = options.defaultHeaders;
  if (!defaults) return;
  const allowed = resolveAllowedHosts(options);
  if (allowed && !allowed.has(url.host.toLowerCase())) return;
  for (const [key, value] of Object.entries(defaults)) {
    headers.set(key, value);
  }
}

/**
 * Build the set of hosts allowed to receive `defaultHeaders`, drawn from
 * `baseUrl`'s host plus any explicit `allowedHosts`. Hosts are matched as
 * WHATWG `url.host` (hostname plus any non-default port), so an entry with no
 * port matches only default-port requests and a mismatched explicit port fails
 * closed. Returns null when neither is configured (no restriction).
 *
 * @param {CreateHttpToolOptions} options
 * @returns {Set<string> | null}
 */
function resolveAllowedHosts(options) {
  const hosts = new Set();
  if (options.baseUrl) {
    try {
      hosts.add(new URL(options.baseUrl).host.toLowerCase());
    } catch {
      // Ignore an unparseable baseUrl; allowedHosts can still pin the allowlist.
    }
  }
  for (const entry of options.allowedHosts ?? []) {
    hosts.add(hostOf(entry));
  }
  return hosts.size ? hosts : null;
}

/**
 * Accept either a bare host (`api.example.com`, `api.example.com:8443`) or a
 * full URL as an allowlist entry.
 *
 * @param {string} entry
 * @returns {string}
 */
function hostOf(entry) {
  const value = entry.trim();
  if (value.includes("://")) {
    try {
      return new URL(value).host.toLowerCase();
    } catch {
      // Fall through and treat the entry as a bare host.
    }
  }
  return value.toLowerCase();
}

/**
 * @param {Headers} headers
 * @param {HttpToolInput["auth"]} auth
 */
function applyAuth(headers, auth) {
  if (!auth) return;
  if (auth.type === "bearer") {
    headers.set("authorization", `Bearer ${auth.token}`);
  } else if (auth.type === "basic") {
    headers.set("authorization", `Basic ${btoa(`${auth.username}:${auth.password}`)}`);
  } else {
    headers.set(auth.name, auth.value);
  }
}

/**
 * @param {unknown} body
 * @param {Headers} headers
 * @returns {BodyInit}
 */
function serializeBody(body, headers) {
  if (typeof body === "string" || body instanceof Blob || body instanceof FormData || body instanceof URLSearchParams) {
    return body;
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return JSON.stringify(body);
}

/**
 * @param {Response} response
 * @returns {Promise<unknown>}
 */
async function parseResponseBody(response) {
  if (response.status === 204 || response.status === 205) {
    return null;
  }
  const text = await response.text();
  if (!text) {
    return null;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return JSON.parse(text);
  }
  return text;
}
