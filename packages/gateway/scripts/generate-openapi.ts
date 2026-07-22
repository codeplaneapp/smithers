import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GATEWAY_RPC_DEFINITIONS,
  GATEWAY_RPC_ERRORS,
  SMITHERS_API_VERSION,
  getGatewayRpcDefinition,
  getRequiredScopeForGatewayMethod,
  type GatewayRpcDefinition,
  type GatewayRpcMethod,
  type JsonSchema,
} from "../src/rpc/index.js";
import { GATEWAY_SCOPE_DESCRIPTIONS, GATEWAY_SCOPE_VALUES } from "../src/auth/scopes.js";
import type { GatewayScope } from "../src/auth/scopes.js";

type OpenApiDocument = {
  openapi: string;
  info: {
    title: string;
    version: string;
    description: string;
  };
  servers: Array<{ url: string; description: string }>;
  security: Array<{ bearerAuth: string[] }>;
  paths: Record<string, unknown>;
  components: {
    securitySchemes: Record<string, unknown>;
    schemas: Record<string, unknown>;
  };
};

type GatewayApiRouteDefinition = {
  method: "get" | "post";
  path: string;
  operationId: string;
  summary: string;
  rpcMethod?: string;
  requiredScope: GatewayScope;
  requestSchema?: JsonSchema;
  responseSchema?: JsonSchema;
  parameters?: readonly GatewayApiParameterDefinition[];
  mutation?: boolean;
  sse?: boolean;
};

type GatewayApiParameterDefinition = {
  name: string;
  in: "path" | "query";
  description: string;
  required?: boolean;
  schema: JsonSchema;
  style?: "form" | "simple";
  explode?: boolean;
};

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = resolve(packageDir, "openapi.yaml");

function rpcPath(definition: GatewayRpcDefinition): string {
  return `/v1/rpc/${definition.method}`;
}

function scopeForRpc(method: string): GatewayScope {
  return getRequiredScopeForGatewayMethod(method) ?? "run:read";
}

function requireRpcDefinition(method: GatewayRpcMethod): GatewayRpcDefinition {
  const definition = getGatewayRpcDefinition(method);
  if (!definition) throw new Error(`Missing Gateway RPC definition: ${method}`);
  return definition;
}

function requireRequestProperty(definition: GatewayRpcDefinition, property: string): JsonSchema {
  const schema = definition.requestSchema.properties?.[property];
  if (!schema) throw new Error(`Missing ${definition.method} request property: ${property}`);
  return schema;
}

const objectSchema = {
  type: "object",
  additionalProperties: true,
} satisfies JsonSchema;

const listScoresForRunsRpc = requireRpcDefinition("listScoresForRuns");
const getScoreDetailRpc = requireRpcDefinition("getScoreDetail");
const listUsageReportsRpc = requireRpcDefinition("listUsageReports");
const listRunTokenUsageRpc = requireRpcDefinition("listRunTokenUsage");

