import { dynamicTool } from "ai";
import { z } from "zod";
import {
  assertHttpUrl,
  composeAbortSignals,
  fetchWithPolicy,
  HttpClientPolicyError,
  readResponseText,
} from "@smithers-orchestrator/http-client";
import { assertPublicHostname } from "@smithers-orchestrator/http-client/node";
import { responseByteLimit } from "../responseByteLimit.js";

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

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * Create an AI SDK tool that can call any REST API without an OpenAPI spec.
 *
 * @param {CreateHttpToolOptions} [options]
 * @returns {Tool}
 */
export function createHttpTool(options = {}) {
  if (options.baseUrl) assertHttpUrl(options.baseUrl);
  resolveAllowedHosts(options);
  if (
    Object.keys(options.defaultHeaders ?? {}).length > 0 &&
    !options.baseUrl &&
    (options.allowedHosts?.length ?? 0) === 0
  ) {
    throw new HttpClientPolicyError(
      "INVALID_OPTION",
      "defaultHeaders require baseUrl or allowedHosts so model-selected URLs cannot receive operator credentials.",
      { option: "defaultHeaders" },
    );
  }
  return dynamicTool({
    description:
      options.description ??
      "Call any REST API by providing method, url, headers, query params, body, and optional auth.",
    inputSchema: httpToolInputSchema,
    execute: async (input, execution) =>
      executeHttpRequest(
        /** @type {HttpToolInput} */ (input),
        options,
        execution?.abortSignal,
      ),
  });
}

/**
 * @param {HttpToolInput} input
 * @param {CreateHttpToolOptions} options
 * @param {AbortSignal | undefined} callerSignal
 * @returns {Promise<HttpToolOutput>}
 */
async function executeHttpRequest(input, options, callerSignal) {
  const maxResponseBytes = responseByteLimit(
    options.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
  );
  const url = assertHttpUrl(input.url);
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== null && value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = new Headers();
  applyDefaultHeaders(headers, options, url);
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    headers.set(key, value);
  }
  applyAuth(headers, input.auth);

  const init = /** @type {RequestInit} */ ({
    method: input.method ?? "GET",
    headers,
  });
  if (input.body !== undefined && init.method !== "GET" && init.method !== "HEAD") {
    init.body = serializeBody(input.body, headers);
  }

  const timeoutController = input.timeoutMs ? new AbortController() : null;
  const timeout = timeoutController
    ? setTimeout(
        () => timeoutController.abort(new DOMException("HTTP tool request timed out", "TimeoutError")),
        input.timeoutMs,
      )
    : null;
  const composed = composeAbortSignals(callerSignal, timeoutController?.signal);
  init.signal = composed.signal;
  try {
    const response = await fetchWithPolicy(url, init, {
      allowedOrigins: resolveAllowedOrigins(options),
      maxRedirects: options.maxRedirects,
      sensitiveHeaders: [
        ...Object.keys(options.defaultHeaders ?? {}),
        ...Object.keys(input.headers ?? {}),
        ...(input.auth?.type === "header" ? [input.auth.name] : []),
      ],
      validateUrl: (candidate) => assertSafeHttpDestination(candidate, options, composed.signal),
    });
    const secrets = requestSecretValues(options, input);
    const responseHeaders = redactPayload(
      Object.fromEntries(response.headers.entries()),
      secrets,
    );
    const responseBody = await parseResponseBody(
      response,
      maxResponseBytes,
      composed.signal,
    );
    return {
      ok: response.ok,
      status: response.status,
      statusText: redactString(response.statusText, secrets),
      headers: responseHeaders,
      body: redactPayload(responseBody, secrets),
    };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    composed.cleanup();
  }
}

/** @param {Set<string>} secrets @param {unknown} value */
function addSecret(secrets, value) {
  if (typeof value === "string" && value.length > 0) secrets.add(value);
}

/**
 * Values attached by configuration or explicit request auth must not re-enter
 * model-visible output if an allowed endpoint reflects request material.
 * @param {CreateHttpToolOptions} options
 * @param {HttpToolInput} input
 */
function requestSecretValues(options, input) {
  const secrets = new Set();
  for (const value of Object.values(options.defaultHeaders ?? {})) addSecret(secrets, value);
  for (const value of Object.values(input.headers ?? {})) addSecret(secrets, value);
  const auth = input.auth;
  if (auth?.type === "bearer") {
    addSecret(secrets, auth.token);
    addSecret(secrets, `Bearer ${auth.token}`);
  } else if (auth?.type === "basic") {
    const credential = `${auth.username}:${auth.password}`;
    const encoded = btoa(credential);
    addSecret(secrets, auth.password);
    addSecret(secrets, credential);
    addSecret(secrets, encoded);
    addSecret(secrets, `Basic ${encoded}`);
  } else if (auth?.type === "header") {
    addSecret(secrets, auth.value);
  }
  return [...secrets].sort((left, right) => right.length - left.length);
}

/** @param {string} value @param {readonly string[]} secrets */
function redactString(value, secrets) {
  let redacted = value;
  for (const secret of secrets) {
    // One-character credentials are too ambiguous for substring replacement
    // (a password of "p" must not turn "plain" into "[REDACTED]lain"). Exact
    // reflected values are still hidden, while longer wire secrets are removed
    // wherever a provider embeds them in diagnostics or payloads.
    if (secret.length < 4) {
      if (redacted === secret) redacted = "[REDACTED]";
    } else {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
  }
  return redacted;
}

/** @param {unknown} value @param {readonly string[]} secrets @returns {any} */
function redactPayload(value, secrets) {
  if (typeof value === "string") return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactPayload(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      redactString(key, secrets),
      redactPayload(item, secrets),
    ]));
  }
  return value;
}

