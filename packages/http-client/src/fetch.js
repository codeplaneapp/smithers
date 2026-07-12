import { HttpClientPolicyError } from "./errors.js";
import { assertHttpUrl, safeUrlLabel } from "./url.js";

export const DEFAULT_MAX_REDIRECTS = 5;

export const DEFAULT_SENSITIVE_HEADERS = Object.freeze([
  "authorization",
  "proxy-authorization",
  "cookie",
  "cookie2",
  "x-api-key",
  "api-key",
  "xi-api-key",
  "x-subscription-token",
  "referer",
  "origin",
]);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BODY_HEADERS = [
  "content-encoding",
  "content-language",
  "content-length",
  "content-location",
  "content-type",
  "transfer-encoding",
];

/**
 * @param {AbortSignal} signal
 */
function throwIfAborted(signal) {
  if (!signal.aborted) return;
  throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

/** @param {AbortSignal} signal */
function abortReason(signal) {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

/**
 * Await an asynchronous policy check while preserving the exact caller abort
 * reason and detaching the temporary listener on every settlement path.
 *
 * @template T
 * @param {Promise<T>} pending
 * @param {AbortSignal} signal
 * @returns {Promise<T>}
 */
function awaitWithAbort(pending, signal) {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    /** @param {() => void} finish */
    const settle = (finish) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      finish();
    };
    const onAbort = () => settle(() => reject(abortReason(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(signal.aborted ? abortReason(signal) : error)),
    );
  });
}

/**
 * Ask an abandoned response body to release its resources without allowing a
 * hostile or broken stream cancellation algorithm to delay the policy result.
 * ReadableStream.cancel() is user-extensible and may reject or never settle;
 * cleanup must therefore remain detached from redirect and abort decisions.
 *
 * @param {Response} response
 * @param {unknown} [reason]
 */
function cancelBodyBestEffort(response, reason) {
  try {
    void response.body?.cancel(reason).catch(() => undefined);
  } catch {
    // Preserve the primary redirect/abort result if a nonstandard stream
    // implementation throws synchronously from cancel().
  }
}

/**
 * @param {unknown} value
 * @param {string} option
 * @returns {number}
 */
function nonNegativeInteger(value, option) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 0) {
    throw new HttpClientPolicyError(
      "INVALID_OPTION",
      `${option} must be a non-negative safe integer.`,
      { option },
    );
  }
  return /** @type {number} */ (value);
}

/**
 * @param {readonly (string | URL)[] | undefined} values
 * @param {string} initialOrigin
 * @returns {Set<string>}
 */
function authorizedOrigins(values, initialOrigin) {
  const origins = new Set([initialOrigin]);
  for (const value of values ?? []) {
    origins.add(assertHttpUrl(value).origin);
  }
  return origins;
}

/**
 * @param {readonly string[] | undefined} values
 * @returns {Set<string>}
 */
function lowerCaseNames(values) {
  const names = new Set();
  for (const value of values ?? []) {
    const name = value.trim().toLowerCase();
    if (name) names.add(name);
  }
  return names;
}

/**
 * @param {Headers} headers
 * @param {Set<string>} sensitiveHeaders
 */
function stripSensitiveHeaders(headers, sensitiveHeaders) {
  for (const name of sensitiveHeaders) headers.delete(name);
}

/**
 * @param {URL} url
 * @param {Set<string>} sensitiveQueryParams
 */
function stripSensitiveQueryParams(url, sensitiveQueryParams) {
  if (sensitiveQueryParams.size === 0) return;
  const names = [...url.searchParams.keys()];
  for (const name of names) {
    if (sensitiveQueryParams.has(name.toLowerCase())) url.searchParams.delete(name);
  }
}

/**
 * @param {unknown} body
 * @returns {BodyInit | null}
 */
function snapshotReplayableBody(body) {
  if (typeof body === "string" || body instanceof Blob) return body;
  if (body instanceof URLSearchParams) return new URLSearchParams(body);
  if (body instanceof ArrayBuffer) return body.slice(0);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice();
  }
  return null;
}

/**
 * Fetch-compatible redirect method transformation.
 * @param {number} status
 * @param {string} method
 * @returns {{ method: string; dropBody: boolean }}
 */
function redirectedMethod(status, method) {
  const upper = method.toUpperCase();
  if ((status === 301 || status === 302) && upper === "POST") {
    return { method: "GET", dropBody: true };
  }
  if (status === 303 && upper !== "GET" && upper !== "HEAD") {
    return { method: "GET", dropBody: true };
  }
  return { method: upper, dropBody: false };
}