const gatewayApiRoutes: readonly GatewayApiRouteDefinition[] = [
  { method: "get", path: "/v1/api/runs", operationId: "apiListRuns", summary: "List runs.", rpcMethod: "listRuns", requiredScope: scopeForRpc("listRuns"), responseSchema: { type: "array", items: objectSchema } },
  { method: "post", path: "/v1/api/runs", operationId: "apiLaunchRun", summary: "Launch a run.", rpcMethod: "launchRun", requiredScope: scopeForRpc("launchRun"), requestSchema: objectSchema, responseSchema: objectSchema, mutation: true },
  { method: "get", path: "/v1/api/runs/{runId}", operationId: "apiGetRun", summary: "Read one run.", rpcMethod: "getRun", requiredScope: scopeForRpc("getRun"), responseSchema: objectSchema },
  {
    method: "get",
    path: "/v1/api/runs/{runId}/token-usage",
    operationId: "apiListRunTokenUsage",
    summary: "List all persisted token usage for a run.",
    rpcMethod: "listRunTokenUsage",
    requiredScope: scopeForRpc("listRunTokenUsage"),
    responseSchema: listRunTokenUsageRpc.responseSchema,
    parameters: [
      { name: "runId", in: "path", description: "Owning run id.", required: true, schema: requireRequestProperty(listRunTokenUsageRpc, "runId") },
    ],
  },
  { method: "post", path: "/v1/api/runs/{runId}/cancel", operationId: "apiCancelRun", summary: "Cancel a run.", rpcMethod: "cancelRun", requiredScope: scopeForRpc("cancelRun"), requestSchema: objectSchema, responseSchema: objectSchema, mutation: true },
  { method: "post", path: "/v1/api/runs/{runId}/resume", operationId: "apiResumeRun", summary: "Resume a run.", rpcMethod: "resumeRun", requiredScope: scopeForRpc("resumeRun"), requestSchema: objectSchema, responseSchema: objectSchema, mutation: true },
  { method: "post", path: "/v1/api/runs/{runId}/rewind", operationId: "apiRewindRun", summary: "Rewind a run.", rpcMethod: "rewindRun", requiredScope: scopeForRpc("rewindRun"), requestSchema: objectSchema, responseSchema: objectSchema, mutation: true },
  { method: "get", path: "/v1/api/runs/{runId}/tree", operationId: "apiGetRunTree", summary: "Read a DevTools tree snapshot.", rpcMethod: "getDevToolsSnapshot", requiredScope: scopeForRpc("getDevToolsSnapshot"), responseSchema: objectSchema },
  { method: "get", path: "/v1/api/runs/{runId}/devtools", operationId: "apiGetRunDevtools", summary: "Read a DevTools snapshot.", rpcMethod: "getDevToolsSnapshot", requiredScope: scopeForRpc("getDevToolsSnapshot"), responseSchema: objectSchema },
  { method: "get", path: "/v1/api/runs/{runId}/events", operationId: "apiListRunEvents", summary: "List persisted run events.", rpcMethod: "streamRunEvents", requiredScope: scopeForRpc("streamRunEvents"), responseSchema: { type: "array", items: objectSchema } },
  { method: "get", path: "/v1/api/events", operationId: "apiListEvents", summary: "List persisted run events.", rpcMethod: "streamRunEvents", requiredScope: scopeForRpc("streamRunEvents"), responseSchema: { type: "array", items: objectSchema } },
  { method: "get", path: "/v1/api/approvals", operationId: "apiListApprovals", summary: "List approvals.", rpcMethod: "listApprovals", requiredScope: scopeForRpc("listApprovals"), responseSchema: { type: "array", items: objectSchema } },
  { method: "post", path: "/v1/api/approvals/{approvalId}", operationId: "apiSubmitApproval", summary: "Submit an approval decision.", rpcMethod: "submitApproval", requiredScope: scopeForRpc("submitApproval"), requestSchema: objectSchema, responseSchema: objectSchema, mutation: true },
  { method: "post", path: "/v1/api/signals", operationId: "apiSubmitSignal", summary: "Submit a workflow signal.", rpcMethod: "submitSignal", requiredScope: scopeForRpc("submitSignal"), requestSchema: objectSchema, responseSchema: objectSchema, mutation: true },
  { method: "get", path: "/v1/api/workflows", operationId: "apiListWorkflows", summary: "List workflows.", rpcMethod: "listWorkflows", requiredScope: scopeForRpc("listWorkflows"), responseSchema: { type: "array", items: objectSchema } },
  { method: "get", path: "/v1/api/docs", operationId: "apiListDocs", summary: "List docs.", rpcMethod: "listDocs", requiredScope: scopeForRpc("listDocs"), responseSchema: { type: "array", items: objectSchema } },
  { method: "get", path: "/v1/api/prompts", operationId: "apiListPrompts", summary: "List prompts.", rpcMethod: "listPrompts", requiredScope: scopeForRpc("listPrompts"), responseSchema: { type: "array", items: objectSchema } },
  { method: "get", path: "/v1/api/scores", operationId: "apiListScores", summary: "List scores for a run.", rpcMethod: "listScores", requiredScope: scopeForRpc("listScores"), responseSchema: { type: "array", items: objectSchema } },
  {
    method: "get",
    path: "/v1/api/scores/compare",
    operationId: "apiListScoresForRuns",
    summary: "List scores across runs.",
    rpcMethod: "listScoresForRuns",
    requiredScope: scopeForRpc("listScoresForRuns"),
    responseSchema: listScoresForRunsRpc.responseSchema,
    parameters: [
      {
        name: "runId",
        in: "query",
        description: "Run id entry. Repeat this query parameter for each run to compare.",
        required: false,
        schema: requireRequestProperty(listScoresForRunsRpc, "runIds"),
        style: "form",
        explode: true,
      },
      { name: "nodeId", in: "query", description: "Optional exact, case-sensitive node id filter.", schema: requireRequestProperty(listScoresForRunsRpc, "nodeId") },
      { name: "scorerId", in: "query", description: "Optional exact, case-sensitive scorer id filter.", schema: requireRequestProperty(listScoresForRunsRpc, "scorerId") },
      { name: "scorerName", in: "query", description: "Optional exact, case-sensitive scorer name filter.", schema: requireRequestProperty(listScoresForRunsRpc, "scorerName") },
      { name: "source", in: "query", description: "Optional score provenance filter.", schema: requireRequestProperty(listScoresForRunsRpc, "source") },
      { name: "order", in: "query", description: "Primary score timestamp order.", schema: requireRequestProperty(listScoresForRunsRpc, "order") },
      { name: "offset", in: "query", description: "Global result offset.", schema: requireRequestProperty(listScoresForRunsRpc, "offset") },
      { name: "limit", in: "query", description: "Maximum globally merged rows to return.", schema: requireRequestProperty(listScoresForRunsRpc, "limit") },
    ],
  },
  {
    method: "get",
    path: "/v1/api/scores/{runId}/{scoreId}",
    operationId: "apiGetScoreDetail",
    summary: "Read one score with decoded detail.",
    rpcMethod: "getScoreDetail",
    requiredScope: scopeForRpc("getScoreDetail"),
    responseSchema: getScoreDetailRpc.responseSchema,
    parameters: [
      { name: "runId", in: "path", description: "Owning run id.", required: true, schema: requireRequestProperty(getScoreDetailRpc, "runId") },
      { name: "scoreId", in: "path", description: "Exact persisted score id.", required: true, schema: requireRequestProperty(getScoreDetailRpc, "scoreId") },
    ],
  },
  { method: "get", path: "/v1/api/tickets", operationId: "apiListTickets", summary: "List work docs.", rpcMethod: "listTickets", requiredScope: scopeForRpc("listTickets"), responseSchema: { type: "array", items: objectSchema } },
  { method: "get", path: "/v1/api/memory-facts", operationId: "apiListMemoryFacts", summary: "List memory facts.", rpcMethod: "listMemoryFacts", requiredScope: scopeForRpc("listMemoryFacts"), responseSchema: { type: "array", items: objectSchema } },
  { method: "get", path: "/v1/api/crons", operationId: "apiCronList", summary: "List cron schedules.", rpcMethod: "cronList", requiredScope: scopeForRpc("cronList"), responseSchema: { type: "array", items: objectSchema } },
  { method: "get", path: "/v1/api/accounts", operationId: "apiListAccounts", summary: "List registered accounts.", rpcMethod: "listAccounts", requiredScope: scopeForRpc("listAccounts"), responseSchema: { type: "array", items: objectSchema } },
  {
    method: "get",
    path: "/v1/api/usage",
    operationId: "apiListUsageReports",
    summary: "List provider usage reports.",
    rpcMethod: "listUsageReports",
    requiredScope: scopeForRpc("listUsageReports"),
    responseSchema: listUsageReportsRpc.responseSchema,
    parameters: [
      { name: "fresh", in: "query", description: "Bypass the Gateway's 60-second in-memory cache.", schema: requireRequestProperty(listUsageReportsRpc, "fresh") },
    ],
  },
  { method: "get", path: "/v1/api/nodes/{runId}/{nodeId}/output", operationId: "apiGetNodeOutput", summary: "Read node output.", rpcMethod: "getNodeOutput", requiredScope: scopeForRpc("getNodeOutput"), responseSchema: objectSchema },
  { method: "get", path: "/v1/api/nodes/{runId}/{nodeId}/diff", operationId: "apiGetNodeDiff", summary: "Read node diff.", rpcMethod: "getNodeDiff", requiredScope: scopeForRpc("getNodeDiff"), responseSchema: objectSchema },
  { method: "get", path: "/v1/api/runs/{runId}/nodes/{nodeId}/output", operationId: "apiGetRunNodeOutput", summary: "Read node output.", rpcMethod: "getNodeOutput", requiredScope: scopeForRpc("getNodeOutput"), responseSchema: objectSchema },
  { method: "get", path: "/v1/api/runs/{runId}/nodes/{nodeId}/diff", operationId: "apiGetRunNodeDiff", summary: "Read node diff.", rpcMethod: "getNodeDiff", requiredScope: scopeForRpc("getNodeDiff"), responseSchema: objectSchema },
  { method: "get", path: "/v1/api/schema-signature", operationId: "apiGetSchemaSignature", summary: "Read the schema signature.", rpcMethod: "getSchemaSignature", requiredScope: scopeForRpc("getSchemaSignature"), responseSchema: objectSchema },
  { method: "get", path: "/v1/api/stream", operationId: "apiStreamInvalidations", summary: "Subscribe to collection invalidations.", requiredScope: scopeForRpc("listRuns"), sse: true },
];