/**
 * Origins explicitly trusted for credential-bearing redirect hops. The
 * initial origin is trusted by fetchWithPolicy. Legacy `allowedHosts` remains
 * scoped to deciding whether configured default headers may be attached to the
 * initial request; only `allowedOrigins` expands redirect credential trust.
 *
 * @param {CreateHttpToolOptions} options
 * @returns {string[]}
 */
function resolveAllowedOrigins(options) {
  const origins = new Set();
  for (const entry of options.allowedOrigins ?? []) {
    origins.add(assertHttpUrl(entry).origin);
  }
  return [...origins];
}

/**
 * Block localhost-style names and non-global IP literals selected by a model,
 * including every redirect hop. Explicit destination configuration is treated
 * as operator intent and can authorize an internal/special endpoint without
 * opening the entire private network.
 *
 * DNS names are checked for localhost-style names here. Deployments that allow
 * arbitrary public DNS should still enforce egress/DNS-rebinding policy at the
 * network boundary.
 *
 * @param {URL} url
 * @param {CreateHttpToolOptions} options
 * @param {AbortSignal | undefined} [signal]
 */
async function assertSafeHttpDestination(url, options, signal) {
  if (options.allowPrivateNetwork || isExplicitlyTrustedDestination(url, options)) return;
  await assertPublicHostname(url.hostname, {
    resolveHostname: options.resolveHostname,
    signal,
  });
}

/** @param {URL} url @param {CreateHttpToolOptions} options */
function isExplicitlyTrustedDestination(url, options) {
  if (options.baseUrl) {
    try {
      if (assertHttpUrl(options.baseUrl).origin === url.origin) return true;
    } catch {
      // Invalid configuration is surfaced when its value is otherwise used.
    }
  }
  for (const origin of options.allowedOrigins ?? []) {
    if (assertHttpUrl(origin).origin === url.origin) return true;
  }
  const allowedHosts = resolveAllowedHosts(options);
  return allowedHosts?.has(url.origin.toLowerCase()) ?? false;
}

/**
 * Attach the tool creator's configured default headers, but only to hosts the
 * creator trusts. `defaultHeaders` can carry secrets (API keys, cookies) while
 * the model chooses the request URL, so sending them to an arbitrary host would
 * leak them to an attacker-controlled endpoint. When `baseUrl`/`allowedHosts`
 * pin an allowlist the headers ride only to matching hosts; requests to the
 * configured base URL are never broken. Construction fails when defaults are
 * configured without either destination gate.
 *
 * @param {Headers} headers
 * @param {CreateHttpToolOptions} options
 * @param {URL} url
 */
function applyDefaultHeaders(headers, options, url) {
  const defaults = options.defaultHeaders;
  if (!defaults) return;
  const allowedHosts = resolveAllowedHosts(options);
  const hasDestinationGate = Boolean(options.baseUrl || allowedHosts);
  const matchesBaseOrigin = options.baseUrl
    ? assertHttpUrl(options.baseUrl).origin === url.origin
    : false;
  const matchesAllowedHost = allowedHosts?.has(url.origin.toLowerCase()) ?? false;
  if (hasDestinationGate && !matchesBaseOrigin && !matchesAllowedHost) return;
  for (const [key, value] of Object.entries(defaults)) {
    headers.set(key, value);
  }
}

/**
 * Build the explicit host-based exceptions allowed to receive
 * `defaultHeaders`. `baseUrl` is checked separately as an exact origin so an
 * HTTPS configuration never authorizes cleartext HTTP on the same host.
 * URL-form `allowedHosts` entries are exact origins. Bare hosts are interpreted
 * as HTTPS origins, so a credential gate can never silently authorize
 * cleartext HTTP. Ports remain part of the match. Returns null when no entry is
 * configured.
 *
 * @param {CreateHttpToolOptions} options
 * @returns {Set<string> | null}
 */
function resolveAllowedHosts(options) {
  const hosts = new Set();
  for (const entry of options.allowedHosts ?? []) {
    hosts.add(originOfAllowedHost(entry));
  }
  return hosts.size ? hosts : null;
}

/**
 * Accept either a bare HTTPS host (`api.example.com`,
 * `api.example.com:8443`) or a full HTTP(S) URL as an exact-origin entry.
 *
 * @param {string} entry
 * @returns {string}
 */
function originOfAllowedHost(entry) {
  const value = entry.trim();
  try {
    const explicitUrl = value.includes("://");
    const url = assertHttpUrl(explicitUrl ? value : `https://${value}`);
    // URL-form entries historically accepted API paths and normalized them to
    // an origin. Preserve that safe behavior; only bare-host syntax rejects a
    // disguised path/query/fragment.
    if (!explicitUrl && (url.pathname !== "/" || url.search || url.hash)) {
      throw new Error("path not allowed");
    }
    return url.origin.toLowerCase();
  } catch {
    throw new HttpClientPolicyError(
      "INVALID_OPTION",
      "allowedHosts entries must be bare HTTPS hosts or valid HTTP(S) URLs.",
      { option: "allowedHosts" },
    );
  }
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
 * @param {number} maxBytes
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<unknown>}
 */
async function parseResponseBody(response, maxBytes, signal) {
  if (response.status === 204 || response.status === 205) {
    return null;
  }
  const text = await readResponseText(response, { maxBytes, signal });
  if (!text) {
    return null;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return JSON.parse(text);
  }
  return text;
}
