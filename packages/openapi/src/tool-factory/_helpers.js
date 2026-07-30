// ---------------------------------------------------------------------------
// Shared private helpers for OpenAPI tool factory
// ---------------------------------------------------------------------------
import { tool, zodSchema } from "ai";
import { Effect, Metric } from "effect";
import { nowMs } from "@smithers-orchestrator/scheduler/nowMs";
import { openApiToolCallsTotal, openApiToolCallErrorsTotal, openApiToolDuration } from "../metrics.js";
import { buildOperationSchema } from "../schema-converter.js";
import { extractOperations } from "../spec-parser.js";
import { getRequestBodyArgName } from "../getRequestBodyArgName.js";
import { SPEC_SOURCE_URL } from "../specSourceUrl.js";
/** @typedef {import("../OpenApiSpec.ts").OpenApiSpec} OpenApiSpec */
/** @typedef {import("../OpenApiTool.ts").OpenApiTool} OpenApiTool */
/** @typedef {import("../OpenApiToolsOptions.ts").OpenApiToolsOptions} OpenApiToolsOptions */
/** @typedef {import("../ParsedOperation.ts").ParsedOperation} ParsedOperation */
/** @typedef {NonNullable<OpenApiSpec["servers"]>[number]} ServerObject */

// Last-resort base URL, used only when the spec declares no servers[] and the
// caller passed no `baseUrl` option — requests then fail loudly against
// localhost instead of silently hitting an arbitrary host.
const FALLBACK_BASE_URL = "http://localhost";
const DEFAULT_MAX_RESPONSE_BODY_BYTES = 1_048_576;

// ---------------------------------------------------------------------------
// HTTP execution
// ---------------------------------------------------------------------------
/**
 * Set a header using HTTP's case-insensitive name semantics. Keeping a plain
 * object is convenient for request-body serialization and redirects, but a
 * plain object otherwise allows differently-cased duplicates that `Headers`
 * later combines into one value.
 *
 * @param {Record<string, string>} headers
 * @param {string} name
 * @param {string} value
 */
function setHeader(headers, name, value) {
  const normalizedName = name.toLowerCase();
  const matchingNames = Object.keys(headers).filter((key) => key.toLowerCase() === normalizedName);
  const targetName = matchingNames.shift() ?? name;
  for (const duplicateName of matchingNames) {
    delete headers[duplicateName];
  }
  headers[targetName] = value;
}
/**
 * @param {Record<string, string>} headers
 * @param {string} name
 */
function deleteHeader(headers, name) {
  const normalizedName = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === normalizedName) {
      delete headers[key];
    }
  }
}
/**
 * @param {OpenApiToolsOptions} options
 * @returns {Record<string, string>}
 */
export function buildAuthHeaders(options) {
  const headers = {};
  if (options.auth) {
    switch (options.auth.type) {
      case "bearer":
        setHeader(headers, "Authorization", `Bearer ${options.auth.token}`);
        break;
      case "basic": {
        const encoded = btoa(`${options.auth.username}:${options.auth.password}`);
        setHeader(headers, "Authorization", `Basic ${encoded}`);
        break;
      }
      case "apiKey":
        if (options.auth.in === "header") {
          setHeader(headers, options.auth.name, options.auth.value);
        }
        break;
    }
  }
  if (options.headers) {
    for (const [name, value] of Object.entries(options.headers)) {
      setHeader(headers, name, value);
    }
  }
  return headers;
}
/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * A value expanded per OpenAPI's `style: simple` (the default for path and
 * header parameters): either a scalar, or the segments an array/object expands
 * to. Segments stay split so each one can be percent-encoded on its own and the
 * "," / "=" delimiters survive as delimiters instead of becoming data.
 *
 * @typedef {string | Array<string | [string, string]>} SimpleStyleValue
 */
/**
 * Expand a path/header parameter value per `style: simple`: an array becomes
 * one segment per element ("a,b"), an object becomes "key,value" segments — or
 * "key=value" segments when `explode` is set.
 *
 * @param {unknown} value
 * @param {boolean} explode
 * @returns {SimpleStyleValue}
 */
function toSimpleStyleValue(value, explode) {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    return explode
      ? entries.map(([key, item]) => /** @type {[string, string]} */ ([key, String(item)]))
      : entries.flatMap(([key, item]) => [key, String(item)]);
  }
  return String(value);
}
/**
 * Join a `style: simple` value, applying `encode` per segment.
 *
 * @param {SimpleStyleValue} value
 * @param {(part: string) => string} encode
 * @returns {string}
 */