function errorSchema(definition: GatewayRpcDefinition) {
  return {
    type: "object",
    required: ["type", "id", "ok", "apiVersion", "error"],
    additionalProperties: false,
    properties: {
      type: { const: "res" },
      id: { type: "string" },
      ok: { const: false },
      apiVersion: { const: SMITHERS_API_VERSION },
      error: {
        type: "object",
        required: ["version", "code", "message"],
        additionalProperties: true,
        properties: {
          version: { const: SMITHERS_API_VERSION },
          code: { type: "string", enum: definition.errors },
          message: { type: "string" },
          requiredScope: { type: "string", enum: GATEWAY_SCOPE_VALUES },
          refresh: { type: "string" },
        },
      },
    },
  };
}

/**
 * Named return type for the exported frame-schema builders. Without it, tsc
 * infers a structural type that references the rpc index bundle's internal
 * `JsonSchema$1` alias, which cannot be named in this file's declaration
 * output (TS4058).
 */
type RpcFrameSchema = {
  type: "object";
  required: readonly string[];
  additionalProperties: false;
  properties: Record<string, JsonSchema>;
};

function successSchema(definition: GatewayRpcDefinition): RpcFrameSchema {
  return {
    type: "object",
    required: ["type", "id", "ok", "apiVersion", "payload"],
    additionalProperties: false,
    properties: {
      type: { const: "res" },
      id: { type: "string" },
      ok: { const: true },
      apiVersion: { const: SMITHERS_API_VERSION },
      payload: definition.responseSchema,
    },
  };
}

