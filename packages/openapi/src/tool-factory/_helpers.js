// ---------------------------------------------------------------------------
// Shared private helpers for OpenAPI tool factory
// ---------------------------------------------------------------------------
import { tool, zodSchema } from "ai";
import { Effect, Metric } from "effect";
import { nowMs } from "@smithers-orchestrator/scheduler/nowMs";
import {
    assertHttpUrl,
    fetchWithPolicy,
    HttpClientPolicyError,
    readResponseText,
} from "@smithers-orchestrator/http-client";
import { assertPublicHostname } from "@smithers-orchestrator/http-client/node";
import { openApiToolCallsTotal, openApiToolCallErrorsTotal, openApiToolDuration, } from "../metrics.js";
import { buildOperationSchema } from "../schema-converter.js";
import { extractOperations } from "../spec-parser.js";
import { getRequestBodyArgName } from "../getRequestBodyArgName.js";
import { SPEC_SOURCE_URL } from "../specSourceUrl.js";
/** @typedef {import("../OpenApiSpec.ts").OpenApiSpec} OpenApiSpec */
/** @typedef {import("../OpenApiTool.ts").OpenApiTool} OpenApiTool */
/** @typedef {import("../OpenApiToolsOptions.ts").OpenApiToolsOptions} OpenApiToolsOptions */
/** @typedef {import("../ParsedOperation.ts").ParsedOperation} ParsedOperation */

// Last-resort base URL, used only when the spec declares no servers[] and the
// caller passed no `baseUrl` option — requests then fail loudly against
// localhost instead of silently hitting an arbitrary host.
const FALLBACK_BASE_URL = "http://localhost";
const DEFAULT_MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * @param {OpenApiToolsOptions} options
 * @returns {number}
 */
function maxRequestBytes(options) {
    const value = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new HttpClientPolicyError(
            "INVALID_OPTION",
            "maxRequestBytes must be a non-negative safe integer.",
            { option: "maxRequestBytes" },
        );
    }
    return value;
}

/**
 * Validate the response cap before destination checks, serialization, or
 * transport. The response reader enforces the bound again while consuming the
 * stream, but an invalid local option must never allow a request side effect.
 *
 * @param {OpenApiToolsOptions} options
 * @returns {number}
 */
function maxResponseBytes(options) {
    const value = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new HttpClientPolicyError(
            "INVALID_OPTION",
            "maxResponseBytes must be a non-negative safe integer.",
            { option: "maxResponseBytes" },
        );
    }
    return value;
}

/**
 * Calculate UTF-8 length without allocating a second copy of a potentially
 * large string. Unpaired UTF-16 surrogates are encoded as U+FFFD, matching
 * TextEncoder and Fetch body serialization.
 *
 * @param {string} value
 * @param {number} [stopAfter]
 * @returns {number}
 */
function utf8ByteLength(value, stopAfter = Number.MAX_SAFE_INTEGER) {
    let bytes = 0;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code <= 0x7f) bytes += 1;
        else if (code <= 0x7ff) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff
            && index + 1 < value.length
            && value.charCodeAt(index + 1) >= 0xdc00
            && value.charCodeAt(index + 1) <= 0xdfff) {
            bytes += 4;
            index += 1;
        }
        else bytes += 3;
        if (bytes > stopAfter) return bytes;
    }
    return bytes;
}

/**
 * @param {number} limit
 * @param {{ contentLength?: number; serializedBytes?: number }} details
 * @returns {HttpClientPolicyError}
 */
function requestTooLarge(limit, details) {
    return new HttpClientPolicyError(
        "REQUEST_TOO_LARGE",
        "OpenAPI request body exceeds the configured byte limit.",
        { maxRequestBytes: limit, ...details },
    );
}

/**
 * @param {number} size
 * @param {number} limit
 */
function assertRequestSize(size, limit) {
    if (size > limit) throw requestTooLarge(limit, { serializedBytes: size });
}

/**
 * Reject a single obviously oversized value before an encoder makes another
 * copy. Aggregate and escaping overhead are checked again after serialization.
 *
 * @param {unknown} value
 * @param {number} limit
 */