/**
 * @param {Request} request
 * @param {URL} url
 * @param {string} method
 * @param {Headers} headers
 * @param {BodyInit | null} body
 * @param {boolean} omitCredentials
 * @returns {Request}
 */
function redirectRequest(request, url, method, headers, body, omitCredentials) {
  /** @type {RequestInit & { duplex?: "half" }} */
  const init = {
    method,
    headers,
    body,
    cache: request.cache,
    credentials: omitCredentials ? "omit" : request.credentials,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode,
    redirect: "manual",
    referrer: omitCredentials ? "" : request.referrer,
    referrerPolicy: omitCredentials ? "no-referrer" : request.referrerPolicy,
    signal: request.signal,
  };
  if (body instanceof ReadableStream) init.duplex = "half";
  return new Request(url, init);
}

/**
 * Preserve the ordinary `(url, init)` Fetch call shape used by injectable
 * transports while carrying forward Request-level options across redirects.
 * This matters beyond tests: lightweight platform adapters commonly inspect
 * `init.body`/`init.headers` and need not special-case a Request input.
 *
 * @param {Request} request
 * @param {HeadersInit} headers
 * @param {BodyInit | null | undefined} body
 * @returns {RequestInit & { duplex?: "half" }}
 */
function fetchInitFromRequest(request, headers, body) {
  /** @type {RequestInit & { duplex?: "half" }} */
  const init = {
    method: request.method,
    headers,
    cache: request.cache,
    credentials: request.credentials,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode,
    redirect: "manual",
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    signal: request.signal,
  };
  if (body !== null && body !== undefined) {
    init.body = body;
    if (body instanceof ReadableStream) init.duplex = "half";
  }
  return init;
}

/**
 * Fetch with an explicit, auditable redirect and credential policy. The
 * initial origin may receive sensitive material; an unauthorized cross-origin
 * hop is followed only after secrets are stripped, automatic credentials are
 * disabled, and any preserved request body is rejected. HTTPS downgrades are
 * always rejected. Every destination is passed through validateUrl before the
 * network call.
 *
 * @param {string | URL | Request} input
 * @param {RequestInit} [init]
 * @param {import("./types.ts").FetchWithPolicyOptions} [options]
 * @returns {Promise<Response>}
 */
