import { Effect } from 'effect';
import { z } from 'zod';
import { Tool } from 'ai';
export { openApiToolCallErrorsTotal, openApiToolCallsTotal, openApiToolDuration } from '@smithers-orchestrator/observability/metrics';

type HttpMethod = "get" | "post" | "put" | "delete" | "patch";

type RefObject$1 = {
    $ref: string;
};

type SchemaObject$1 = {
    type?: string;
    format?: string;
    description?: string;
    properties?: Record<string, SchemaObject$1 | RefObject$1>;
    required?: string[];
    items?: SchemaObject$1 | RefObject$1;
    enum?: unknown[];
    default?: unknown;
    nullable?: boolean;
    oneOf?: Array<SchemaObject$1 | RefObject$1>;
    anyOf?: Array<SchemaObject$1 | RefObject$1>;
    allOf?: Array<SchemaObject$1 | RefObject$1>;
    additionalProperties?: boolean | SchemaObject$1 | RefObject$1;
    minimum?: number;
    maximum?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    $ref?: string;
};

type ParameterObject$1 = {
    name: string;
    in: "query" | "header" | "path" | "cookie";
    description?: string;
    required?: boolean;
    schema?: SchemaObject$1 | RefObject$1;
    deprecated?: boolean;
};

type MediaTypeObject = {
    schema?: SchemaObject$1 | RefObject$1;
};

type RequestBodyObject$1 = {
    description?: string;
    required?: boolean;
    content: Record<string, MediaTypeObject>;
};

type ParsedOperation$2 = {
    operationId: string;
    method: HttpMethod;
    path: string;
    summary: string;
    description: string;
    parameters: ParameterObject$1[];
    requestBody?: RequestBodyObject$1;
    requestBodyMediaType?: string;
    deprecated: boolean;
};

type OpenApiAuth$1 = {
    type: "bearer";
    token: string;
} | {
    type: "basic";
    username: string;
    password: string;
} | {
    type: "apiKey";
    name: string;
    value: string;
    in: "header" | "query";
};

type OpenApiToolResponseExample = {
    status?: string | number;
    description?: string;
    value: unknown;
};
type OpenApiOperationCuration = false | {
    include?: boolean;
    name?: string;
    description?: string;
    responseExamples?: OpenApiToolResponseExample[];
};
type OpenApiToolsOptions$6 = {
    /**
     * Operator-pinned request base URL. Credentialed tools require this instead
     * of trusting a spec-controlled servers[].url.
     */
    baseUrl?: string;
    headers?: Record<string, string>;
    auth?: OpenApiAuth$1;
    /**
     * Additional origins authorized as redirect destinations. Credentialed
     * requests fail closed on every other cross-origin redirect.
     */
    allowedRedirectOrigins?: string[];
    /**
     * Compatibility alias for `allowedRedirectOrigins`. This is redirect-only
     * and never authorizes a spec-controlled initial server.
     */
    allowedOrigins?: string[];
    /**
     * Permit private/special destinations for remote spec loads, redirect hops,
     * and an unpinned credential-free spec server. Off by default; prefer an
     * exact baseUrl for API requests. This cannot replace baseUrl when auth or
     * headers are configured.
     */
    allowPrivateNetwork?: boolean;
    /**
     * Override Node/Bun DNS resolution used to reject spec/API hostnames whose
     * A/AAAA answers include non-global addresses. Resolution failures, empty
     * answers, and malformed or non-global answers are denied. Useful for
     * controlled runtimes and deterministic tests.
     */
    resolveHostname?: (hostname: string) => readonly string[] | Promise<readonly string[]>;
    /** Maximum number of redirect hops. Defaults to 5. */
    maxRedirects?: number;
    /** Maximum serialized request-body bytes. Defaults to 10 MiB; must be a non-negative safe integer. */
    maxRequestBytes?: number;
    /** Maximum decoded response bytes buffered by a generated tool. Defaults to 1 MiB; must be a non-negative safe integer. */
    maxResponseBytes?: number;
    /** Maximum bytes buffered while loading a remote OpenAPI spec. Defaults to 5 MiB; must be a non-negative safe integer. */
    maxSpecBytes?: number;
    /** Cancels remote spec loading. Per-tool execution uses the AI SDK abort signal. */
    signal?: AbortSignal;
    include?: string[];
    exclude?: string[];
    namePrefix?: string;
    operations?: Record<string, OpenApiOperationCuration>;
};