function assertValueCanFit(value, limit) {
    if (typeof value === "string") {
        assertRequestSize(utf8ByteLength(value, limit), limit);
    }
    else if (value instanceof Blob) {
        assertRequestSize(value.size, limit);
    }
    else if (value instanceof ArrayBuffer) {
        assertRequestSize(value.byteLength, limit);
    }
}

/**
 * JSON.stringify with a transparent replacer lets us reject a large base64 or
 * other string leaf before the complete serialized JSON copy is materialized.
 * The final wire-size check still accounts for JSON quoting and escaping.
 *
 * @param {unknown} value
 * @param {number} limit
 * @returns {string | undefined}
 */
function stringifyJsonBounded(value, limit) {
    const serialized = JSON.stringify(value, (_key, item) => {
        // A string is transmitted verbatim (modulo JSON escaping), so it can
        // be rejected early. Blob/ArrayBuffer values stringify as ordinary
        // objects; their backing byte size is not part of the JSON wire body.
        if (typeof item === "string") assertValueCanFit(item, limit);
        return item;
    });
    if (serialized !== undefined) {
        assertRequestSize(utf8ByteLength(serialized, limit), limit);
    }
    return serialized;
}

/**
 * Set a plain-object header case-insensitively while preserving the winning
 * layer's spelling for adapters that inspect RequestInit directly.
 * @param {Record<string, string>} headers
 * @param {string} name
 * @param {string} value
 */
function setHeader(headers, name, value) {
    for (const existing of Object.keys(headers)) {
        if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
    }
    headers[name] = value;
}

/** @param {Record<string, string>} headers @param {string} name */
function deleteHeader(headers, name) {
    for (const existing of Object.keys(headers)) {
        if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
    }
}

/**
 * A spec controls servers[].url, so it cannot choose where operator secrets go.
 * Credentialed tools require an explicit baseUrl. Literal private/special
 * destinations likewise require either that pin or an explicit network opt-in.
 * @param {URL} url
 * @param {OpenApiToolsOptions} options
 * @param {AbortSignal | undefined} signal
 */
async function assertTrustedInitialDestination(url, options, signal) {
    if (options.baseUrl) {
        const pinned = assertHttpUrl(options.baseUrl);
        if (pinned.origin !== url.origin) {
            throw new HttpClientPolicyError(
                "INVALID_URL",
                "OpenAPI request origin does not match the operator-pinned baseUrl.",
                { reason: "untrusted-openapi-origin" },
            );
        }
        return;
    }
    if (options.auth || Object.keys(options.headers ?? {}).length > 0) {
        throw new HttpClientPolicyError(
            "INVALID_URL",
            "Credentialed OpenAPI tools require an explicit baseUrl; spec server URLs are not credential trust.",
            { reason: "untrusted-openapi-origin" },
        );
    }
    if (options.allowPrivateNetwork) return;
    await assertPublicHostname(url.hostname, {
        resolveHostname: options.resolveHostname,
        signal,
    });
}

/**
 * A public spec server must not pivot a generated request into instance
 * metadata, loopback, or another private literal through a redirect. An exact
 * operator-pinned base origin may redirect within itself; broader private
 * redirect access requires the explicit network opt-in.
 * @param {URL} url
 * @param {OpenApiToolsOptions} options
 * @param {URL} pinnedBase
 * @param {AbortSignal | undefined} signal
 */
async function assertTrustedRedirectDestination(url, options, pinnedBase, signal) {
    if (options.allowPrivateNetwork) return;
    if (options.baseUrl && url.origin === pinnedBase.origin) return;
    await assertPublicHostname(url.hostname, {
        resolveHostname: options.resolveHostname,
        signal,
    });
}

// ---------------------------------------------------------------------------
// HTTP execution
// ---------------------------------------------------------------------------
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

const REDACTED_SECRET = "[REDACTED]";

/**
 * @param {Set<string>} secrets
 * @param {unknown} value
 */
function addSecret(secrets, value) {
    if (typeof value === "string" && value.length > 0) secrets.add(value);
}