function joinSimpleStyleValue(value, encode) {
  if (!Array.isArray(value)) return encode(value);
  return value
    .map((segment) => (Array.isArray(segment) ? `${encode(segment[0])}=${encode(segment[1])}` : encode(segment)))
    .join(",");
}
/**
 * Expand a query parameter into the `[name, value]` entries its OpenAPI
 * serialization produces. Defaults are `style: form` with `explode: true`, so
 * an array becomes one entry per element and an object one entry per property.
 *
 * @param {ParameterObject} param
 * @param {unknown} value
 * @returns {Array<[string, string]>}
 */
function toQueryEntries(param, value) {
  const style = param.style ?? "form";
  const explode = param.explode ?? style === "form";
  if (Array.isArray(value)) {
    if (explode) return value.map((item) => /** @type {[string, string]} */ ([param.name, String(item)]));
    const delimiter = style === "spaceDelimited" ? " " : style === "pipeDelimited" ? "|" : ",";
    return [[param.name, value.map((item) => String(item)).join(delimiter)]];
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (style === "deepObject")
      return entries.map(([key, item]) => /** @type {[string, string]} */ ([`${param.name}[${key}]`, String(item)]));
    if (explode) return entries.map(([key, item]) => /** @type {[string, string]} */ ([key, String(item)]));
    return [[param.name, entries.flatMap(([key, item]) => [key, String(item)]).join(",")]];
  }
  return [[param.name, String(value)]];
}
/**
 * @param {string} baseUrl
 * @param {string} path
 * @param {Record<string, SimpleStyleValue>} pathParams
 * @param {Record<string, string | string[]>} queryParams - An array value emits
 *   one query entry per element (OpenAPI `style: form`, `explode: true`).
 * @param {OpenApiToolsOptions} options
 * @returns {string}
 */
export function buildUrl(baseUrl, path, pathParams, queryParams, options) {
  // Substitute path parameters
  let url = path;
  for (const [key, value] of Object.entries(pathParams)) {
    url = url.replaceAll(`{${key}}`, joinSimpleStyleValue(value, encodeURIComponent));
  }
  // Join the server base path with the operation path so a base URL with a
  // path component (e.g. https://api.example.com/v2) is preserved. Passing an
  // absolute path to `new URL` would otherwise discard the base path.
  const fullUrl = new URL(baseUrl);
  assertHttpUrl(fullUrl);
  const basePath = fullUrl.pathname.replace(/\/+$/, "");
  const opPath = url.replace(/^\/+/, "");
  fullUrl.pathname = opPath ? `${basePath}/${opPath}` : basePath || "/";
  // Add query parameters
  for (const [key, value] of Object.entries(queryParams)) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      fullUrl.searchParams.append(key, entry);
    }
  }
  // Add API key to query if configured
  if (options.auth?.type === "apiKey" && options.auth.in === "query") {
    fullUrl.searchParams.set(options.auth.name, options.auth.value);
  }
  return fullUrl.toString();
}
/**
 * @param {unknown} value
 * @returns {string | Blob}
 */
function toFormValue(value) {
  if (value instanceof Blob) return value;
  if (typeof value === "string") return value;
  return String(value);
}
/**
 * @param {unknown} body
 * @returns {FormData}
 */
function buildFormData(body) {
  const formData = new FormData();
  if (body && typeof body === "object" && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          formData.append(key, toFormValue(item));
        }
      } else {
        formData.append(key, toFormValue(value));
      }
    }
    return formData;
  }
  formData.append("body", toFormValue(body));
  return formData;
}
/**
 * @param {unknown} body
 * @returns {URLSearchParams}
 */
function buildUrlEncodedBody(body) {
  const params = new URLSearchParams();
  if (body && typeof body === "object" && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          params.append(key, String(item));
        }
      } else {
        params.append(key, String(value));
      }
    }
    return params;
  }
  params.set("body", String(body));
  return params;
}
/**
 * @param {unknown} body
 * @returns {BodyInit}
 */