export async function fetchWithPolicy(input, init = {}, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new HttpClientPolicyError(
      "INVALID_OPTION",
      "A Fetch implementation is required.",
      { option: "fetch" },
    );
  }
  const maxRedirects = nonNegativeInteger(
    options.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
    "maxRedirects",
  );

  /** @type {RequestInit & { duplex?: "half" }} */
  const initialInit = { ...init, redirect: "manual" };
  const requestInput = input instanceof Request ? input : assertHttpUrl(input);
  /** @type {Request} */
  let request;
  try {
    request = new Request(requestInput, initialInit);
  } catch {
    throw new HttpClientPolicyError(
      "INVALID_URL",
      "Outbound request could not be constructed.",
      {},
    );
  }
  let currentUrl = assertHttpUrl(request.url);
  const origins = authorizedOrigins(options.allowedOrigins, currentUrl.origin);
  const sensitiveHeaders = lowerCaseNames([
    ...DEFAULT_SENSITIVE_HEADERS,
    ...(options.sensitiveHeaders ?? []),
  ]);
  const sensitiveQueryParams = lowerCaseNames(options.sensitiveQueryParams);

  const explicitBody = init.body ?? null;
  let currentHasBody = request.body !== null;
  // Request construction snapshots the ordinary Fetch input, but injectable
  // transports below receive a `(url, init)` pair. Snapshot mutable body forms
  // here as well so caller mutation cannot change hop 1 or make a 307/308 replay
  // differ from the bytes already sent. Strings and Blobs are immutable.
  const replayableBody = explicitBody === null ? null : snapshotReplayableBody(explicitBody);
  // Request construction snapshots mutable Headers/record/tuple inputs. Use
  // that owned copy for hop one as well as redirects so caller mutation cannot
  // change the bytes or credential set after dispatch begins.
  /** @type {HeadersInit} */
  let currentHeaders = request.headers;
  /** @type {BodyInit | null | undefined} */
  let currentBody = init.body !== undefined
    // Request serializes FormData with a generated multipart boundary. Forward
    // that exact encoded stream with Request's matching Content-Type header;
    // passing the original FormData would generate a second, mismatched boundary.
    ? (init.body instanceof ReadableStream || init.body instanceof FormData
      ? request.body
      : (replayableBody ?? request.body))
    : request.body;
  let redirectCount = 0;
  /** @type {URL | undefined} */
  let fromUrl;

  while (true) {
    throwIfAborted(request.signal);
    const validateUrl = options.validateUrl;
    if (validateUrl) {
      const validation = Promise.resolve().then(() => {
        throwIfAborted(request.signal);
        return validateUrl(new URL(currentUrl.href), {
          initial: redirectCount === 0,
          ...(fromUrl ? { from: new URL(fromUrl.href) } : {}),
        });
      });
      await awaitWithAbort(validation, request.signal);
    }
    // validateUrl may be asynchronous (for example DNS policy), so cancellation
    // can win while it is running. Never enter the transport after that race.
    throwIfAborted(request.signal);
    let response;
    try {
      response = await fetchImpl(
        currentUrl.toString(),
        fetchInitFromRequest(request, currentHeaders, currentBody),
      );
    } catch (error) {
      if (request.signal.aborted) throw abortReason(request.signal);
      throw error;
    }
    if (request.signal.aborted) {
      const reason = abortReason(request.signal);
      cancelBodyBestEffort(response, reason);
      throw reason;
    }
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get("location");
    if (!location) return response;
    if (redirectCount >= maxRedirects) {
      cancelBodyBestEffort(response);
      throw new HttpClientPolicyError(
        "TOO_MANY_REDIRECTS",
        `Outbound request exceeded ${maxRedirects} redirects.`,
        { maxRedirects, url: safeUrlLabel(currentUrl) },
      );
    }

    let nextUrl;
    try {
      nextUrl = assertHttpUrl(new URL(location, currentUrl));
    } catch (cause) {
      cancelBodyBestEffort(response);
      if (cause instanceof HttpClientPolicyError && cause.code === "UNSUPPORTED_PROTOCOL") {
        throw cause;
      }
      throw new HttpClientPolicyError(
        "INVALID_REDIRECT",
        "Outbound response contains an invalid redirect target.",
        { from: safeUrlLabel(currentUrl) },
      );
    }
    if (currentUrl.protocol === "https:" && nextUrl.protocol === "http:") {
      cancelBodyBestEffort(response);
      throw new HttpClientPolicyError(
        "INSECURE_REDIRECT",
        "Outbound HTTPS request cannot redirect to HTTP.",
        { from: safeUrlLabel(currentUrl), to: safeUrlLabel(nextUrl) },
      );
    }

    const crossOrigin = nextUrl.origin !== currentUrl.origin;
    const destinationAuthorized = origins.has(nextUrl.origin);
    const { method, dropBody } = redirectedMethod(response.status, request.method);
    const preserveBody = currentHasBody && !dropBody;
    if (preserveBody && replayableBody === null) {
      cancelBodyBestEffort(response);
      throw new HttpClientPolicyError(
        "UNREPLAYABLE_BODY",
        "Redirect requires replaying a one-shot request body.",
        { status: response.status, from: safeUrlLabel(currentUrl), to: safeUrlLabel(nextUrl) },
      );
    }
    if (preserveBody && crossOrigin && !destinationAuthorized) {
      cancelBodyBestEffort(response);
      throw new HttpClientPolicyError(
        "CROSS_ORIGIN_BODY_BLOCKED",
        "Redirect cannot forward a request body to an unauthorized cross-origin destination.",
        { status: response.status, from: safeUrlLabel(currentUrl), to: safeUrlLabel(nextUrl) },
      );
    }

    const headers = new Headers(request.headers);
    if (dropBody) {
      for (const name of BODY_HEADERS) headers.delete(name);
    }
    headers.delete("host");
    const stripCredentials = crossOrigin && !destinationAuthorized;
    if (stripCredentials) {
      stripSensitiveHeaders(headers, sensitiveHeaders);
      stripSensitiveQueryParams(nextUrl, sensitiveQueryParams);
    }

    cancelBodyBestEffort(response);
    fromUrl = currentUrl;
    currentUrl = nextUrl;
    request = redirectRequest(
      request,
      nextUrl,
      method,
      headers,
      preserveBody ? replayableBody : null,
      stripCredentials,
    );
    currentHeaders = headers;
    currentBody = preserveBody ? replayableBody : undefined;
    currentHasBody = preserveBody;
    redirectCount += 1;
  }
}