/**
 * Collect configured values that must never be reflected from a non-2xx
 * response into an agent-facing tool error. Include the actual Basic header
 * representation and URL encodings used for query API keys because an echoing
 * server can return either transmitted form.
 *
 * @param {OpenApiToolsOptions} options
 * @returns {string[]}
 */
function configuredSecretValues(options) {
    const secrets = new Set();
    for (const value of Object.values(options.headers ?? {})) addSecret(secrets, value);
    const auth = options.auth;
    if (auth?.type === "bearer") {
        addSecret(secrets, auth.token);
        if (auth.token.length > 0) addSecret(secrets, `Bearer ${auth.token}`);
    }
    else if (auth?.type === "basic") {
        const credential = `${auth.username}:${auth.password}`;
        const encoded = btoa(credential);
        addSecret(secrets, auth.password);
        if (auth.password.length > 0) {
            addSecret(secrets, credential);
            addSecret(secrets, encoded);
            addSecret(secrets, `Basic ${encoded}`);
        }
    }
    else if (auth?.type === "apiKey") {
        addSecret(secrets, auth.value);
        if (auth.in === "query" && auth.value.length > 0) {
            try {
                addSecret(secrets, encodeURIComponent(auth.value));
            }
            catch {
                // URLSearchParams below matches the actual query serializer and
                // safely handles malformed surrogate input.
            }
            const encoded = new URLSearchParams([["value", auth.value]])
                .toString()
                .slice("value=".length);
            addSecret(secrets, encoded);
        }
    }
    // Replace longer forms first so `Bearer token` becomes one marker instead
    // of leaving the non-secret auth scheme around a redacted token.
    return [...secrets].sort((left, right) => right.length - left.length);
}

/** @param {string} value @param {readonly string[]} secrets */
function redactString(value, secrets) {
    let redacted = value;
    for (const secret of secrets) {
        redacted = redacted.replaceAll(secret, REDACTED_SECRET);
    }
    return redacted;
}

/**
 * Redact strings recursively while preserving the ordinary JSON response
 * shape. Successful responses deliberately bypass this path.
 *
 * @param {unknown} value
 * @param {readonly string[]} secrets
 * @returns {unknown}
 */
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
 * @param {string} baseUrl
 * @param {string} path
 * @param {Record<string, string>} pathParams
 * @param {Record<string, string>} queryParams
 * @param {OpenApiToolsOptions} options
 * @returns {string}
 */
export function buildUrl(baseUrl, path, pathParams, queryParams, options) {
    // Substitute path parameters
    let url = path;
    for (const [key, value] of Object.entries(pathParams)) {
        url = url.replaceAll(`{${key}}`, encodeURIComponent(value));
    }
    // Join the server base path with the operation path so a base URL with a
    // path component (e.g. https://api.example.com/v2) is preserved. Passing an
    // absolute path to `new URL` would otherwise discard the base path.
    const fullUrl = new URL(baseUrl);
    const basePath = fullUrl.pathname.replace(/\/+$/, "");
    const opPath = url.replace(/^\/+/, "");
    fullUrl.pathname = opPath ? `${basePath}/${opPath}` : basePath || "/";
    // Add query parameters
    for (const [key, value] of Object.entries(queryParams)) {
        fullUrl.searchParams.set(key, value);
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
    if (value instanceof Blob)
        return value;
    if (typeof value === "string")
        return value;
    return String(value);
}
/**
 * @param {unknown} body
 * @param {number} limit
 * @returns {FormData}
 */
function buildFormData(body, limit) {
    const formData = new FormData();
    if (body && typeof body === "object" && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
        for (const [key, value] of Object.entries(body)) {
            if (value === undefined)
                continue;
            if (Array.isArray(value)) {
                for (const item of value) {
                    const formValue = toFormValue(item);
                    assertValueCanFit(formValue, limit);
                    formData.append(key, formValue);
                }
            }
            else {
                const formValue = toFormValue(value);
                assertValueCanFit(formValue, limit);
                formData.append(key, formValue);
            }
        }
        return formData;
    }
    const formValue = toFormValue(body);
    assertValueCanFit(formValue, limit);
    formData.append("body", formValue);
    return formData;
}

/** @param {AbortSignal | undefined} signal */
function abortReason(signal) {
    return signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
}

/**
 * Cancellation is user-extensible and may reject, throw, or never settle. It
 * is cleanup only: abort and byte-limit decisions must remain independent.
 * @param {{ cancel(reason?: unknown): Promise<unknown> }} target
 * @param {unknown} reason
 */
function cancelBestEffort(target, reason) {
    try {
        void target.cancel(reason).catch(() => undefined);
    }
    catch {
        // Preserve the primary abort/limit result from nonstandard streams.
    }
}

/**
 * Race a multipart read against the governing signal. Calling reader.cancel()
 * alone is insufficient because a hostile stream can leave both cancel() and
 * the outstanding read pending forever.
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @param {AbortSignal | undefined} signal
 */
function readMultipartChunk(reader, signal) {
    if (!signal) return reader.read();
    if (signal.aborted) return Promise.reject(abortReason(signal));
    return new Promise((resolve, reject) => {
        let settled = false;
        const settle = (complete) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            complete();
        };
        const onAbort = () => settle(() => reject(abortReason(signal)));
        signal.addEventListener("abort", onAbort, { once: true });
        reader.read().then(
            (result) => settle(() => resolve(result)),
            (error) => settle(() => reject(signal.aborted ? abortReason(signal) : error)),
        );
    });
}