function buildRawBody(body) {
  if (body instanceof Blob || body instanceof ArrayBuffer || typeof body === "string") {
    return body;
  }
  return JSON.stringify(body);
}
/**
 * @param {unknown} body
 * @param {string | undefined} mediaType
 * @param {Record<string, string>} headers
 * @returns {BodyInit}
 */
function serializeRequestBody(body, mediaType, headers) {
  const requestMediaType = mediaType ?? "application/json";
  if (requestMediaType.includes("multipart/form-data")) {
    deleteHeader(headers, "Content-Type");
    return buildFormData(body);
  }
  if (requestMediaType.includes("application/x-www-form-urlencoded")) {
    setHeader(headers, "Content-Type", requestMediaType);
    return buildUrlEncodedBody(body);
  }
  setHeader(headers, "Content-Type", requestMediaType);
  if (requestMediaType.includes("application/json") || requestMediaType.includes("+json")) {
    return JSON.stringify(body);
  }
  return buildRawBody(body);
}
// Same ceiling as the WHATWG fetch spec's `redirect: "follow"` behavior.
const MAX_REDIRECTS = 20;
/**
 * @param {number} status
 * @returns {boolean}
 */
function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
/**
 * Build the set of origins a redirect may be followed to: the origin of the
 * request itself (i.e. the configured OpenAPI service) plus any operator
 * allowlist entries. Entries are normalized via `URL.origin` (lowercased
 * host, default ports elided), and an unparseable entry fails loudly rather
 * than silently narrowing the allowlist.
 *
 * @param {string} requestUrl
 * @param {OpenApiToolsOptions} options
 * @returns {Set<string>}
 */
function buildAllowedRedirectOrigins(requestUrl, options) {
  const allowed = new Set([new URL(requestUrl).origin]);
  for (const entry of options.allowedRedirectOrigins ?? []) {
    try {
      allowed.add(new URL(entry).origin);
    } catch {
      throw new Error(
        `Invalid allowedRedirectOrigins entry "${entry}": must be an absolute URL or origin (e.g. "https://cdn.example.com").`,
      );
    }
  }
  return allowed;
}
/**
 * Copy `headers` minus the body-describing entries, for a redirect hop that
 * rewrites the method to GET (301/302 on POST, 303) and drops the body.
 *
 * @param {Record<string, string>} headers
 * @returns {Record<string, string>}
 */
function stripContentHeaders(headers) {
  /** @type {Record<string, string>} */
  const stripped = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (
      lower === "content-type" ||
      lower === "content-length" ||
      lower === "content-encoding" ||
      lower === "content-language" ||
      lower === "content-location"
    ) {
      continue;
    }
    stripped[key] = value;
  }
  return stripped;
}
/**
 * Fetch with manual redirect handling so EVERY redirect destination is
 * validated against the configured OpenAPI service origin (the origin of the
 * request URL) or the operator's `allowedRedirectOrigins` allowlist. The
 * injected Authorization / API-key headers ride on every hop, so silently
 * following a redirect to a foreign origin (native `redirect: "follow"`)
 * would hand the operator's secret to that origin — instead we fail closed
 * before the cross-origin request is ever sent. Same-origin and allowlisted
 * redirects behave like standard `redirect: "follow"`, including the
 * spec-mandated method rewrite to GET on 303 (and 301/302 for POST).
 *
 * @param {string} url
 * @param {string} method
 * @param {Record<string, string>} headers
 * @param {BodyInit | undefined} body
 * @param {OpenApiToolsOptions} options
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<Response>}
 */