function requestFrameSchema(definition: GatewayRpcDefinition): RpcFrameSchema {
  return {
    type: "object",
    required: ["method", "params"],
    additionalProperties: false,
    properties: {
      id: { type: "string", description: "Optional caller request id." },
      method: { const: definition.method },
      params: definition.requestSchema,
    },
  };
}

function buildPath(definition: GatewayRpcDefinition) {
  const errorResponses: Record<string, unknown> = {};
  for (const code of definition.errors) {
    const error = GATEWAY_RPC_ERRORS[code];
    errorResponses[String(error.httpStatus)] = {
      description: error.description,
      content: {
        "application/json": {
          schema: errorSchema(definition),
        },
      },
    };
  }
  return {
    post: {
      operationId: definition.method,
      summary: definition.title,
      description: definition.description,
      tags: ["Gateway RPC"],
      security: [{ bearerAuth: [definition.requiredScope] }],
      "x-smithers-api-version": definition.version,
      "x-smithers-maturity": definition.maturity,
      "x-smithers-transport": definition.transport,
      "x-smithers-required-scope": definition.requiredScope,
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: requestFrameSchema(definition),
            example: {
              id: `${definition.method}-1`,
              method: definition.method,
              params: definition.exampleRequest,
            },
          },
        },
      },
      responses: {
        "200": {
          description: `${definition.title} response.`,
          headers: {
            "X-Smithers-API-Version": {
              schema: { type: "string", enum: [SMITHERS_API_VERSION] },
              description: "Stable Smithers Gateway API version.",
            },
          },
          content: {
            "application/json": {
              schema: successSchema(definition),
              example: {
                type: "res",
                id: `${definition.method}-1`,
                ok: true,
                apiVersion: SMITHERS_API_VERSION,
                payload: definition.exampleResponse,
              },
            },
          },
        },
        ...errorResponses,
      },
    },
  };
}