/**
 * Materialize an already-encoded multipart stream only up to the configured
 * cap. This gives the byte limit the actual generated boundary and part-header
 * overhead. The owned byte snapshot is replayable, so an approved 307/308 can
 * send the exact same multipart boundary, headers, and bytes on every hop.
 *
 * @param {ReadableStream<Uint8Array>} stream
 * @param {number} limit
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<Uint8Array>}
 */
async function bufferMultipartBody(stream, limit, signal) {
    if (signal?.aborted) {
        const reason = abortReason(signal);
        cancelBestEffort(stream, reason);
        throw reason;
    }
    const reader = stream.getReader();
    /** @type {Uint8Array[]} */
    const chunks = [];
    let total = 0;
    let aborted = false;
    const onAbort = () => {
        aborted = true;
        cancelBestEffort(reader, abortReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
        while (true) {
            if (signal?.aborted || aborted) throw abortReason(signal);
            let result;
            try {
                result = await readMultipartChunk(reader, signal);
            }
            catch (error) {
                if (signal?.aborted || aborted) throw abortReason(signal);
                throw error;
            }
            if (signal?.aborted || aborted) throw abortReason(signal);
            if (result.done) break;
            if (!result.value) continue;
            total += result.value.byteLength;
            if (total > limit) {
                const error = requestTooLarge(limit, { serializedBytes: total });
                cancelBestEffort(reader, error);
                throw error;
            }
            // Own bytes retained beyond the encoder's next pull. Multipart is
            // bounded before this copy, so retained memory cannot grow without
            // limit even if a custom Blob stream reuses its backing storage.
            chunks.push(new Uint8Array(result.value));
        }
    }
    finally {
        signal?.removeEventListener("abort", onAbort);
        try {
            reader.releaseLock();
        }
        catch {
            // A hostile stream may keep an old read pending after cancellation;
            // never replace the caller's abort or byte-limit error with cleanup.
        }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

/**
 * @param {unknown} body
 * @param {Record<string, string>} headers
 * @param {number} limit
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<Uint8Array>}
 */
async function serializeMultipartBody(body, headers, limit, signal) {
    const formData = buildFormData(body, limit);
    const encoded = new Request("http://localhost", { method: "POST", body: formData });
    const contentType = encoded.headers.get("content-type");
    if (contentType) setHeader(headers, "Content-Type", contentType);
    if (!encoded.body) return new Uint8Array();
    return bufferMultipartBody(encoded.body, limit, signal);
}
/**
 * @param {unknown} body
 * @returns {URLSearchParams}
 */
function buildUrlEncodedBody(body, limit) {
    const params = new URLSearchParams();
    if (body && typeof body === "object" && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
        for (const [key, value] of Object.entries(body)) {
            if (value === undefined)
                continue;
            if (Array.isArray(value)) {
                for (const item of value) {
                    const stringValue = String(item);
                    assertValueCanFit(stringValue, limit);
                    params.append(key, stringValue);
                }
            }
            else {
                const stringValue = String(value);
                assertValueCanFit(stringValue, limit);
                params.append(key, stringValue);
            }
        }
        assertRequestSize(utf8ByteLength(params.toString(), limit), limit);
        return params;
    }
    const stringValue = String(body);
    assertValueCanFit(stringValue, limit);
    params.set("body", stringValue);
    assertRequestSize(utf8ByteLength(params.toString(), limit), limit);
    return params;
}
/**
 * @param {unknown} body
 * @returns {BodyInit}
 */
function buildRawBody(body, limit) {
    if (body instanceof Blob || body instanceof ArrayBuffer || typeof body === "string") {
        assertValueCanFit(body, limit);
        return body;
    }
    return stringifyJsonBounded(body, limit);
}
/**
 * @param {unknown} body
 * @param {string | undefined} mediaType
 * @param {Record<string, string>} headers
 * @param {number} limit
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<BodyInit | undefined>}
 */
async function serializeRequestBody(body, mediaType, headers, limit, signal) {
    const requestMediaType = mediaType ?? "application/json";
    if (requestMediaType.includes("multipart/form-data")) {
        deleteHeader(headers, "Content-Type");
        return serializeMultipartBody(body, headers, limit, signal);
    }
    if (requestMediaType.includes("application/x-www-form-urlencoded")) {
        setHeader(headers, "Content-Type", requestMediaType);
        return buildUrlEncodedBody(body, limit);
    }
    setHeader(headers, "Content-Type", requestMediaType);
    if (requestMediaType.includes("application/json") || requestMediaType.includes("+json")) {
        return stringifyJsonBounded(body, limit);
    }
    return buildRawBody(body, limit);
}

/**
 * Honor a caller-supplied Content-Length before doing any request-body
 * serialization. Fetch will still enforce header/body consistency.
 *
 * @param {Record<string, string>} headers
 * @param {number} limit
 */
function assertDeclaredRequestSize(headers, limit) {
    const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-length");
    if (!entry) return;
    const raw = String(entry[1]).trim();
    if (!/^\d+$/.test(raw)) return;
    const normalized = raw.replace(/^0+(?=\d)/, "");
    const limitText = String(limit);
    const exceeds = normalized.length > limitText.length
        || (normalized.length === limitText.length && normalized > limitText);
    if (!exceeds) return;
    const parsed = Number(normalized);
    throw requestTooLarge(limit, {
        contentLength: Number.isSafeInteger(parsed) ? parsed : "greater-than-safe-integer",
    });
}
/**
 * @param {ParsedOperation} operation
 * @param {Record<string, unknown>} args
 * @param {string} baseUrl
 * @param {OpenApiToolsOptions} options
 * @param {AbortSignal} [signal]
 * @returns {Promise<unknown>}
 */
export async function executeRequest(operation, args, baseUrl, options, signal) {
    // Validate configuration before DNS resolution, serialization, or any
    // transport work so a bad limit is always a deterministic local failure.
    const requestByteLimit = maxRequestBytes(options);
    const responseByteLimit = maxResponseBytes(options);
    /** @type {Record<string, string>} */
    const pathParams = {};
    /** @type {Record<string, string>} */
    const queryParams = {};
    /** @type {Record<string, string>} */
    const headerParams = {};
    // Sort parameters into buckets
    for (const param of operation.parameters) {
        const value = args[param.name];
        if (value === undefined)
            continue;
        const strValue = String(value);
        switch (param.in) {
            case "path":
                pathParams[param.name] = strValue;
                break;
            case "query":
                queryParams[param.name] = strValue;
                break;
            case "header":
                headerParams[param.name] = strValue;
                break;
        }
    }
    const resolvedBaseUrl = assertHttpUrl(baseUrl);
    await assertTrustedInitialDestination(resolvedBaseUrl, options, signal);
    const url = buildUrl(baseUrl, operation.path, pathParams, queryParams, options);
    // Trust boundary: spread LLM-controlled header *parameters* FIRST, then the
    // operator-injected auth/headers, so an LLM-supplied header param (e.g. a
    // spec that declares an `Authorization` header parameter, or an apiKey
    // header name) can never override or strip the operator-injected secret.
    /** @type {Record<string, string>} */
    const headers = { ...headerParams };
    for (const [name, value] of Object.entries(buildAuthHeaders(options))) {
        setHeader(headers, name, value);
    }
    assertDeclaredRequestSize(headers, requestByteLimit);
    /** @type {RequestInit & { duplex?: "half" }} */
    const fetchInit = {
        method: operation.method.toUpperCase(),
        headers,
    };
    // Request body — read from the SAME non-colliding key the schema used, so a
    // parameter named `body` (or `requestBody`) cannot shadow the actual body.
    // serializeRequestBody mutates `headers` in place and fetchInit already
    // references that object, so its Content-Type adjustments apply automatically.
    const requestBodyArgName = getRequestBodyArgName(operation.parameters);
    if (args[requestBodyArgName] !== undefined) {
        const serialized = await serializeRequestBody(
            args[requestBodyArgName],
            operation.requestBodyMediaType,
            headers,
            requestByteLimit,
            signal,
        );
        if (serialized !== undefined) {
            fetchInit.body = serialized;
            if (serialized instanceof ReadableStream) fetchInit.duplex = "half";
        }
    }
    assertHttpUrl(url);
    fetchInit.signal = signal;
    const response = await fetchWithPolicy(url, fetchInit, {
        allowedOrigins: [resolvedBaseUrl.origin, ...(options.allowedOrigins ?? [])],
        maxRedirects: options.maxRedirects,
        sensitiveHeaders: [
            ...Object.keys(options.headers ?? {}),
            ...Object.keys(headerParams),
            ...(options.auth?.type === "apiKey" && options.auth.in === "header"
                ? [options.auth.name]
                : []),
        ],
        sensitiveQueryParams: options.auth?.type === "apiKey" && options.auth.in === "query"
            ? [options.auth.name]
            : [],
        validateUrl: (candidate, context) => {
            if (!context.initial) return assertTrustedRedirectDestination(candidate, options, resolvedBaseUrl, signal);
        },
    });
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const responseText = await readResponseText(response, {
        maxBytes: responseByteLimit,
        signal,
    });
    // Surface non-2xx HTTP responses as errors so the agent cannot mistake a
    // 401/403/429/500 for a successful side-effecting call. A hostile endpoint
    // can echo request credentials in its response, so configured secret values
    // are removed from both the structured body and the rendered message.
    if (!response.ok) {
        /** @type {unknown} */
        let errorPayload = responseText || null;
        if (contentType.includes("application/json") && responseText) {
            try {
                errorPayload = JSON.parse(responseText);
            }
            catch {
                // Preserve malformed provider JSON as bounded text, then redact
                // it instead of surfacing a parser error that may quote secrets.
            }
        }
        const secrets = configuredSecretValues(options);
        const redactedPayload = redactPayload(errorPayload, secrets);
        const bodyText = typeof redactedPayload === "string"
            ? redactedPayload
            : JSON.stringify(redactedPayload);
        const statusText = redactString(response.statusText, secrets);
        const err = new Error(`HTTP ${response.status} ${statusText}: ${bodyText}`);
        /** @type {Error & { status?: number; body?: unknown }} */ (err).status = response.status;
        /** @type {Error & { status?: number; body?: unknown }} */ (err).body = redactedPayload;
        throw err;
    }

    /** @type {unknown} */
    let payload = responseText;
    if (contentType.includes("application/json") && responseText) {
        payload = JSON.parse(responseText);
    }
    else if (!responseText) {
        payload = null;
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
 * @returns {Effect.Effect<unknown, unknown, never>}
 */
export function executeToolEffect(operation, args, baseUrl, options) {
    const started = nowMs();
    return Effect.gen(function* () {
        yield* Metric.increment(openApiToolCallsTotal);
        return yield* Effect.tryPromise({
            try: (signal) => executeRequest(operation, args, baseUrl, options, signal),
            catch: (err) => err,
        });
    }).pipe(
        Effect.ensuring(Effect.suspend(() => Metric.update(openApiToolDuration, nowMs() - started))),
        Effect.tapError(() => Metric.increment(openApiToolCallErrorsTotal)),
        Effect.annotateLogs({
            toolName: `openapi:${operation.operationId}`,
            method: operation.method,
            path: operation.path,
        }),
        Effect.withLogSpan(`openapi:${operation.operationId}`));
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
    if (curation === false || curation?.include === false)
        return false;
    if (options.include && !options.include.includes(operation.operationId))
        return false;
    if (options.exclude && options.exclude.includes(operation.operationId))
        return false;
    return true;
}
/**
 * @param {unknown} value
 * @returns {string}
 */
function formatExampleValue(value) {
    if (typeof value === "string")
        return value;
    try {
        return JSON.stringify(value, null, 2);
    }
    catch {
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
    const description = curation && curation !== false && curation.description
        ? curation.description
        : operation.summary || operation.description || operation.operationId;
    const responseExamples = curation && curation !== false ? curation.responseExamples : undefined;
    if (!responseExamples || responseExamples.length === 0)
        return description;
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
            execute: async (args, execution) => {
                try {
                    return await Effect.runPromise(
                        executeToolEffect(operation, /** @type {Record<string, unknown>} */ (args), baseUrl, options),
                        execution?.abortSignal ? { signal: execution.abortSignal } : undefined,
                    );
                }
                catch (error) {
                    if (execution?.abortSignal?.aborted || (error instanceof Error && error.name === "AbortError")) {
                        throw execution?.abortSignal?.reason ?? error;
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
    }
    catch {
        return false;
    }
}
/**
 * Resolve a spec `servers[].url` to an absolute URL. Absolute URLs pass through
 * unchanged. A relative URL (e.g. the Swagger Petstore's "/api/v3") is resolved
 * against the URL the spec was loaded from; if that base is unknown, throw a
 * clear error naming the relative URL so the caller can pass `baseUrl`.
 *
 * @param {string} serverUrl
 * @param {OpenApiSpec} spec
 * @returns {string}
 */
function resolveServerUrl(serverUrl, spec) {
    if (isAbsoluteUrl(serverUrl))
        return serverUrl;
    const sourceUrl = /** @type {Record<PropertyKey, unknown>} */ (spec)[SPEC_SOURCE_URL];
    if (typeof sourceUrl === "string")
        return new URL(serverUrl, sourceUrl).toString();
    throw new Error(`OpenAPI spec server URL "${serverUrl}" is relative and no base URL is available to resolve it. `
        + `Pass an absolute base URL via the \`baseUrl\` option (e.g. { baseUrl: "https://api.example.com" }), `
        + `or load the spec from its URL so the relative server URL can be resolved against it.`);
}
/**
 * @param {OpenApiSpec} spec
 * @param {OpenApiToolsOptions} options
 * @returns {string}
 */
export function resolveBaseUrl(spec, options) {
    return options.baseUrl
        ? options.baseUrl
        : spec.servers && spec.servers.length > 0
            ? resolveServerUrl(spec.servers[0].url, spec)
            : FALLBACK_BASE_URL;
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
        if (!shouldIncludeOperation(op, options))
            continue;
        const { name, tool: t } = createToolFromOperation(op, spec, baseUrl, options);
        const existingOperationId = operationIdByToolName[name];
        if (existingOperationId) {
            throw new Error(`Duplicate OpenAPI tool name "${name}" for operations "${existingOperationId}" and "${op.operationId}". Use OpenAPI tool curation options to give each generated tool a unique name.`);
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
        throw new Error(`Operation "${operationId}" not found in spec. Available: ${operations.map((o) => o.operationId).join(", ")}`);
    }
    if (!shouldIncludeOperation(op, options)) {
        throw new Error(`Operation "${operationId}" is excluded by OpenAPI tool curation options.`);
    }
    const baseUrl = resolveBaseUrl(spec, options);
    return createToolFromOperation(op, spec, baseUrl, options).tool;
}