async function fetchWithRedirectValidation(url, method, headers, body, options, signal) {
  const allowedOrigins = buildAllowedRedirectOrigins(url, options);
  let currentUrl = url;
  let currentMethod = method;
  let currentHeaders = headers;
  let currentBody = body;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertHttpUrl(new URL(currentUrl));
    /** @type {RequestInit} */
    const init = { method: currentMethod, headers: currentHeaders, redirect: "manual" };
    if (currentBody !== undefined) {
      init.body = currentBody;
    }
    if (signal !== undefined) {
      init.signal = signal;
    }
    const response = await fetch(currentUrl, init);
    if (!isRedirectStatus(response.status)) {
      return response;
    }
    const location = response.headers.get("location");
    if (location === null) {
      return response;
    }
    const nextUrl = new URL(location, currentUrl);
    await response.body?.cancel();
    assertHttpUrl(nextUrl);
    if (!allowedOrigins.has(nextUrl.origin)) {
      // Name only origins — the full request URL can carry an
      // apiKey-in-query credential and must never reach the error
      // message (which is returned to the model as the tool result).
      throw new Error(
        `OpenAPI request was redirected (HTTP ${response.status}) to disallowed origin "${nextUrl.origin}" — refusing to follow so the configured credentials cannot leak off "${new URL(currentUrl).origin}". ` +
          `Add the origin to the \`allowedRedirectOrigins\` option if this redirect destination is trusted.`,
      );
    }
    const switchToGet =
      (response.status === 303 && currentMethod !== "GET" && currentMethod !== "HEAD") ||
      ((response.status === 301 || response.status === 302) && currentMethod === "POST");
    if (switchToGet) {
      currentMethod = "GET";
      currentBody = undefined;
      currentHeaders = stripContentHeaders(currentHeaders);
    }
    currentUrl = nextUrl.toString();
  }
  throw new Error(`OpenAPI request exceeded ${MAX_REDIRECTS} redirects.`);
}

/** @param {URL} url */
function assertHttpUrl(url) {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`OpenAPI request does not support URL protocol "${url.protocol}"`);
  }
}
/**
 * @param {OpenApiToolsOptions} options
 * @returns {number}
 */
function resolveMaxResponseBodyBytes(options) {
  const maxBytes = options.maxResponseBodyBytes ?? DEFAULT_MAX_RESPONSE_BODY_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("maxResponseBodyBytes must be a positive safe integer.");
  }
  return maxBytes;
}
/**
 * @param {number} maxBytes
 * @returns {Error}
 */
function responseBodyTooLargeError(maxBytes) {
  return new Error(`OpenAPI response body exceeds maxResponseBodyBytes limit of ${maxBytes} bytes.`);
}
/**
 * @param {ReadableStream<Uint8Array> | null} body
 * @param {unknown} reason
 */
async function cancelResponseBody(body, reason) {
  if (body === null) return;
  try {
    await body.cancel(reason);
  } catch {
    // Preserve the overflow/abort error even if transport cleanup fails.
  }
}
/**
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @param {unknown} reason
 */
async function cancelResponseReader(reader, reason) {
  try {
    await reader.cancel(reason);
  } catch {
    // Preserve the overflow/abort error even if transport cleanup fails.
  }
}
/**
 * @param {string | null} contentLength
 * @param {number} maxBytes
 * @returns {boolean}
 */
function declaredContentLengthExceedsLimit(contentLength, maxBytes) {
  if (contentLength === null) return false;
  const normalized = contentLength.trim();
  if (!/^\d+$/.test(normalized)) return false;
  return BigInt(normalized) > BigInt(maxBytes);
}
/**
 * @param {Response} response
 * @param {number} maxBytes
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<Uint8Array>}
 */
async function readResponseBodyBytes(response, maxBytes, signal) {
  const body = response.body;
  if (signal?.aborted) {
    await cancelResponseBody(body, signal.reason);
    signal.throwIfAborted();
  }
  if (declaredContentLengthExceedsLimit(response.headers.get("content-length"), maxBytes)) {
    const error = responseBodyTooLargeError(maxBytes);
    await cancelResponseBody(body, error);
    throw error;
  }
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let totalBytes = 0;
  /** @type {Promise<void> | undefined} */
  let abortCancellation;
  const cancelOnAbort = () => {
    abortCancellation = cancelResponseReader(reader, signal?.reason);
  };
  signal?.addEventListener("abort", cancelOnAbort, { once: true });
  try {
    signal?.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        const error = responseBodyTooLargeError(maxBytes);
        await cancelResponseReader(reader, error);
        throw error;
      }
      chunks.push(value);
    }
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancelOnAbort);
    await abortCancellation;
    reader.releaseLock();
  }
  if (chunks.length === 1) return chunks[0];
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
/**
 * @param {ParsedOperation} operation
 * @param {Record<string, unknown>} args
 * @param {string} baseUrl
 * @param {OpenApiToolsOptions} options
 * @param {AbortSignal} [signal] - Aborts the underlying fetch (every redirect
 *   hop and the body read), e.g. when the AI SDK cancels the tool call.
 * @returns {Promise<unknown>}
 */