type OperationObject = {
    operationId?: string;
    summary?: string;
    description?: string;
    parameters?: Array<ParameterObject$1 | RefObject$1>;
    requestBody?: RequestBodyObject$1 | RefObject$1;
    responses?: Record<string, unknown>;
    tags?: string[];
    deprecated?: boolean;
};

type PathItem = {
    get?: OperationObject;
    post?: OperationObject;
    put?: OperationObject;
    delete?: OperationObject;
    patch?: OperationObject;
    parameters?: Array<ParameterObject$1 | RefObject$1>;
};

type OpenApiSpec$b = {
    openapi: string;
    info: {
        title: string;
        version: string;
        description?: string;
    };
    servers?: Array<{
        url: string;
        description?: string;
    }>;
    paths: Record<string, PathItem>;
    components?: {
        schemas?: Record<string, SchemaObject$1>;
        parameters?: Record<string, ParameterObject$1>;
        requestBodies?: Record<string, RequestBodyObject$1>;
    };
};

/** @typedef {import("./OpenApiSpec.ts").OpenApiSpec} OpenApiSpec */
/** @typedef {import("./ParsedOperation.ts").ParsedOperation} ParsedOperation */
/**
 * Extract all operations from an OpenAPI spec.
 *
 * @param {OpenApiSpec} spec
 * @returns {ParsedOperation[]}
 */
declare function extractOperations(spec: OpenApiSpec$a): ParsedOperation$1[];
type OpenApiSpec$a = OpenApiSpec$b;
type ParsedOperation$1 = ParsedOperation$2;

/**
 * Load an OpenAPI spec from a JSON/YAML string, URL, file path, or object.
 *
 * @param {string | OpenApiSpec} input
 * @param {Pick<OpenApiToolsOptions, "allowedOrigins" | "allowPrivateNetwork" | "maxRedirects" | "maxSpecBytes" | "resolveHostname" | "signal">} [options]
 * @returns {Effect.Effect<OpenApiSpec, unknown>}
 */
declare function loadSpecEffect(input: string | OpenApiSpec$9, options?: Pick<OpenApiToolsOptions$5, "allowedOrigins" | "allowPrivateNetwork" | "maxRedirects" | "maxSpecBytes" | "resolveHostname" | "signal">): Effect.Effect<OpenApiSpec$9, unknown>;
type OpenApiSpec$9 = OpenApiSpec$b;
type OpenApiToolsOptions$5 = OpenApiToolsOptions$6;

/** @typedef {import("./OpenApiSpec.ts").OpenApiSpec} OpenApiSpec */
/**
 * Synchronous version for simpler call sites.
 *
 * @param {string | OpenApiSpec} input
 * @returns {OpenApiSpec}
 */
declare function loadSpecSync(input: string | OpenApiSpec$8): OpenApiSpec$8;
type OpenApiSpec$8 = OpenApiSpec$b;

/** @typedef {import("./OpenApiSpec.ts").OpenApiSpec} OpenApiSpec */
/** @typedef {import("./RefObject.ts").RefObject} RefObject */
/** @typedef {import("./SchemaObject.ts").SchemaObject} SchemaObject */
/**
 * Convert an OpenAPI JSON Schema object to a Zod schema.
 * Falls back to z.any() for schemas that cannot be cleanly represented.
 *
 * @param {SchemaObject | RefObject | undefined} schema
 * @param {OpenApiSpec} spec
 * @param {Set<string>} [visited]
 * @param {number} [depth]
 * @returns {z.ZodType}
 */
declare function jsonSchemaToZod(schema: SchemaObject | RefObject | undefined, spec: OpenApiSpec$7, visited?: Set<string>, depth?: number): z.ZodType;
type OpenApiSpec$7 = OpenApiSpec$b;
type RefObject = RefObject$1;
type SchemaObject = SchemaObject$1;

/**
 * Build a single Zod object schema for an operation's input, combining:
 * - path parameters
 * - query parameters
 * - header parameters
 * - request body fields
 *
 * @param {ParameterObject[]} parameters
 * @param {RequestBodyObject | undefined} requestBody
 * @param {OpenApiSpec} spec
 * @returns {z.ZodType}
 */
declare function buildOperationSchema(parameters: ParameterObject[], requestBody: RequestBodyObject | undefined, spec: OpenApiSpec$6): z.ZodType;
type OpenApiSpec$6 = OpenApiSpec$b;
type ParameterObject = ParameterObject$1;
type RequestBodyObject = RequestBodyObject$1;

