import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GATEWAY_RPC_DEFINITIONS,
  GATEWAY_RPC_ERRORS,
  SMITHERS_API_VERSION,
  type GatewayRpcDefinition,
  type JsonSchema,
} from "../src/rpc/index.ts";
import { GATEWAY_SCOPE_DESCRIPTIONS, GATEWAY_SCOPE_VALUES } from "../src/auth/scopes.ts";

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

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = resolve(packageDir, "openapi.yaml");

function rpcPath(definition: GatewayRpcDefinition): string {
  return `/v1/rpc/${definition.method}`;
}

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

function successSchema(definition: GatewayRpcDefinition) {
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

function requestFrameSchema(definition: GatewayRpcDefinition) {
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

function buildOpenApiDocument(): OpenApiDocument {
  const paths: Record<string, unknown> = {};
  for (const definition of GATEWAY_RPC_DEFINITIONS) {
    paths[rpcPath(definition)] = buildPath(definition);
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Smithers Gateway RPC API",
      version: SMITHERS_API_VERSION,
      description: "Stable v1 Smithers Gateway RPC contract generated from packages/gateway/src/rpc.",
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

export { buildOpenApiDocument, toYaml, scalarToYaml, rpcPath, buildPath, errorSchema, successSchema, requestFrameSchema };

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