export async function executeRequest(operation, args, baseUrl, options, signal) {
  const maxResponseBodyBytes = resolveMaxResponseBodyBytes(options);
  /** @type {Record<string, SimpleStyleValue>} */
  const pathParams = {};
  /** @type {Record<string, string[]>} */
  const queryParams = {};
  // Reserve every operator-controlled header before accepting model-supplied
  // parameters. Header names are case-insensitive, regardless of how the
  // OpenAPI operation spells them.
  const headers = buildAuthHeaders(options);
  const reservedHeaderNames = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
  // Sort parameters into buckets. Array/object values are expanded per the
  // parameter's OpenAPI serialization style — `String(value)` would collapse
  // them into one "a,b" query entry (or "[object Object]") that the upstream
  // API reads as a single literal value.
  for (const param of operation.parameters) {
    const value = args[param.name];
    if (value === undefined) continue;
    switch (param.in) {
      case "path":
        pathParams[param.name] = toSimpleStyleValue(value, param.explode ?? false);
        break;
      case "query":
        for (const [name, entry] of toQueryEntries(param, value)) {
          (queryParams[name] ??= []).push(entry);
        }
        break;
      case "header":
        if (!reservedHeaderNames.has(param.name.toLowerCase())) {
          setHeader(
            headers,
            param.name,
            joinSimpleStyleValue(toSimpleStyleValue(value, param.explode ?? false), (part) => part),
          );
        }
        break;
    }
  }
  const url = buildUrl(baseUrl, operation.path, pathParams, queryParams, options);
  // Request body — read from the SAME non-colliding key the schema used, so a
  // parameter named `body` (or `requestBody`) cannot shadow the actual body.
  // serializeRequestBody mutates `headers` in place, so its Content-Type
  // adjustments apply to the request automatically.
  const requestBodyArgName = getRequestBodyArgName(operation.parameters);
  /** @type {BodyInit | undefined} */
  const body =
    args[requestBodyArgName] !== undefined
      ? serializeRequestBody(args[requestBodyArgName], operation.requestBodyMediaType, headers)
      : undefined;
  // Redirects are followed manually so injected auth headers can never leak
  // to an origin outside the configured service origin / allowlist.
  const response = await fetchWithRedirectValidation(
    url,
    operation.method.toUpperCase(),
    headers,
    body,
    options,
    signal,
  );
  const contentType = response.headers.get("content-type") ?? "";
  const responseBodyBytes = await readResponseBodyBytes(response, maxResponseBodyBytes, signal);
  const responseBodyText = new TextDecoder().decode(responseBodyBytes);
  /** @type {unknown} */
  const payload = contentType.includes("application/json") ? JSON.parse(responseBodyText) : responseBodyText;
  // Surface non-2xx HTTP responses as errors so the agent cannot mistake a
  // 401/403/429/500 for a successful side-effecting call. The status and
  // response body are included; the error never embeds the RequestInit (which
  // carries the injected Authorization header), so the secret cannot leak.
  if (!response.ok) {
    const bodyText = typeof payload === "string" ? payload : JSON.stringify(payload);
    const err = new Error(`HTTP ${response.status} ${response.statusText}: ${bodyText}`);
    /** @type {Error & { status?: number; body?: unknown }} */ (err).status = response.status;
    /** @type {Error & { status?: number; body?: unknown }} */ (err).body = payload;
    throw err;
  }
  return payload;
}
// ---------------------------------------------------------------------------
// Effect-wrapped execution with metrics
// ---------------------------------------------------------------------------
/**
 * @param {ParsedOperation} operation
 * @param {Record<string, unknown>} args
 * @param {string} baseUrl
 * @param {OpenApiToolsOptions} options
 * @param {AbortSignal} [abortSignal] - External cancellation (the AI SDK's
 *   `ToolExecutionOptions.abortSignal`), combined with the fiber's own
 *   interruption signal so both cancel the underlying fetch.
 * @returns {Effect.Effect<unknown, unknown, never>}
 */