/** @typedef {import("../OpenApiSpec.ts").OpenApiSpec} OpenApiSpec */
/** @typedef {import("../OpenApiToolsOptions.ts").OpenApiToolsOptions} OpenApiToolsOptions */
/**
 * Create AI SDK tools from all operations in an OpenAPI spec.
 *
 * @param {string | OpenApiSpec} input - OpenAPI spec as JSON object, file path, URL, or raw text
 * @param {OpenApiToolsOptions} [options] - Configuration for auth, filtering, base URL, etc.
 * @returns {Promise<Record<string, any>>} Record of operationId → AI SDK tool
 */
declare function createOpenApiTools(input: string | OpenApiSpec$5, options?: OpenApiToolsOptions$4): Promise<Record<string, any>>;
type OpenApiSpec$5 = OpenApiSpec$b;
type OpenApiToolsOptions$4 = OpenApiToolsOptions$6;

/** @typedef {import("../OpenApiSpec.ts").OpenApiSpec} OpenApiSpec */
/** @typedef {import("../OpenApiToolsOptions.ts").OpenApiToolsOptions} OpenApiToolsOptions */
/**
 * Synchronous version — only works with specs that are objects or local files.
 *
 * @param {string | OpenApiSpec} input
 * @param {OpenApiToolsOptions} [options]
 * @returns {Record<string, any>}
 */
declare function createOpenApiToolsSync(input: string | OpenApiSpec$4, options?: OpenApiToolsOptions$3): Record<string, any>;
type OpenApiSpec$4 = OpenApiSpec$b;
type OpenApiToolsOptions$3 = OpenApiToolsOptions$6;

/** @typedef {import("../OpenApiSpec.ts").OpenApiSpec} OpenApiSpec */
/** @typedef {import("../OpenApiToolsOptions.ts").OpenApiToolsOptions} OpenApiToolsOptions */
/**
 * Create a single AI SDK tool from an OpenAPI spec by operationId.
 *
 * @param {string | OpenApiSpec} input - OpenAPI spec as JSON object, file path, URL, or raw text
 * @param {string} operationId - The operationId of the operation to create a tool for
 * @param {OpenApiToolsOptions} [options] - Configuration for auth, base URL, etc.
 * @returns {Promise<any>} A single AI SDK tool
 */
declare function createOpenApiTool(input: string | OpenApiSpec$3, operationId: string, options?: OpenApiToolsOptions$2): Promise<any>;
type OpenApiSpec$3 = OpenApiSpec$b;
type OpenApiToolsOptions$2 = OpenApiToolsOptions$6;

/**
 * Type alias for an AI SDK tool produced from an OpenAPI operation.
 * Re-exported here so JSDoc files can reference a stable name without
 * reaching into the `ai` package directly.
 */
type OpenApiTool$1 = Tool;

/** @typedef {import("../OpenApiSpec.ts").OpenApiSpec} OpenApiSpec */
/** @typedef {import("../OpenApiTool.ts").OpenApiTool} OpenApiTool */
/** @typedef {import("../OpenApiToolsOptions.ts").OpenApiToolsOptions} OpenApiToolsOptions */
/**
 * Synchronous version — only works with specs that are objects or local files.
 *
 * @param {string | OpenApiSpec} input
 * @param {string} operationId
 * @param {OpenApiToolsOptions} [options]
 * @returns {OpenApiTool}
 */
declare function createOpenApiToolSync(input: string | OpenApiSpec$2, operationId: string, options?: OpenApiToolsOptions$1): OpenApiTool;
type OpenApiSpec$2 = OpenApiSpec$b;
type OpenApiTool = OpenApiTool$1;
type OpenApiToolsOptions$1 = OpenApiToolsOptions$6;

/** @typedef {import("../OpenApiSpec.ts").OpenApiSpec} OpenApiSpec */
/**
 * List all operations from a spec (for CLI preview).
 *
 * @param {string | OpenApiSpec} input
 * @returns {Array<{ operationId: string; method: string; path: string; summary: string }>}
 */
declare function listOperations(input: string | OpenApiSpec$1): Array<{
    operationId: string;
    method: string;
    path: string;
    summary: string;
}>;
type OpenApiSpec$1 = OpenApiSpec$b;

type OpenApiAuth = OpenApiAuth$1;
type OpenApiSpec = OpenApiSpec$b;
type OpenApiToolsOptions = OpenApiToolsOptions$6;
type ParsedOperation = ParsedOperation$2;

export { type OpenApiAuth, type OpenApiSpec, type OpenApiToolsOptions, type ParsedOperation, buildOperationSchema, createOpenApiTool, createOpenApiToolSync, createOpenApiTools, createOpenApiToolsSync, extractOperations, jsonSchemaToZod, listOperations, loadSpecEffect, loadSpecSync };