function apiResponseSchema(definition: GatewayApiRouteDefinition) {
  if (definition.sse) {
    return { type: "string", description: "Server-sent event stream." };
  }
  return {
    type: "object",
    required: ["ok", "data"],
    additionalProperties: false,
    properties: {
      ok: { const: true },
      data: definition.responseSchema ?? objectSchema,
      txid: { type: "string", pattern: "^\\d+$" },
      seq: { type: "integer", minimum: 0 },
    },
  };
}

function apiErrorSchema() {
  return {
    type: "object",
    required: ["ok", "error"],
    additionalProperties: false,
    properties: {
      ok: { const: false },
      error: {
        type: "object",
        required: ["code", "message"],
        additionalProperties: true,
        properties: {
          code: { type: "string" },
          message: { type: "string" },
          requiredScope: { type: "string", enum: GATEWAY_SCOPE_VALUES },
        },
      },
    },
  };
}

function buildApiPath(definition: GatewayApiRouteDefinition) {
  const contentType = definition.sse ? "text/event-stream" : "application/json";
  const operation: Record<string, unknown> = {
    operationId: definition.operationId,
    summary: definition.summary,
    description: definition.rpcMethod
      ? `REST domain API wrapper over the ${definition.rpcMethod} Gateway RPC internals.`
      : "Server-sent event invalidation stream for REST collection clients.",
    tags: definition.sse ? ["Gateway REST stream"] : ["Gateway REST"],
    security: [{ bearerAuth: [definition.requiredScope] }],
    "x-smithers-api-version": SMITHERS_API_VERSION,
    "x-smithers-required-scope": definition.requiredScope,
    ...(definition.rpcMethod ? { "x-smithers-rpc-method": definition.rpcMethod } : {}),
    ...(definition.parameters?.length
      ? {
          parameters: definition.parameters.map((parameter) => ({
            name: parameter.name,
            in: parameter.in,
            description: parameter.description,
            required: parameter.required ?? parameter.in === "path",
            schema: parameter.schema,
            ...(parameter.style ? { style: parameter.style } : {}),
            ...(parameter.explode !== undefined ? { explode: parameter.explode } : {}),
          })),
        }
      : {}),
    responses: {
      "200": {
        description: definition.sse ? "Invalidation event stream." : "Gateway REST response.",
        headers: {
          "X-Smithers-API-Version": {
            schema: { type: "string", enum: [SMITHERS_API_VERSION] },
            description: "Stable Smithers Gateway API version.",
          },
        },
        content: {
          [contentType]: {
            schema: apiResponseSchema(definition),
          },
        },
      },
      "400": {
        description: "Invalid request.",
        content: { "application/json": { schema: apiErrorSchema() } },
      },
      "401": {
        description: "Authentication failed.",
        content: { "application/json": { schema: apiErrorSchema() } },
      },
      "403": {
        description: "Missing required scope.",
        content: { "application/json": { schema: apiErrorSchema() } },
      },
      "404": {
        description: "Route or resource not found.",
        content: { "application/json": { schema: apiErrorSchema() } },
      },
      "500": {
        description: "Internal server error.",
        content: { "application/json": { schema: apiErrorSchema() } },
      },
    },
  };
  if (definition.requestSchema && definition.method !== "get") {
    operation.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: definition.requestSchema,
        },
      },
    };
  }
  return { [definition.method]: operation };
}