export function executeToolEffect(operation, args, baseUrl, options, abortSignal) {
  return Effect.suspend(() => {
    const started = nowMs();
    return Effect.gen(function* () {
      yield* Metric.update(openApiToolCallsTotal, 1);
      return yield* Effect.tryPromise({
        // The `(fiberSignal)` form makes fiber interruption abort the
        // in-flight request instead of orphaning it.
        try: (fiberSignal) =>
          executeRequest(
            operation,
            args,
            baseUrl,
            options,
            abortSignal === undefined ? fiberSignal : AbortSignal.any([abortSignal, fiberSignal]),
          ),
        catch: (err) => err,
      });
    }).pipe(Effect.ensuring(Effect.suspend(() => Metric.update(openApiToolDuration, nowMs() - started))));
  }).pipe(
    Effect.tapError(() => Metric.update(openApiToolCallErrorsTotal, 1)),
    Effect.annotateLogs({
      toolName: `openapi:${operation.operationId}`,
      method: operation.method,
      path: operation.path,
    }),
    Effect.withLogSpan(`openapi:${operation.operationId}`),
  );
}
// ---------------------------------------------------------------------------
// Tool creation
// ---------------------------------------------------------------------------
/**
 * @param {ParsedOperation} operation
 * @param {OpenApiToolsOptions} options
 * @returns {false | Exclude<NonNullable<OpenApiToolsOptions["operations"]>[string], false> | undefined}
 */
export function getOperationCuration(operation, options) {
  return options.operations?.[operation.operationId];
}
/**
 * @param {ParsedOperation} operation
 * @param {OpenApiToolsOptions} options
 * @returns {boolean}
 */
export function shouldIncludeOperation(operation, options) {
  const curation = getOperationCuration(operation, options);
  if (curation === false || curation?.include === false) return false;
  if (options.include && !options.include.includes(operation.operationId)) return false;
  if (options.exclude && options.exclude.includes(operation.operationId)) return false;
  return true;
}
/**
 * @param {unknown} value
 * @returns {string}
 */
