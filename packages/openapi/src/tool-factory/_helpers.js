// ---------------------------------------------------------------------------
// Shared private helpers for OpenAPI tool factory
// ---------------------------------------------------------------------------
import { tool, zodSchema } from "ai";
import { Effect, Metric } from "effect";
import { nowMs } from "@smithers-orchestrator/scheduler/nowMs";
import { openApiToolCallsTotal, openApiToolCallErrorsTotal, openApiToolDuration, } from "../metrics.js";
import { buildOperationSchema } from "../schema-converter.js";
import { extractOperations } from "../spec-parser.js";
import { getRequestBodyArgName } from "../getRequestBodyArgName.js";
/** @typedef {import("../OpenApiSpec.ts").OpenApiSpec} OpenApiSpec */
/** @typedef {import("../OpenApiTool.ts").OpenApiTool} OpenApiTool */
/** @typedef {import("../OpenApiToolsOptions.ts").OpenApiToolsOptions} OpenApiToolsOptions */
/** @typedef {import("../ParsedOperation.ts").ParsedOperation} ParsedOperation */

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
                headers["Authorization"] = `Bearer ${options.auth.token}`;
                break;
            case "basic": {
                const encoded = btoa(`${options.auth.username}:${options.auth.password}`);
                headers["Authorization"] = `Basic ${encoded}`;
                break;
            }
            case "apiKey":
                if (options.auth.in === "header") {
                    headers[options.auth.name] = options.auth.value;
                }
                break;
        }
    }
    if (options.headers) {
        Object.assign(headers, options.headers);
    }
    return headers;
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
 * @returns {FormData}
 */
function buildFormData(body) {
    const formData = new FormData();
    if (body && typeof body === "object" && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
        for (const [key, value] of Object.entries(body)) {
            if (value === undefined)
                continue;
            if (Array.isArray(value)) {
                for (const item of value) {
                    formData.append(key, toFormValue(item));
                }
            }
            else {
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
            if (value === undefined)
                continue;
            if (Array.isArray(value)) {
                for (const item of value) {
                    params.append(key, String(item));
                }
            }
            else {
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
        delete headers["Content-Type"];
        return buildFormData(body);
    }
    if (requestMediaType.includes("application/x-www-form-urlencoded")) {
        headers["Content-Type"] = requestMediaType;
        return buildUrlEncodedBody(body);
    }
    headers["Content-Type"] = requestMediaType;
    if (requestMediaType.includes("application/json") || requestMediaType.includes("+json")) {
        return JSON.stringify(body);
    }
    return buildRawBody(body);
}
/**
 * @param {ParsedOperation} operation
 * @param {Record<string, unknown>} args
 * @param {string} baseUrl
 * @param {OpenApiToolsOptions} options
 * @returns {Promise<unknown>}
 */
export async function executeRequest(operation, args, baseUrl, options) {
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
    const url = buildUrl(baseUrl, operation.path, pathParams, queryParams, options);
    // Trust boundary: spread LLM-controlled header *parameters* FIRST, then the
    // operator-injected auth/headers, so an LLM-supplied header param (e.g. a
    // spec that declares an `Authorization` header parameter, or an apiKey
    // header name) can never override or strip the operator-injected secret.
    /** @type {Record<string, string>} */
    const headers = {
        ...headerParams,
        ...buildAuthHeaders(options),
    };
    /** @type {RequestInit} */
    const fetchInit = {
        method: operation.method.toUpperCase(),
        headers,
    };
    // Request body — read from the SAME non-colliding key the schema used, so a
    // parameter named `body` (or `requestBody`) cannot shadow the actual body.
    const requestBodyArgName = getRequestBodyArgName(operation.parameters);
    if (args[requestBodyArgName] !== undefined) {
        fetchInit.body = serializeRequestBody(args[requestBodyArgName], operation.requestBodyMediaType, headers);
        fetchInit.headers = headers;
    }
    const response = await fetch(url, fetchInit);
    const contentType = response.headers.get("content-type") ?? "";
    /** @type {unknown} */
    const payload = contentType.includes("application/json")
        ? await response.json()
        : await response.text();
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
 * @returns {Effect.Effect<unknown, unknown, never>}
 */
export function executeToolEffect(operation, args, baseUrl, options) {
    const started = nowMs();
    return Effect.gen(function* () {
        yield* Metric.increment(openApiToolCallsTotal);
        return yield* Effect.tryPromise({
            try: () => executeRequest(operation, args, baseUrl, options),
            catch: (err) => err,
        });
    }).pipe(
        Effect.ensuring(Effect.suspend(() => Metric.update(openApiToolDuration, nowMs() - started))),
        Effect.tapError(() => Metric.increment(openApiToolCallErrorsTotal)), Effect.annotateLogs({
        toolName: `openapi:${operation.operationId}`,
        method: operation.method,
        path: operation.path,
    }), Effect.withLogSpan(`openapi:${operation.operationId}`));
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
            execute: async (args) => {
                try {
                    return await Effect.runPromise(executeToolEffect(operation, /** @type {Record<string, unknown>} */ (args), baseUrl, options));
                }
                catch (error) {
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
 * @param {OpenApiSpec} spec
 * @param {OpenApiToolsOptions} options
 * @returns {string}
 */
export function resolveBaseUrl(spec, options) {
    if (options.baseUrl)
        return options.baseUrl;
    if (spec.servers && spec.servers.length > 0)
        return spec.servers[0].url;
    return "http://localhost";
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