function buildOpenApiDocument(): OpenApiDocument {
  const paths: Record<string, unknown> = {};
  for (const definition of GATEWAY_RPC_DEFINITIONS) {
    paths[rpcPath(definition)] = buildPath(definition);
  }
  for (const definition of gatewayApiRoutes) {
    paths[definition.path] = buildApiPath(definition);
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Smithers Gateway API",
      version: SMITHERS_API_VERSION,
      description: "Stable v1 Smithers Gateway RPC and REST domain API contract generated from packages/gateway.",
    },
    servers: [
      {
        url: "https://gateway.example.com",
        description: "Reference Gateway deployment.",
      },
    ],
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "short-lived Smithers token",
          description: "Short-lived bearer token issued by smithers token issue.",
        },
      },
      schemas: {
        GatewayScope: {
          type: "string",
          enum: GATEWAY_SCOPE_VALUES,
          description: Object.entries(GATEWAY_SCOPE_DESCRIPTIONS)
            .map(([scope, description]) => `${scope}: ${description}`)
            .join("\n"),
        },
        GatewayRpcErrorCode: {
          type: "string",
          enum: Object.keys(GATEWAY_RPC_ERRORS),
        },
        JsonValue: {
          description: "Any JSON value.",
        },
      },
    },
  };
}

function scalarToYaml(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") {
    if (/^[A-Za-z0-9_./:-]+$/.test(value) && value !== "true" && value !== "false" && value !== "null") {
      return value;
    }
    return JSON.stringify(value);
  }
  return JSON.stringify(value);
}

function toYaml(value: unknown, indent = 0): string {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((entry) => {
        if (entry && typeof entry === "object") {
          const rendered = toYaml(entry, indent + 2);
          if (rendered === "{}" || rendered === "[]") {
            return `${pad}- ${rendered}`;
          }
          return `${pad}-\n${rendered}`;
        }
        return `${pad}- ${scalarToYaml(entry)}`;
      })
      .join("\n");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return entries
      .map(([key, entry]) => {
        const safeKey = /^[A-Za-z0-9_.:/{}-]+$/.test(key) ? key : JSON.stringify(key);
        if (entry && typeof entry === "object") {
          const rendered = toYaml(entry, indent + 2);
          if (rendered === "{}" || rendered === "[]") {
            return `${pad}${safeKey}: ${rendered}`;
          }
          return `${pad}${safeKey}:\n${rendered}`;
        }
        return `${pad}${safeKey}: ${scalarToYaml(entry)}`;
      })
      .join("\n");
  }
  return `${pad}${scalarToYaml(value)}`;
}

export { buildOpenApiDocument, toYaml, scalarToYaml, rpcPath, buildPath, buildApiPath, errorSchema, successSchema, requestFrameSchema };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rendered = `${toYaml(buildOpenApiDocument())}\n`;

  if (process.argv.includes("--check")) {
    const current = readFileSync(outPath, "utf8");
    if (current !== rendered) {
      console.error("packages/gateway/openapi.yaml is out of date. Run `pnpm --filter @smithers-orchestrator/gateway generate:openapi`.");
      process.exit(1);
    }
    process.exit(0);
  }

  writeFileSync(outPath, rendered);
}