function formatExampleValue(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
/**
 * @param {ParsedOperation} operation
 * @param {OpenApiToolsOptions} options
 * @returns {string}
 */
export function buildToolDescription(operation, options) {
  const curation = getOperationCuration(operation, options);
  const description =
    curation && curation !== false && curation.description
      ? curation.description
      : operation.summary || operation.description || operation.operationId;
  const responseExamples = curation && curation !== false ? curation.responseExamples : undefined;
  if (!responseExamples || responseExamples.length === 0) return description;
  const examples = responseExamples.map((example) => {
    const status = example.status === undefined ? "" : `${example.status} `;
    const label = example.description ? `${status}${example.description}` : status.trim();
    const value = formatExampleValue(example.value);
    return label ? `${label}\n${value}` : value;
  });
  return `${description}\n\nResponse examples:\n${examples.join("\n\n")}`;
}
/**
 * @param {ParsedOperation} operation
 * @param {OpenApiSpec} spec
 * @param {string} baseUrl
 * @param {OpenApiToolsOptions} options
 * @returns {{ name: string; tool: OpenApiTool }}
 */
export function createToolFromOperation(operation, spec, baseUrl, options) {
  const inputSchema = buildOperationSchema(operation.parameters, operation.requestBody, spec);
  const curation = getOperationCuration(operation, options);
  const description = buildToolDescription(operation, options);
  const prefix = options.namePrefix ?? "";
  const operationName = curation && curation !== false && curation.name ? curation.name : operation.operationId;
  return {
    name: `${prefix}${operationName}`,
    tool: tool({
      description,
      inputSchema: zodSchema(inputSchema),
      execute: async (args, executionOptions) => {
        const abortSignal = executionOptions?.abortSignal;
        try {
          abortSignal?.throwIfAborted();
          return await Effect.runPromise(
            executeToolEffect(operation, /** @type {Record<string, unknown>} */ (args), baseUrl, options, abortSignal),
          );
        } catch (error) {
          // A cancelled call is not a tool failure: rethrow so the
          // AI SDK observes the abort instead of a fabricated
          // error result the model would try to act on.
          if (abortSignal?.aborted) {
            throw error;
          }
          // Return error info as tool result instead of throwing
          const e = /** @type {{ message?: string }} */ (error);
          return {
            error: true,
            message: e?.message ?? String(error),
            status: "failed",
          };
        }
      },
    }),
  };
}
/**
 * @param {string} url
 * @returns {boolean}
 */
function isAbsoluteUrl(url) {
  try {
    // A URL is absolute iff it parses without a base.
    void new URL(url);
    return true;
  } catch {
    return false;
  }
}
/**
 * Substitute OpenAPI server variables ("https://{region}.api.example.com") with
 * the defaults declared in `servers[].variables`. A `{name}` with no declared
 * default is left in place for `resolveServerUrl` to reject — a templated host
 * would otherwise be used verbatim and fail with an opaque DNS error per call.
 *
 * @param {ServerObject} server
 * @returns {string}
 */
function substituteServerVariables(server) {
  const variables = server.variables;
  if (!variables) return server.url;
  return server.url.replace(/\{([^{}]*)\}/g, (placeholder, name) => {
    const value = variables[name]?.default;
    return typeof value === "string" ? value : placeholder;
  });
}
/**
 * Resolve a spec `servers[]` entry to an absolute URL. Server variables are
 * substituted with their declared defaults first. Absolute URLs then pass
 * through unchanged. A relative URL (e.g. the Swagger Petstore's "/api/v3") is
 * resolved against the URL the spec was loaded from; if that base is unknown,
 * throw a clear error naming the relative URL so the caller can pass `baseUrl`.
 *
 * @param {ServerObject} server
 * @param {OpenApiSpec} spec
 * @returns {string}
 */
function resolveServerUrl(server, spec) {
  const serverUrl = substituteServerVariables(server);
  const unresolved = serverUrl.match(/\{[^{}]*\}/);
  if (unresolved)
    throw new Error(
      `OpenAPI spec server URL "${server.url}" leaves variable "${unresolved[0]}" unresolved because it declares no default under \`servers[].variables\`. ` +
        `Pass an absolute base URL via the \`baseUrl\` option (e.g. { baseUrl: "https://us.api.example.com" }).`,
    );
  if (isAbsoluteUrl(serverUrl)) return serverUrl;
  const sourceUrl = /** @type {Record<PropertyKey, unknown>} */ (spec)[SPEC_SOURCE_URL];
  if (typeof sourceUrl === "string") return new URL(serverUrl, sourceUrl).toString();
  throw new Error(
    `OpenAPI spec server URL "${serverUrl}" is relative and no base URL is available to resolve it. ` +
      `Pass an absolute base URL via the \`baseUrl\` option (e.g. { baseUrl: "https://api.example.com" }), ` +
      `or load the spec from its URL so the relative server URL can be resolved against it.`,
  );
}
/**
 * @param {OpenApiSpec} spec
 * @param {OpenApiToolsOptions} options
 * @returns {string}
 */
export function resolveBaseUrl(spec, options) {
  if (options.baseUrl) return options.baseUrl;
  if (spec.servers && spec.servers.length > 0) return resolveServerUrl(spec.servers[0], spec);
  return FALLBACK_BASE_URL;
}
/**
 * @param {OpenApiSpec} spec
 * @param {OpenApiToolsOptions} options
 * @returns {Record<string, OpenApiTool>}
 */
export function createOpenApiToolsFromSpec(spec, options) {
  const operations = extractOperations(spec);
  const baseUrl = resolveBaseUrl(spec, options);
  /** @type {Record<string, OpenApiTool>} */
  const tools = {};
  /** @type {Record<string, string>} */
  const operationIdByToolName = {};
  for (const op of operations) {
    if (!shouldIncludeOperation(op, options)) continue;
    const { name, tool: t } = createToolFromOperation(op, spec, baseUrl, options);
    const existingOperationId = operationIdByToolName[name];
    if (existingOperationId) {
      throw new Error(
        `Duplicate OpenAPI tool name "${name}" for operations "${existingOperationId}" and "${op.operationId}". Use OpenAPI tool curation options to give each generated tool a unique name.`,
      );
    }
    operationIdByToolName[name] = op.operationId;
    tools[name] = t;
  }
  return tools;
}
/**
 * @param {OpenApiSpec} spec
 * @param {string} operationId
 * @param {OpenApiToolsOptions} options
 * @returns {OpenApiTool}
 */
export function createOpenApiToolFromSpec(spec, operationId, options) {
  const operations = extractOperations(spec);
  const op = operations.find((o) => o.operationId === operationId);
  if (!op) {
    throw new Error(
      `Operation "${operationId}" not found in spec. Available: ${operations.map((o) => o.operationId).join(", ")}`,
    );
  }
  if (!shouldIncludeOperation(op, options)) {
    throw new Error(`Operation "${operationId}" is excluded by OpenAPI tool curation options.`);
  }
  const baseUrl = resolveBaseUrl(spec, options);
  return createToolFromOperation(op, spec, baseUrl, options).tool;
}
